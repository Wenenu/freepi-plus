// The 3-hour shift, compressed to milliseconds: the session is asked for a
// handoff document, the document is written, and the task continues in a NEW
// session carrying the same provider and model — with fallbacks for a document
// that never arrives and for a turn that never ends.
//
// The session replacement is the SDK's own `ctx.newSession()`, reached through a
// command handler (the only context allowed to replace a session), so the test
// drives the same dispatch the timer uses: a queued `/rotate-now` message.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { handoffDir, handoffPath } from "../src/handoff";
import { ROTATE_NOW_COMMAND, createRotateExtension } from "../src/rotate";
import { runtimeFlags } from "../src/runtime-flags";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let agentDir = "";
let env: NodeJS.ProcessEnv = {};

interface NewSessionCall {
  parentSession?: string;
  setup: (sm: {
    appendModelChange: (provider: string, model: string) => void;
    appendMessage: (message: { role: string; content: Array<{ type: string; text: string }> }) => void;
  }) => Promise<void>;
  withSession: (ctx: { ui: { notify: (message: string) => void }; sendUserMessage: (text: string, options?: unknown) => Promise<void> }) => Promise<void>;
}

interface Harness {
  commands: Map<string, (args: string, ctx: unknown) => Promise<void> | void>;
  events: Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>;
  sends: Array<{ text: string; deliverAs?: string; expandPromptTemplates?: boolean }>;
  notices: string[];
  statuses: Array<string | undefined>;
  modelChanges: Array<{ provider: string; model: string }>;
  kickoffs: string[];
  newSessions: NewSessionCall[];
  /** The messages the rotation wrote into the replacement session. */
  appended: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
  /** What the model picker is showing *now* — a rotation must carry this over. */
  liveModel: { provider?: string; id?: string } | undefined;
  /** The session ctx the events are fired with (asserted on after a rotation). */
  sessionCtx: Record<string, unknown>;
  cancelled: boolean;
  /** Fire the events the runtime fires, and let the injected command run. */
  event: (name: string) => Promise<void>;
  runCommand: (name: string, args?: string) => Promise<void>;
}

function mount(opts: { rotateMs?: number; graceMs?: number; tickMs?: number } = {}): Harness {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
  const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const sends: Array<{ text: string; deliverAs?: string; expandPromptTemplates?: boolean }> = [];
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  const modelChanges: Array<{ provider: string; model: string }> = [];
  const kickoffs: string[] = [];
  const newSessions: NewSessionCall[] = [];
  const appended: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
  const state: { cancelled: boolean; liveModel: { provider?: string; id?: string } | undefined } = {
    cancelled: false,
    liveModel: undefined,
  };

  const pi = {
    sendUserMessage: (text: string, options?: { deliverAs?: string; expandPromptTemplates?: boolean }) =>
      sends.push({ text, deliverAs: options?.deliverAs, expandPromptTemplates: options?.expandPromptTemplates }),
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => commands.set(name, options.handler),
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => events.set(name, handler),
  };

  const extension = createRotateExtension({
    agentDir,
    env,
    rotateMs: opts.rotateMs ?? 25,
    graceMs: opts.graceMs ?? 10_000,
    tickMs: opts.tickMs ?? 10,
  }) as InlineExtension & { name: string };
  const factory = (typeof extension === "function" ? extension : extension.factory) as (pi: unknown) => void;
  factory(pi);

  const ui = {
    notify: (message: string) => notices.push(message),
    setStatus: (_key: string, text: string | undefined) => statuses.push(text),
  };

  const sessionCtx = {
    cwd: agentDir,
    model: { provider: "free-pi", id: "deepseek-v4-flash" },
    sessionManager: { getSessionId: () => "01a1-old", getSessionFile: () => join(agentDir, "old-session.jsonl") },
    ui,
  };

  const commandCtx = {
    ui,
    // Read at call time: what the user switched the session to mid-run is
    // exactly what the rotation has to carry over.
    get model() {
      return state.liveModel;
    },
    newSession: async (call: NewSessionCall) => {
      newSessions.push(call);
      await call.setup({
        appendModelChange: (provider: string, model: string) => modelChanges.push({ provider, model }),
        appendMessage: (message) => appended.push(message),
      });
      if (!state.cancelled) {
        await call.withSession({
          ui,
          sendUserMessage: async (text: string) => {
            kickoffs.push(text);
          },
        });
      }
      return { cancelled: state.cancelled };
    },
  };

  return {
    commands,
    events,
    sends,
    notices,
    statuses,
    modelChanges,
    kickoffs,
    newSessions,
    appended,
    sessionCtx,
    get liveModel() {
      return state.liveModel;
    },
    set liveModel(value: { provider?: string; id?: string } | undefined) {
      state.liveModel = value;
    },
    get cancelled() {
      return state.cancelled;
    },
    set cancelled(value: boolean) {
      state.cancelled = value;
    },
    event: async (name: string) => {
      await events.get(name)?.({ type: name, messages: [] }, sessionCtx);
    },
    runCommand: async (name: string, args = "") => {
      await commands.get(name)?.(args, commandCtx);
    },
  } as Harness;
}

/** Start the session and let the timer reach its deadline. */
async function startAndWait(h: Harness): Promise<void> {
  await h.events.get("session_start")?.({ type: "session_start" }, {
    cwd: agentDir,
    model: { provider: "free-pi", id: "deepseek-v4-flash" },
    sessionManager: { getSessionId: () => "01a1-old", getSessionFile: () => join(agentDir, "old-session.jsonl") },
    ui: { notify: (m: string) => h.notices.push(m), setStatus: (_k: string, t: string | undefined) => h.statuses.push(t) },
  });
  await sleep(60);
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "free-pi-rotate-"));
  env = {};
  runtimeFlags.rotationPending = false;
});

afterEach(() => {
  runtimeFlags.rotationPending = false;
  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch {
    // windows handle
  }
});

describe("rotate — the 3-hour shift", () => {
  test("at the deadline it asks for a handoff document at a path in the handoff directory", async () => {
    const h = mount();
    await startAndWait(h);

    expect(h.sends).toHaveLength(1);
    const request = h.sends[0]?.text ?? "";
    expect(request).toContain("handoff document");
    expect(request).toContain(handoffDir(agentDir));
    expect(request).toContain("HANDOFF READY");
    // The keepalive must not also be nudging the session while this is pending.
    expect(runtimeFlags.rotationPending).toBe(true);
    h.events.get("session_shutdown")?.({}, {});
  });

  test("a deadline during a running turn waits for it", async () => {
    const h = mount();
    await h.events.get("session_start")?.({ type: "session_start" }, {
      cwd: agentDir,
      model: { provider: "free-pi", id: "deepseek-v4-flash" },
      sessionManager: { getSessionId: () => "01a1-old", getSessionFile: () => join(agentDir, "old-session.jsonl") },
      ui: { notify: (m: string) => h.notices.push(m), setStatus: (_k: string, t: string | undefined) => h.statuses.push(t) },
    });
    h.events.get("turn_start")?.({}, {});
    // The deadline passes while the agent is mid-turn: no interruption.
    await sleep(60);
    expect(h.sends).toHaveLength(0);
    expect(runtimeFlags.rotationPending).toBe(false);

    h.events.get("turn_end")?.({}, {});
    await sleep(60);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.text).toContain("handoff document");
    h.events.get("session_shutdown")?.({}, {});
  });

  test("once the document is written, the task continues in a new session with the same provider and model", async () => {
    const h = mount();
    await startAndWait(h);
    const summaryPath = /(\S+summary-[^\s]+\.md)/.exec(h.sends[0]?.text ?? "")?.[1];
    expect(summaryPath).toBeDefined();
    writeFileSync(summaryPath as string, "# Handoff\n\nEverything you need.\n");

    // The turn that wrote the document ends: the rotation dispatches its own
    // command, because only a command context may replace the session.
    await h.event("agent_end");
    expect(h.sends[1]?.text).toBe(`/${ROTATE_NOW_COMMAND}`);
    expect(h.sends[1]?.expandPromptTemplates).toBe(true);

    await h.runCommand(ROTATE_NOW_COMMAND);

    expect(h.newSessions).toHaveLength(1);
    expect(h.newSessions[0]?.parentSession).toBe(join(agentDir, "old-session.jsonl"));
    // Same provider and model as the session being replaced.
    expect(h.modelChanges).toEqual([{ provider: "free-pi", model: "deepseek-v4-flash" }]);
    // The new session is told to read the document and carry on.
    expect(h.kickoffs).toHaveLength(1);
    expect(h.kickoffs[0]).toContain(summaryPath as string);
    expect(h.kickoffs[0]).toContain("continue the work");
    expect(h.notices.join("\n")).toContain("Rotated");

    // The handoff record is on disk beside the summary, and the schedule re-arms.
    const record = JSON.parse(readFileSync(handoffPath(agentDir), "utf8")) as Record<string, unknown>;
    expect(record.provider).toBe("free-pi");
    expect(record.model).toBe("deepseek-v4-flash");
    expect(record.summaryPath).toBe(summaryPath as string);
    expect(record.count).toBe(1);
    expect(runtimeFlags.rotationPending).toBe(false);
    h.events.get("session_shutdown")?.({}, {});
  });

  // The bug this fixes: the record said one thing and the new session ran on
  // another. `appendModelChange` only writes a note into the transcript — it
  // does not change which model the next request uses — so a session switched to
  // Antseed mid-run came back on free-pi's default, and the handoff was a lie.
  test("the replacement is put back on the model the old session was really on", async () => {
    const h = mount();
    h.liveModel = { provider: "antseed", id: "deepseek-v4.1-flash" };
    await startAndWait(h);
    const summaryPath = /(\S+summary-[^\s]+\.md)/.exec(h.sends[0]?.text ?? "")?.[1] as string;
    writeFileSync(summaryPath, "# Handoff\n\nContinue the audit.\n");
    await h.event("agent_end");
    await h.runCommand(ROTATE_NOW_COMMAND);

    expect(h.modelChanges).toEqual([{ provider: "antseed", model: "deepseek-v4.1-flash" }]);
    const record = JSON.parse(readFileSync(handoffPath(agentDir), "utf8")) as Record<string, unknown>;
    expect(record.provider).toBe("antseed");
    expect(record.model).toBe("deepseek-v4.1-flash");

    // The old extension instance cannot switch the model (the SDK makes it stale
    // the moment the session is replaced), so the request is handed to the new
    // session's own session_start, which runs before its kickoff message.
    expect(runtimeFlags.pendingModel).toEqual({ provider: "antseed", model: "deepseek-v4.1-flash" });
    const replacement = { cwd: agentDir, model: { provider: "free-pi", id: "deepseek-v4-flash" }, sessionManager: {}, ui: { notify: () => {}, setStatus: () => {} } };
    await h.events.get("session_start")?.({ type: "session_start" }, replacement);
    expect(replacement.model).toEqual({ provider: "antseed", id: "deepseek-v4.1-flash" });
    expect(runtimeFlags.pendingModel).toBeNull();

    h.events.get("session_shutdown")?.({}, {});
  });

  test("the handoff document is quoted into the new session, not just named", async () => {
    const h = mount();
    await startAndWait(h);
    const summaryPath = /(\S+summary-[^\s]+\.md)/.exec(h.sends[0]?.text ?? "")?.[1] as string;
    writeFileSync(summaryPath, "# Twyne handoff\n\nNEXT: check `_canLiquidate` scenario 2.\n");
    await h.event("agent_end");
    await h.runCommand(ROTATE_NOW_COMMAND);

    expect(h.appended).toHaveLength(1);
    const quoted = h.appended[0]?.content[0]?.text ?? "";
    expect(h.appended[0]?.role).toBe("user");
    expect(quoted).toContain("NEXT: check `_canLiquidate` scenario 2.");
    expect(quoted).toContain(summaryPath);
    // The kickoff still names the file, so a truncated quote can be completed.
    expect(h.kickoffs[0]).toContain(summaryPath);
    h.events.get("session_shutdown")?.({}, {});
  });

  test("a missing document is retried once, then the rotation goes ahead and says so", async () => {
    const h = mount();
    await startAndWait(h);
    await h.event("agent_end");
    expect(h.sends[1]?.text).toContain("was not written yet");
    expect(h.newSessions).toHaveLength(0);

    await h.event("agent_end");
    expect(h.sends[2]?.text).toBe(`/${ROTATE_NOW_COMMAND}`);
    await h.runCommand(ROTATE_NOW_COMMAND);

    expect(h.kickoffs).toHaveLength(1);
    expect(h.kickoffs[0]).toContain("did not leave a summary document");
    const record = JSON.parse(readFileSync(handoffPath(agentDir), "utf8")) as Record<string, unknown>;
    expect(record.note).toContain("did not write its summary document");
    h.events.get("session_shutdown")?.({}, {});
  });

  test("a turn that never ends cannot stall the rotation: the grace period forces it", async () => {
    const h = mount({ graceMs: 20, tickMs: 10 });
    await startAndWait(h);
    expect(h.sends[0]?.text).toContain("handoff document");
    // No agent_end at all: the grace period has to force the rotation.
    await sleep(60);
    expect(h.sends.some((send) => send.text === `/${ROTATE_NOW_COMMAND}`)).toBe(true);
    h.events.get("session_shutdown")?.({}, {});
  });

  test("a cancelled replacement leaves the session (and the schedule) alive", async () => {
    const h = mount();
    await startAndWait(h);
    const summaryPath = /(\S+summary-[^\s]+\.md)/.exec(h.sends[0]?.text ?? "")?.[1] as string;
    writeFileSync(summaryPath, "# Handoff\n");
    await h.event("agent_end");
    h.cancelled = true;
    await h.runCommand(ROTATE_NOW_COMMAND);

    expect(h.notices.join("\n")).toContain("was cancelled");
    expect(h.kickoffs).toHaveLength(0);
    expect(runtimeFlags.rotationPending).toBe(false);
    // The new session_start resets the clock anyway; this asserts we did not
    // leave the process with a pending rotation that never resolves.
    h.events.get("session_shutdown")?.({}, {});
  });

  test("/rotate status reports the deadline and the model, /rotate off stops the schedule", async () => {
    const h = mount({ rotateMs: 600_000, tickMs: 600_000 });
    await h.events.get("session_start")?.({ type: "session_start" }, {
      cwd: agentDir,
      model: { provider: "free-pi", id: "deepseek-v4-flash" },
      sessionManager: { getSessionId: () => "01a1-old", getSessionFile: () => join(agentDir, "old-session.jsonl") },
      ui: { notify: (m: string) => h.notices.push(m), setStatus: (_k: string, t: string | undefined) => h.statuses.push(t) },
    });
    await h.runCommand("rotate", "status");
    expect(h.notices.join("\n")).toContain("rotation in");
    expect(h.notices.join("\n")).toContain("free-pi/deepseek-v4-flash");

    await h.runCommand("rotate", "off");
    expect(h.notices.join("\n")).toContain("Rotation OFF");
    const sendsBefore = h.sends.length;
    h.events.get("session_shutdown")?.({}, {});
    await sleep(40);
    expect(h.sends.length).toBe(sendsBefore);
  });

  test("FREEPI_ROTATE=0 disables it, and the session is told", async () => {
    env = { FREEPI_ROTATE: "0" };
    const h = mount();
    await startAndWait(h);
    expect(h.sends).toHaveLength(0);
    expect(h.notices.join("\n")).toContain("Rotation is off");
    h.events.get("session_shutdown")?.({}, {});
  });
});

describe("rotate — the handoff record", () => {
  test("it is written where a human (and the next session) can find it", async () => {
    const h = mount();
    await startAndWait(h);
    const summaryPath = /(\S+summary-[^\s]+\.md)/.exec(h.sends[0]?.text ?? "")?.[1] as string;
    writeFileSync(summaryPath, "# Handoff\n");
    await h.event("agent_end");
    await h.runCommand(ROTATE_NOW_COMMAND);

    expect(existsSync(handoffPath(agentDir))).toBe(true);
    expect(existsSync(summaryPath)).toBe(true);
    h.events.get("session_shutdown")?.({}, {});
  });
});
