// The 3-hour shift: write the handoff summary, then continue in a new session.
//
// A long unattended run eventually fills its context, and a session that is
// compacted to death is worse than a fresh one. Every `rotateMs` (3 hours by
// default) this extension:
//
//   1. asks the agent to write a complete handoff document to a known path;
//   2. when that turn finishes, records the handoff (summary path, provider,
//      model, working directory, session) beside the summary;
//   3. starts a NEW session in the same process — `ctx.newSession()` from the
//      SDK, so the TUI, the provider and the terminal stay up — seeded with the
//      same provider and model and opened with one message: read the handoff,
//      continue where the last session left off.
//
// The session-control call is only allowed from a command handler, so the
// rotation calls its own `/rotate-now` command through a queued message (the
// documented way for an extension to dispatch a command). If the agent never
// writes the document, the rotation still happens after a grace period, with a
// note in the handoff saying so — an unattended run must not stall on a missing
// file. FREEPI_ROTATE=0 (or `/rotate off`) turns the whole thing off.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, statSync } from "node:fs";
import {
  HANDOFF_VERSION,
  type RotationHandoff,
  handoffDir,
  handoffPrompt,
  summaryPathFor,
  writeHandoff as writeHandoffFile,
} from "./handoff";
import { runtimeFlags } from "./runtime-flags";

export const ROTATE_EXTENSION_NAME = "free-pi-rotate";
export const ROTATE_STATUS_KEY = "free-pi-rotate";
export const ROTATE_NOW_COMMAND = "rotate-now";

/** The shift length: three hours, as asked for. */
export const DEFAULT_ROTATE_MS = 3 * 60 * 60 * 1000;
/** How long the handoff document may take before the rotation goes ahead without it. */
export const DEFAULT_GRACE_MS = 10 * 60 * 1000;
/** The timer's own granularity — how often the deadline and the grace period are checked. */
export const DEFAULT_TICK_MS = 60_000;

export interface RotateOptions {
  /** Where summaries and handoff records live (`~/.free-pi/agent`). */
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  rotateMs?: number;
  graceMs?: number;
  tickMs?: number;
  /** Test seams. */
  now?: () => Date;
  /** Writes the handoff record; defaults to handoff.ts. */
  writeHandoff?: (handoff: RotationHandoff) => string;
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

function humanize(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

/**
 * The instruction the agent gets at the deadline. It asks for an operational
 * handoff, not a recap: the next session has no memory of this conversation.
 */
export function summaryRequest(summaryPath: string, sessionFile: string | null): string {
  return [
    "Stop what you are doing and write a handoff document for a new session that will take over this task.",
    "",
    `Write it to exactly this path, creating the file with your write tool: ${summaryPath}`,
    sessionFile ? `(The full conversation is at ${sessionFile} if you need to check details.)` : "",
    "",
    "Use these sections, and be specific — exact paths, exact commands, exact values:",
    "1. The task: what we are trying to achieve, for whom, and the rules or scope we must stay inside.",
    "2. Where the work stands: what is finished and verified, what is in progress, what failed.",
    "3. What remains, in the order it should be done.",
    "4. Findings and decisions, with the evidence that supports them.",
    "5. Files, paths, endpoints and commands that matter.",
    "6. Open questions, risks, and anything that did not work.",
    "7. The single next action the new session should take first.",
    "",
    "This is an operational handoff, not a story about the conversation. When the file is written, reply with one line: HANDOFF READY",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function createRotateExtension(opts: RotateOptions): InlineExtension {
  const env = opts.env ?? process.env;
  const rotateMs = opts.rotateMs ?? positiveMs(env.FREEPI_ROTATE_MS, DEFAULT_ROTATE_MS);
  const graceMs = opts.graceMs ?? positiveMs(env.FREEPI_ROTATE_GRACE_MS, DEFAULT_GRACE_MS);
  const tickMs = opts.tickMs ?? positiveMs(env.FREEPI_ROTATE_TICK_MS, DEFAULT_TICK_MS);
  const now = opts.now ?? (() => new Date());
  const writeHandoff = opts.writeHandoff ?? ((handoff: RotationHandoff) => writeHandoffFile(opts.agentDir, handoff));
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  return {
    name: ROTATE_EXTENSION_NAME,
    factory(pi: ExtensionAPI) {
      let enabled = flag(env.FREEPI_ROTATE, true);
      let deadline = now().getTime() + rotateMs;
      let timer: unknown;
      let ctx: ExtensionContext | undefined;
      let sessionId: string | null = null;
      let sessionFile: string | null = null;
      let cwd = process.cwd();
      let provider: string | null = null;
      let model: string | null = null;
      let count = 0;
      let pending: { summaryPath: string; askedAt: number; retried: boolean } | null = null;
      let busy = false;

      const statusLine = (): string => {
        if (!enabled) return "rotation OFF";
        const left = Math.max(0, deadline - now().getTime());
        return pending
          ? `rotation: writing the handoff document (${pending.summaryPath})`
          : `rotation in ${humanize(left)} — a summary document, then a new session (${humanize(rotateMs)} shift)`;
      };

      const setStatus = (): void => {
        try {
          ctx?.ui?.setStatus?.(ROTATE_STATUS_KEY, statusLine());
        } catch {
          // the status line is cosmetic
        }
      };

      const summaryReady = (path: string): boolean => {
        try {
          return existsSync(path) && statSync(path).size > 0;
        } catch {
          return false;
        }
      };

      /**
       * Ask for the handoff document, and return the path it should be written
       * to (or the one already in flight). Suppresses the keepalive meanwhile.
       */
      const beginRotation = (): { path: string; started: boolean } => {
        if (pending) return { path: pending.summaryPath, started: false };
        const at = now();
        const summaryPath = summaryPathFor(opts.agentDir, at);
        // The agent is about to be asked to write *into* this directory: it has
        // to exist first, or the handoff document cannot be created at all.
        try {
          mkdirSync(handoffDir(opts.agentDir), { recursive: true });
        } catch {
          // if it cannot be created, the rotation still runs and reports the miss
        }
        pending = { summaryPath, askedAt: at.getTime(), retried: false };
        runtimeFlags.rotationPending = true;
        setStatus();
        pi.sendUserMessage(summaryRequest(summaryPath, sessionFile), { deliverAs: "followUp" });
        return { path: summaryPath, started: true };
      };

      const cancelPending = (): void => {
        pending = null;
        runtimeFlags.rotationPending = false;
        deadline = now().getTime() + rotateMs;
        setStatus();
      };

      /** The command dispatch that is allowed to replace the session. */
      const requestNewSession = (): void => {
        pi.sendUserMessage(`/${ROTATE_NOW_COMMAND}`, { deliverAs: "followUp", expandPromptTemplates: true });
      };

      const tick = (): void => {
        if (!enabled) return;
        const at = now();
        if (pending) {
          // The document did not arrive in time: rotate anyway, and say so in
          // the handoff rather than stalling the run.
          if (at.getTime() - pending.askedAt >= graceMs) {
            requestNewSession();
          }
          return;
        }
        if (at.getTime() < deadline) return;
        if (busy) return; // the deadline waits for the current turn
        beginRotation();
      };

      const start = (): void => {
        if (timer !== undefined) return;
        timer = setTimer(tick, tickMs);
        (timer as { unref?: () => void })?.unref?.();
      };

      const stop = (): void => {
        if (timer === undefined) return;
        clearTimer(timer);
        timer = undefined;
      };

      pi.registerCommand("rotate", {
        description:
          "The 3-hour shift: status | now | off | on. Writes a handoff summary document, then continues the task in a new session with the same provider and model.",
        handler: async (args: string, cmdCtx: ExtensionCommandContext) => {
          const sub = (args ?? "").trim().toLowerCase();
          switch (sub) {
            case "now": {
              deadline = now().getTime();
              const { path, started } = beginRotation();
              cmdCtx.ui.notify(
                started ? `Writing the handoff document: ${path}` : `A rotation is already writing its handoff document (${path}).`,
                "info",
              );
              return;
            }
            case "off":
              enabled = false;
              stop();
              cancelPending();
              cmdCtx.ui.notify("Rotation OFF — this session will keep running until you stop it.", "info");
              return;
            case "on":
              enabled = true;
              cancelPending();
              start();
              cmdCtx.ui.notify(statusLine(), "info");
              return;
            case "status":
            default:
              cmdCtx.ui.notify(
                `${statusLine()}\nSummaries and handoffs live in ${opts.agentDir} (handoff/). Same provider and model carry over: ${provider ?? "?"}/${model ?? "?"}.`,
                "info",
              );
          }
        },
      });

      // The rotation's own session replacement. A user can run it too (it is
      // listed as /rotate-now): with no handoff pending it just says so.
      pi.registerCommand(ROTATE_NOW_COMMAND, {
        description: "Internal: start the new session a rotation hands off to.",
        handler: async (_args: string, cmdCtx: ExtensionCommandContext) => {
          const summaryPath = pending?.summaryPath ?? null;
          const summaryWritten = Boolean(summaryPath && summaryReady(summaryPath));
          const note = summaryPath && !summaryWritten ? "The previous session did not write its summary document; its context is in the session file." : undefined;
          count += 1;
          const handoff: RotationHandoff = {
            version: HANDOFF_VERSION,
            createdAt: now().toISOString(),
            fromSessionId: sessionId,
            fromSessionFile: sessionFile,
            summaryPath: summaryPath ?? "",
            summaryWritten,
            cwd,
            provider,
            model,
            count,
            ...(note ? { note } : {}),
          };
          let handoffFilePath = "";
          if (summaryPath) {
            try {
              handoffFilePath = writeHandoff(handoff);
            } catch {
              // a handoff record is a convenience: never block the rotation on it
            }
          }

          pending = null;
          runtimeFlags.rotationPending = false;

          // The new session keeps the same provider and model: the model change
          // is written into it before it is bound, so the picker and every
          // request stay where the session left off.
          const result = await cmdCtx.newSession({
            ...(sessionFile ? { parentSession: sessionFile } : {}),
            setup: async (sm) => {
              if (provider && model) {
                try {
                  sm.appendModelChange(provider, model);
                } catch {
                  // an SDK without model-change appends: the default model stands
                }
              }
            },
            withSession: async (newCtx) => {
              newCtx.ui.notify(
                summaryPath
                  ? `Rotated: continuing in a new session as ${provider ?? "?"}/${model ?? "?"}. Handoff: ${summaryPath}${handoffFilePath ? ` (record: ${handoffFilePath})` : ""}`
                  : `Rotated: continuing in a new session as ${provider ?? "?"}/${model ?? "?"} (no handoff document was written).`,
                "info",
              );
              await newCtx.sendUserMessage(handoffPrompt(handoff), { deliverAs: "followUp" });
            },
          });

          if (result?.cancelled) {
            // An extension cancelled the replacement: keep the session (and the
            // schedule) alive rather than losing the run.
            cmdCtx.ui.notify("The new session was cancelled; continuing in this one.", "warning");
            runtimeFlags.rotationPending = false;
            deadline = now().getTime() + rotateMs;
            return;
          }
          deadline = now().getTime() + rotateMs;
        },
      });

      pi.on("session_start", async (_event, sessionCtx) => {
        ctx = sessionCtx;
        busy = false;
        sessionId = sessionCtx.sessionManager?.getSessionId?.() ?? null;
        sessionFile = sessionCtx.sessionManager?.getSessionFile?.() ?? null;
        cwd = sessionCtx.cwd ?? cwd;
        const model_ = sessionCtx.model as { provider?: string; id?: string } | undefined;
        provider = model_?.provider ?? provider;
        model = model_?.id ?? model;
        deadline = now().getTime() + rotateMs;
        pending = null;
        runtimeFlags.rotationPending = false;
        setStatus();
        cmdNotify(sessionCtx, enabled);
        if (enabled) start();
      });

      pi.on("turn_start", () => {
        busy = true;
      });
      pi.on("agent_start", () => {
        busy = true;
      });
      pi.on("turn_end", () => {
        busy = false;
      });
      pi.on("agent_settled", () => {
        busy = false;
      });
      pi.on("agent_end", () => {
        busy = false;
        if (!pending) return;
        if (summaryReady(pending.summaryPath)) {
          requestNewSession();
          return;
        }
        if (!pending.retried) {
          pending.retried = true;
          pi.sendUserMessage(
            `The handoff document was not written yet. Write it now to exactly this path: ${pending.summaryPath} — then reply with one line: HANDOFF READY`,
            { deliverAs: "followUp" },
          );
        } else {
          // Second miss: let the grace period decide, so the run keeps moving.
          requestNewSession();
        }
      });

      pi.on("session_shutdown", () => {
        stop();
        ctx = undefined;
        if (!pending) runtimeFlags.rotationPending = false;
      });
    },
  };
}

/** One line telling the user the session rotates, and when. */
function cmdNotify(ctx: ExtensionContext, enabled: boolean): void {
  try {
    ctx.ui?.notify?.(
      enabled
        ? "Rotation is on: every 3 hours this session writes a handoff summary and continues in a new session (/rotate status)."
        : "Rotation is off (/rotate on to enable).",
      "info",
    );
  } catch {
    // the notify is cosmetic
  }
}
