// "Keep it running": an idle session is told to continue, a busy one is never
// interrupted, a rotation in flight wins, and /keepalive off really stops it.
//
// The timer is driven with tiny intervals (10ms) rather than fake timers, so the
// test exercises the real code path — the same tick the TUI gets.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { KEEPALIVE_NUDGE, createKeepaliveExtension } from "../src/keepalive";
import { runtimeFlags } from "../src/runtime-flags";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dir = "";
let env: NodeJS.ProcessEnv = {};

interface Harness {
  pi: Record<string, unknown>;
  commands: Map<string, (args: string, ctx: unknown) => Promise<void> | void>;
  events: Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>;
  sends: Array<{ text: string; deliverAs?: string }>;
  notices: string[];
  statuses: Array<string | undefined>;
  ctx: { isIdle: () => boolean; ui: { notify: (message: string) => void; setStatus: (key: string, text: string | undefined) => void } };
}

function mount(
  opts: {
    checkMs?: number;
    idleMs?: number;
    idle?: () => boolean;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): Harness {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
  const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const sends: Array<{ text: string; deliverAs?: string }> = [];
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  const state = { idle: opts.idle ?? (() => true) };

  const pi = {
    sendUserMessage: (text: string, options?: { deliverAs?: string }) => sends.push({ text, deliverAs: options?.deliverAs }),
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => commands.set(name, options.handler),
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => events.set(name, handler),
  };

  const extension = createKeepaliveExtension({
    env,
    checkMs: opts.checkMs ?? 10,
    idleMs: opts.idleMs ?? 5,
    ...(opts.setTimer ? { setTimer: opts.setTimer } : {}),
    ...(opts.clearTimer ? { clearTimer: opts.clearTimer } : {}),
  }) as InlineExtension & { name: string };
  const factory = (typeof extension === "function" ? extension : extension.factory) as (pi: unknown) => void;
  factory(pi);

  const ctx = {
    isIdle: () => state.idle(),
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
  };
  return { pi, commands, events, sends, notices, statuses, ctx };
}

const started = (h: Harness) => h.events.get("session_start")?.({ type: "session_start" }, h.ctx);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "free-pi-keepalive-"));
  env = { FREEPI_SWARM_DIR: dir };
  runtimeFlags.rotationPending = false;
});

afterEach(() => {
  runtimeFlags.rotationPending = false;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // windows handle
  }
});

describe("keepalive — an idle session is told to continue", () => {
  test("it nudges once the session has been quiet, and says what to do", async () => {
    const h = mount();
    await started(h);
    await sleep(60);
    h.events.get("session_shutdown")?.({}, h.ctx);

    expect(h.sends.length).toBeGreaterThan(0);
    expect(h.sends[0]?.text).toBe(KEEPALIVE_NUDGE);
    expect(h.sends[0]?.text).toContain("Continue with the task");
    expect(h.sends[0]?.deliverAs).toBe("followUp");
  });

  test("a busy session is never interrupted", async () => {
    let idle = false;
    const h = mount({ idle: () => idle });
    await started(h);
    await sleep(60);
    expect(h.sends).toHaveLength(0);

    // Once it goes quiet, the nudge arrives.
    idle = true;
    await sleep(60);
    h.events.get("session_shutdown")?.({}, h.ctx);
    expect(h.sends.length).toBeGreaterThan(0);
  });

  test("turn events are the fallback when the runtime has no isIdle()", async () => {
    const h = mount();
    const ctxWithoutIdle = { ui: h.ctx.ui };
    await h.events.get("session_start")?.({}, ctxWithoutIdle);
    h.events.get("turn_start")?.({}, ctxWithoutIdle);
    await sleep(40);
    expect(h.sends).toHaveLength(0);

    h.events.get("turn_end")?.({}, ctxWithoutIdle);
    await sleep(60);
    h.events.get("session_shutdown")?.({}, ctxWithoutIdle);
    expect(h.sends.length).toBeGreaterThan(0);
  });

  // The backup for a turn that ended on a tool call the model printed instead of
  // making (DeepSeek's DSML wrapper). That turn did not do the work it meant to
  // do, and nothing follows it — so it is nudged at the next check rather than
  // after the whole idle window, which for a long unattended run is the window
  // that matters.
  test("a turn that ended on printed tool markup is nudged on the next check", async () => {
    const h = mount({ idleMs: 600_000 });
    await started(h);
    await sleep(20);
    expect(h.sends).toHaveLength(0);

    h.events.get("agent_end")?.(
      { messages: [{ role: "assistant", content: [{ type: "text", text: '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">' }] }] },
      h.ctx,
    );
    await sleep(40);

    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.text).toBe(KEEPALIVE_NUDGE);
    h.events.get("session_shutdown")?.({}, h.ctx);
  });

  test("an ordinary finished turn still waits out the idle window", async () => {
    const h = mount({ idleMs: 600_000 });
    await started(h);
    h.events.get("agent_end")?.(
      { messages: [{ role: "assistant", content: [{ type: "text", text: "The report is written; next is the PoC." }] }] },
      h.ctx,
    );
    await sleep(40);
    expect(h.sends).toHaveLength(0);
    h.events.get("session_shutdown")?.({}, h.ctx);
  });

  test("a rotation in flight suppresses the nudge — the handoff comes first", async () => {
    const h = mount();
    await started(h);
    runtimeFlags.rotationPending = true;
    await sleep(60);
    expect(h.sends).toHaveLength(0);
    h.events.get("session_shutdown")?.({}, h.ctx);
  });

  test("/keepalive off stops it, on resumes it, and status reports where it stands", async () => {
    const h = mount();
    await started(h);
    await h.commands.get("keepalive")?.("off", h.ctx);
    await sleep(60);
    expect(h.sends).toHaveLength(0);
    expect(h.notices.join("\n")).toContain("keepalive OFF");

    await h.commands.get("keepalive")?.("on", h.ctx);
    await sleep(60);
    expect(h.sends.length).toBeGreaterThan(0);

    await h.commands.get("keepalive")?.("status", h.ctx);
    expect(h.notices.join("\n")).toContain("keepalive ON");
    h.events.get("session_shutdown")?.({}, h.ctx);
  });

  test("/keepalive now nudges immediately, without waiting for the idle window", async () => {
    const h = mount({ idleMs: 600_000 });
    await started(h);
    await sleep(20);
    expect(h.sends).toHaveLength(0);
    await h.commands.get("keepalive")?.("now", h.ctx);
    expect(h.sends).toHaveLength(1);
    h.events.get("session_shutdown")?.({}, h.ctx);
  });

  test("FREEPI_KEEPALIVE=0 leaves the session alone from the start", async () => {
    env = { ...env, FREEPI_KEEPALIVE: "0" };
    const h = mount();
    await started(h);
    await sleep(60);
    expect(h.sends).toHaveLength(0);
    expect(h.statuses.join("\n")).toContain("keepalive OFF");
    h.events.get("session_shutdown")?.({}, h.ctx);
  });

  test("the timer is unref'd, so it can never hold the process open — and cleared on shutdown", async () => {
    const unrefs: number[] = [];
    const cleared: unknown[] = [];
    const handle = { unref: () => unrefs.push(1) };
    const h = mount({
      setTimer: () => handle,
      clearTimer: (clearedHandle) => cleared.push(clearedHandle),
    });
    await started(h);
    expect(unrefs).toHaveLength(1);
    expect(cleared).toHaveLength(0);

    h.events.get("session_shutdown")?.({}, h.ctx);
    expect(cleared).toEqual([handle]);
  });
});
