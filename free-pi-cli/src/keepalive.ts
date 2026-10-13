// "Keep it running": if the session is idle, tell it to continue.
//
// Free-pi's whole point here is unattended work — a bug-bounty hunt, a long
// refactor, a research sweep — and an agent that stops after one turn leaves
// that work undone until a human notices. This extension watches the session
// and, when it has been quiet for a while, sends it one short message: continue.
//
// Two things keep that from being a runaway:
//
//   * the check only fires when the session is genuinely idle (nothing
//     streaming, no queued message) and has been quiet for `idleMs`, so it never
//     steers a running turn or stacks nudges — except after a turn that ended on
//     a tool call printed as text, which is not work in progress but work the
//     session cannot continue on its own, and is nudged at the next check;
//   * `/keepalive off` (or FREEPI_KEEPALIVE=0) stops it — and the timer is
//     unref'd, so it can never be the reason a process stays alive.
//
// While a rotation is preparing its handoff the nudges are suppressed, so the
// summary turn is not interrupted by a "continue" from the companion extension.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { runtimeFlags } from "./runtime-flags";
import { looksLikeToolMarkup } from "./text-tool-parser";

export const KEEPALIVE_EXTENSION_NAME = "free-pi-keepalive";
export const KEEPALIVE_STATUS_KEY = "free-pi-keepalive";

/** Kept deliberately plain: it is the model's next instruction, not a report. */
export const KEEPALIVE_NUDGE =
  "Continue with the task: take the next useful step and keep working. Do not wait for input. " +
  "If you have finished one thing, start the next. If there is genuinely nothing left to do, say so in one line.";

export const DEFAULT_CHECK_MS = 30_000;
export const DEFAULT_IDLE_MS = 60_000;

export interface KeepaliveOptions {
  env?: NodeJS.ProcessEnv;
  /** How often the session is checked. */
  checkMs?: number;
  /** How long the session must be quiet before a nudge. */
  idleMs?: number;
  /** Test seams. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off", "disable", "disabled"].includes(raw.trim().toLowerCase());
}

function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Is the session running? The runtime's own answer (`ctx.isIdle()`) when the
 * context provides one, and our event bookkeeping otherwise, so the check does
 * not depend on the runtime version.
 */
function isBusy(ctx: ExtensionContext | undefined, bookkeeping: () => boolean): boolean {
  try {
    const idle = ctx?.isIdle?.();
    if (typeof idle === "boolean") return !idle;
  } catch {
    // an older runtime: fall back to the events
  }
  return bookkeeping();
}

export function createKeepaliveExtension(opts: KeepaliveOptions = {}): InlineExtension {
  const env = opts.env ?? process.env;
  const checkMs = opts.checkMs ?? positiveMs(env.FREEPI_KEEPALIVE_CHECK_MS, DEFAULT_CHECK_MS);
  const idleMs = opts.idleMs ?? positiveMs(env.FREEPI_KEEPALIVE_IDLE_MS, DEFAULT_IDLE_MS);
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  return {
    name: KEEPALIVE_EXTENSION_NAME,
    factory(pi: ExtensionAPI) {
      let enabled = flag(env.FREEPI_KEEPALIVE, true);
      let turnRunning = false;
      let lastActivity = now();
      let nudges = 0;
      let timer: unknown;
      let ctx: ExtensionContext | undefined;

      const touch = (): void => {
        lastActivity = now();
      };

      const status = (): string =>
        enabled
          ? `keepalive ON — checks every ${Math.round(checkMs / 1000)}s, nudges after ${Math.round(idleMs / 1000)}s idle (${nudges} nudge(s) this session)`
          : "keepalive OFF — the session will wait for you";

      const nudge = (): void => {
        nudges += 1;
        touch();
        pi.sendUserMessage(KEEPALIVE_NUDGE, { deliverAs: "followUp" });
        ctx?.ui?.setStatus?.(KEEPALIVE_STATUS_KEY, status());
      };

      const tick = (): void => {
        if (!enabled) return;
        if (isBusy(ctx, () => turnRunning)) return;
        // A rotation is waiting for its handoff document: the session is quiet
        // on purpose, and the companion extension owns what happens next.
        if (runtimeFlags.rotationPending) {
          touch();
          return;
        }
        if (now() - lastActivity < idleMs) return;
        nudge();
      };

      const start = (): void => {
        if (timer !== undefined) return;
        timer = setTimer(tick, checkMs);
        (timer as { unref?: () => void })?.unref?.();
      };

      const stop = (): void => {
        if (timer === undefined) return;
        clearTimer(timer);
        timer = undefined;
      };

      pi.on("session_start", async (_event, sessionCtx) => {
        ctx = sessionCtx;
        turnRunning = false;
        touch();
        sessionCtx.ui?.setStatus?.(KEEPALIVE_STATUS_KEY, status());
        if (enabled) start();
      });

      pi.on("turn_start", () => {
        turnRunning = true;
        touch();
      });
      pi.on("agent_start", () => {
        turnRunning = true;
        touch();
      });
      pi.on("turn_end", () => {
        turnRunning = false;
        touch();
      });
      pi.on("agent_settled", () => {
        turnRunning = false;
        touch();
      });
      pi.on("message_end", touch);

      // The backup for a turn that ended on tool-call markup printed as text
      // (DeepSeek's DSML wrapper and friends). Such a turn did not do the work
      // the model meant to do and nothing follows it — the session is exactly
      // as idle as it looks, so bring the idle clock forward and let the next
      // check say "continue" instead of waiting out the whole window. pi-launch
      // also asks the model to re-issue the call properly; that ask is bounded,
      // this one is not, because a session that has genuinely stopped is the one
      // thing an unattended run cannot recover from.
      pi.on("agent_end", (event) => {
        const last = event.messages[event.messages.length - 1];
        if (!last || last.role !== "assistant") return;
        const text = Array.isArray(last.content)
          ? last.content
              .filter((block) => block.type === "text" && typeof (block as { text?: unknown }).text === "string")
              .map((block) => (block as { text: string }).text)
              .join("\n")
          : "";
        if (looksLikeToolMarkup(text)) lastActivity = 0;
      });

      pi.on("session_shutdown", () => {
        stop();
        ctx = undefined;
      });

      pi.registerCommand("keepalive", {
        description:
          "Keep this session running: status | on | off | now. When idle it sends the agent a short \"continue\" message every minute.",
        handler: async (args: string, cmdCtx: ExtensionCommandContext) => {
          const sub = (args ?? "").trim().toLowerCase();
          switch (sub) {
            case "on":
              enabled = true;
              touch();
              start();
              cmdCtx.ui.notify(status(), "info");
              return;
            case "off":
              enabled = false;
              stop();
              cmdCtx.ui.notify(status(), "info");
              return;
            case "now":
              cmdCtx.ui.notify(`Nudging the agent to continue (${nudges + 1} this session).`, "info");
              nudge();
              return;
            case "status":
            default:
              cmdCtx.ui.notify(
                `${status()}\nThe session runs on until you stop it; every 3 hours the rotation writes a handoff summary and continues in a new session (/rotate for that).`,
                "info",
              );
          }
        },
      });
    },
  };
}
