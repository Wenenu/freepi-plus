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
//      SDK, so the TUI, the provider and the terminal stay up — with the model
//      the session was actually on (read at rotation time, not at startup) put
//      back through the checked switch, and opened with the handoff document
//      quoted into its context plus one message: continue where the last
//      session left off.
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
  BRIEF_MARKER,
  BRIEF_SENTENCES,
  HANDOFF_VERSION,
  type RotationHandoff,
  briefFromDocument,
  briefPromptBlock,
  deriveBrief,
  freshBrief,
  handoffContext,
  handoffDir,
  handoffPath,
  handoffPrompt,
  latestBriefPath,
  readHandoff,
  readSummary,
  summaryPathFor,
  writeBrief,
  writeHandoff as writeHandoffFile,
} from "./handoff";
import { applyModelSwitch } from "./model-switch";
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
    "This is an operational handoff, not a story about the conversation.",
    "",
    `Then reply with exactly ${BRIEF_SENTENCES} sentences summarising this session for the next chat: where the work stands, what you were doing, what comes next, and anything the next session must not waste time repeating. No heading, no bullets, no preamble, no \"HANDOFF READY\" line — that reply becomes the next session's standing brief, so write it for an agent that has none of your context.`,
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
      let pending: { summaryPath: string; askedAt: number; retried: boolean; brief: string | null } | null = null;
      let busy = false;
      /**
       * The brief this session runs under, if it was handed one. Set once from
       * the rotation that produced the session (or from disk when a process
       * restarted mid-handoff) and then added to the system prompt of every turn.
       */
      let sessionBrief: string | null = null;

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
        pending = { summaryPath, askedAt: at.getTime(), retried: false, brief: null };
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
                `${statusLine()}\nSummaries and handoffs live in ${opts.agentDir} (handoff/). Same provider and model carry over: ${provider ?? "?"}/${model ?? "?"}.\nBrief in this session's system prompt: ${sessionBrief ? `${BRIEF_SENTENCES} sentences from the session it took over from` : "none"}.`,
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

          // The model the session is on *now*, read at the moment of the
          // rotation rather than at session_start: the user may have switched
          // to Antseed mid-session, and the handoff has to carry that over. The
          // recorded provider/model used to be whatever the session started on,
          // which is how a session handed off from Antseed came back on free-pi.
          const live = (cmdCtx as { model?: { provider?: string; id?: string } }).model;
          if (live?.provider) provider = live.provider;
          if (live?.id) model = live.id;

          // The brief: the replaced session's own closing reply when it was
          // usable, and a digest of the handoff document when it was not. Either
          // way the new session gets four sentences of orientation, not a cold
          // start, and they are written to disk so the chain survives a restart.
          const summary = summaryPath ? readSummary(summaryPath) : null;
          const brief = pending?.brief ?? briefFromDocument(summary?.text);
          let briefPath: string | null = null;
          if (brief) {
            try {
              briefPath = writeBrief(opts.agentDir, brief, now());
            } catch {
              // A brief that cannot be written is still one this session carries.
            }
          }

          count = (readHandoff(handoffPath(opts.agentDir))?.count ?? 0) + 1;
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
            brief,
            briefPath,
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

          // Two things must survive into the replacement session, and neither
          // survives by itself:
          //   * the provider/model, which a fresh session resolves from the
          //     settings default — so it is recorded here *and* applied through
          //     the checked switch by the new session's own session_start (the
          //     SDK tears this extension instance down before the replacement
          //     is bound, so the flag is the only channel that reaches it);
          //   * the handoff document itself, quoted into the new transcript in
          //     `setup`, so the next chat has the context even if its first turn
          //     never opens the file.
          if (provider && model) runtimeFlags.pendingModel = { provider, model };
          runtimeFlags.pendingBrief = brief;

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
              try {
                const text = handoffContext(handoff, summary);
                sm.appendMessage({
                  role: "user",
                  content: [{ type: "text", text }],
                  timestamp: Date.now(),
                } as unknown as Parameters<typeof sm.appendMessage>[0]);
              } catch {
                // A runtime without appendMessage cannot be handed the document
                // this way; the kickoff prompt below still names the file, and
                // the keepalive keeps the session moving either way.
              }
            },
            withSession: async (newCtx) => {
              newCtx.ui.notify(
                summaryPath
                  ? `Rotated: continuing in a new session as ${provider ?? "?"}/${model ?? "?"}. Handoff: ${summaryPath}${handoffFilePath ? ` (record: ${handoffFilePath})` : ""}${brief ? ` — brief: ${briefPath ?? latestBriefPath(opts.agentDir)}` : " (no brief)"}`
                  : `Rotated: continuing in a new session as ${provider ?? "?"}/${model ?? "?"} (no handoff document was written)${brief ? ` — carrying a ${BRIEF_SENTENCES}-sentence brief` : ""}.`,
                "info",
              );
              await newCtx.sendUserMessage(handoffPrompt(handoff), { deliverAs: "followUp" });
            },
          });

          if (result?.cancelled) {
            // An extension cancelled the replacement: keep the session (and the
            // schedule) alive rather than losing the run — and drop the pending
            // model, or the *next* session (whenever it starts) would inherit it.
            cmdCtx.ui.notify("The new session was cancelled; continuing in this one.", "warning");
            runtimeFlags.rotationPending = false;
            runtimeFlags.pendingModel = null;
            runtimeFlags.pendingBrief = null;
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

        // This session may be the replacement a rotation just created, in which
        // case it starts on the settings default until we put it back on the
        // model the rotation handed over. `pi.setModel` is the checked switch
        // (see model-switch.ts): `appendModelChange` in `setup` only writes a
        // record into the transcript, it does not change what the next request
        // is sent to. This handler runs before the replacement's kickoff
        // message, so the very first turn is already on the right model.
        // And the brief the rotation wrote: this session's system prompt carries
        // it for its whole life (see before_agent_start below). In-process when
        // this *is* the replacement, from disk when the process restarted with a
        // handoff still fresh.
        sessionBrief = runtimeFlags.pendingBrief ?? freshBrief(opts.agentDir, now().getTime())?.brief ?? null;
        runtimeFlags.pendingBrief = null;

        const handoffModel = runtimeFlags.pendingModel;
        runtimeFlags.pendingModel = null;
        if (handoffModel) {
          const switched = await applyModelSwitch(handoffModel.provider, handoffModel.model, sessionCtx, pi);
          if (switched.ok) {
            provider = handoffModel.provider;
            model = handoffModel.model;
          } else {
            sessionCtx.ui?.notify?.(
              `Rotated in, but the previous session's model (${handoffModel.provider}/${handoffModel.model}) could not be restored${switched.reason ? `: ${switched.reason}` : ""}.`,
              "warning",
            );
          }
        }

        deadline = now().getTime() + rotateMs;
        pending = null;
        runtimeFlags.rotationPending = false;
        setStatus();
        cmdNotify(sessionCtx, enabled);
        if (enabled) start();
      });

      // The brief rides in the system prompt: every request of this session is
      // prefixed with four sentences of "here is where the work stands", so the
      // session starts oriented and stays oriented as its context grows. It is
      // added once per turn and never again (see BRIEF_MARKER), and it is framed
      // as background rather than as an instruction.
      pi.on("before_agent_start", (event) => {
        if (!sessionBrief) return undefined;
        if (event.systemPrompt.includes(BRIEF_MARKER)) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${briefPromptBlock(sessionBrief)}` };
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
      pi.on("agent_end", (event) => {
        busy = false;
        if (!pending) return;
        if (summaryReady(pending.summaryPath)) {
          // The document is on disk: the turn that wrote it ends with the brief,
          // and whatever it said is the brief the next session will run under.
          pending.brief = deriveBrief(lastAssistantText(event));
          requestNewSession();
          return;
        }
        if (!pending.retried) {
          pending.retried = true;
          pi.sendUserMessage(
            `The handoff document was not written yet. Write it now to exactly this path: ${pending.summaryPath} — then reply with exactly ${BRIEF_SENTENCES} sentences summarising this session for the next chat.`,
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

/** The last assistant message's text — where the agent's closing brief lands. */
function lastAssistantText(event: { messages: readonly unknown[] }): string | null {
  const last = event?.messages?.[event.messages.length - 1] as { role?: string; content?: unknown } | undefined;
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return null;
  return (last.content as Array<{ type?: string; text?: unknown }>)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
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
