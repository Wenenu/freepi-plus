// The swarm extension, driven through a fake pi surface: `/coordinate` sets up
// the crew and hands the coordinating agent its brief, `/swarm` is the control
// surface, mail addressed to the session is pushed into it, and a session that
// never opted in is left completely alone.
//
// spawnWorker/stopWorker are injected throughout, so this suite never starts a
// process and can never spend anyone's allowance.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createSwarmExtension } from "../src/swarm/extension";
import { LEDGER_MARKER, addFinding } from "../src/swarm/ledger";
import { countUnread, getAgent, listAgents, loadSwarmConfig, sendMail, swarmPaths } from "../src/swarm/store";
import type { SpawnRequest, SpawnResult } from "../src/swarm/workers";

let dir = "";
let env: NodeJS.ProcessEnv = {};

interface Harness {
  pi: Record<string, unknown>;
  commands: Map<string, (args: string, ctx: unknown) => Promise<void> | void>;
  events: Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>;
  tools: Array<{ name: string }>;
  injections: Array<{ text: string; deliverAs?: string }>;
  notices: string[];
  statuses: Array<string | undefined>;
  spawns: SpawnRequest[];
  stops: string[];
}

function mount(opts: { pollMs?: number; spawnResult?: Partial<SpawnResult>; spawnError?: string } = {}): Harness {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
  const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const tools: Array<{ name: string }> = [];
  const injections: Array<{ text: string; deliverAs?: string }> = [];
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  const spawns: SpawnRequest[] = [];
  const stops: string[] = [];

  const pi = {
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => commands.set(name, options.handler),
    registerTool: (tool: { name: string }) => tools.push(tool),
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => events.set(name, handler),
    sendUserMessage: (text: string, options?: { deliverAs?: string }) => injections.push({ text, deliverAs: options?.deliverAs }),
  };

  const extension = createSwarmExtension({
    env,
    pollMs: opts.pollMs ?? 15,
    spawn: (req) => {
      spawns.push(req);
      if (opts.spawnError) throw new Error(opts.spawnError);
      return { name: req.name, role: req.role, cwd: req.cwd, pid: 4242, slot: 0, logPath: join(dir, "logs", `${req.name}.log`), taskId: req.taskId ?? null, ...opts.spawnResult };
    },
    stop: (name) => {
      stops.push(name);
    },
  }) as InlineExtension & { name: string };

  const factory = (typeof extension === "function" ? extension : extension.factory) as (pi: unknown) => void;
  factory(pi);

  return { pi, commands, events, tools, injections, notices, statuses, spawns, stops };
}

function context(h: Harness, sessionId = "01a1-session") {
  return {
    cwd: dir,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(dir, "session.jsonl") },
    ui: {
      notify: (message: string) => h.notices.push(message),
      setStatus: (_key: string, text: string | undefined) => h.statuses.push(text),
    },
  };
}

async function start(h: Harness, sessionId?: string) {
  const ctx = context(h, sessionId);
  await h.events.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  return ctx;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "free-pi-swarm-ext-"));
  env = { FREEPI_SWARM_DIR: dir };
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // windows handle
  }
});

describe("swarm extension — registration", () => {
  test("it registers /coordinate, /swarm and the swarm tool", () => {
    const h = mount();
    expect(h.commands.has("coordinate")).toBe(true);
    expect(h.commands.has("swarm")).toBe(true);
    expect(h.tools.map((t) => t.name)).toEqual(["free_pi_swarm"]);
  });
});

describe("swarm extension — a session that never opted in is left alone", () => {
  test("session_start with the switch off and no mail neither registers nor polls", async () => {
    const h = mount();
    await start(h);
    expect(listAgents(env)).toHaveLength(0);
    expect(h.injections).toHaveLength(0);
    // Nothing was created on disk either — a plain free-pi session stays plain.
    expect(getAgent("coordinator", env)).toBeNull();
  });

  test("mail already waiting does put the session on the roster, and is delivered", async () => {
    const h = mount();
    sendMail({ from: "scout", to: "coordinator", body: "take the staging host" }, env);
    await start(h);
    expect(getAgent("coordinator", env)?.name).toBe("coordinator");
    await sleep(60);
    expect(h.injections.length).toBeGreaterThan(0);
    expect(h.injections[0]?.text).toContain("[free-pi-swarm]");
    expect(h.injections[0]?.text).toContain("take the staging host");
    // Queued after the current turn: teammate mail never cuts a turn in half.
    expect(h.injections[0]?.deliverAs).toBe("followUp");
    expect(countUnread("coordinator", env)).toBe(0);
  });

  test("a worker's own session (FREEPI_SWARM_AGENT set) registers under its own name", async () => {
    env.FREEPI_SWARM_AGENT = "hunter-1";
    const h = mount();
    await start(h, "worker-session");
    expect(getAgent("hunter-1", env)?.name).toBe("hunter-1");
  });

  test("a worker's session does not drain its own inbox — its supervisor owns delivery", async () => {
    env.FREEPI_SWARM_AGENT = "hunter-1";
    const h = mount();
    await start(h, "worker-session");
    sendMail({ from: "coordinator", to: "hunter-1", body: "did you test the export endpoint?" }, env);
    await sleep(80);
    // Two readers of one mailbox would race: whichever drains first wins, and
    // only the supervisor restores a message it could not deliver.
    expect(h.injections).toHaveLength(0);
    expect(countUnread("hunter-1", env)).toBe(1);
  });

  test("its session registering leaves the deployed record intact", async () => {
    env.FREEPI_SWARM_AGENT = "hunter-1";
    const { registerSession, putAgent } = await import("../src/swarm/store");
    registerSession({ name: "hunter-1", role: "hunter", cwd: dir }, env);
    putAgent(
      {
        ...(getAgent("hunter-1", env) as NonNullable<ReturnType<typeof getAgent>>),
        source: "deployed",
        taskId: "BB-1",
        supervisorPid: process.pid,
        pid: process.pid,
        status: "working",
      },
      env,
    );
    const h = mount();
    await start(h, "worker-session");
    const record = getAgent("hunter-1", env);
    expect(record?.source).toBe("deployed");
    expect(record?.role).toBe("hunter");
    expect(record?.taskId).toBe("BB-1");
    expect(record?.sessionId).toBe("worker-session");
  });
});

describe("swarm extension — /coordinate", () => {
  test("it turns the switch on, joins the roster, and hands the agent its operating brief", async () => {
    const h = mount();
    await h.commands.get("coordinate")?.("", context(h));

    expect(loadSwarmConfig(env).enabled).toBe(true);
    const me = getAgent("coordinator", env);
    expect(me?.role).toBe("coordinator");
    expect(me?.sessionId).toBe("01a1-session");

    // The brief is what makes the coordinating agent start working.
    expect(h.injections).toHaveLength(1);
    expect(h.injections[0]?.deliverAs).toBe("followUp");
    const brief = h.injections[0]?.text ?? "";
    expect(brief).toContain("free_pi_swarm");
    expect(brief).toContain("Deploy a worker only when the work is genuinely independent");
    expect(brief).toContain("Recon first");
    expect(brief).toContain("Verify before you write");

    // And it tells the user what it just did.
    expect(h.notices.join("\n")).toContain("swarm switch ON");
    expect(h.notices.join("\n")).toContain("No crew deployed yet");
  });

  test("the goal argument reaches the brief", async () => {
    const h = mount();
    await h.commands.get("coordinate")?.("hackerone acme — the /v2 API", context(h));
    expect(h.injections[0]?.text).toContain("hackerone acme — the /v2 API");
  });

  test("--crew deploys a recon worker immediately, on the first open task", async () => {
    const h = mount();
    const { addTask } = await import("../src/swarm/store");
    addTask({ id: "BB-1", title: "audit /v2", scope: "api.example.com/v2", by: "tester" }, env);
    await h.commands.get("coordinate")?.("--crew audit acme.example.com", context(h));
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]?.role).toBe("recon");
    expect(h.spawns[0]?.taskId).toBe("BB-1");
    expect(h.spawns[0]?.cwd).toBe(dir);
    expect(h.spawns[0]?.extra).toBe("audit acme.example.com");
    expect(h.notices.join("\n")).toContain("Deployed recon-1");
  });

  test("a deployment that fails is reported, not thrown (the brief still goes out)", async () => {
    const h = mount({ spawnError: "the swarm switch is OFF" });
    await h.commands.get("coordinate")?.("--crew", context(h));
    expect(h.notices.join("\n")).toContain("Could not deploy a recon worker");
    expect(h.injections).toHaveLength(1);
  });

  test("it tells the user when the switch was already on (no silent second 'turn on')", async () => {
    const { saveSwarmConfig } = await import("../src/swarm/store");
    saveSwarmConfig({ enabled: true }, env);
    const h = mount();
    await h.commands.get("coordinate")?.("", context(h));
    expect(h.notices.join("\n")).toContain("already on");
  });
});

describe("swarm extension — /swarm control surface", () => {
  test("status shows the switch, the board and held scopes", async () => {
    const { addTask, claimScope, saveSwarmConfig } = await import("../src/swarm/store");
    saveSwarmConfig({ enabled: true }, env);
    addTask({ id: "BB-1", title: "audit /v2/orders", scope: "api.example.com/v2", by: "tester" }, env);
    claimScope({ scope: "api.example.com/v2", owner: "coordinator", leaseSeconds: 600 }, env);
    const h = mount();
    await start(h);
    await h.commands.get("swarm")?.("status", context(h));
    const text = h.notices.join("\n");
    expect(text).toContain("swarm: ON");
    expect(text).toContain("BB-1");
    expect(text).toContain("api.example.com/v2");
  });

  test("on/off flip the switch", async () => {
    const h = mount();
    await h.commands.get("swarm")?.("on", context(h));
    expect(loadSwarmConfig(env).enabled).toBe(true);
    await h.commands.get("swarm")?.("off", context(h));
    expect(loadSwarmConfig(env).enabled).toBe(false);
    expect(h.notices.join("\n")).toContain("Swarm switch OFF");
  });

  test("stop all asks every live deployed worker to stop, and stop <name> asks one", async () => {
    const { registerSession, putAgent } = await import("../src/swarm/store");
    registerSession({ name: "hunter-1", role: "hunter", cwd: dir }, env);
    // A *live* supervisor pid: this suite is about what happens to a running
    // worker, and a dead supervisor is reconciled to "exited" on the next
    // roster read (covered in swarm.test.ts) rather than being stopped.
    putAgent(
      {
        ...(getAgent("hunter-1", env) as NonNullable<ReturnType<typeof getAgent>>),
        source: "deployed",
        supervisorPid: process.pid,
        pid: process.pid,
        status: "idle",
      },
      env,
    );
    const h = mount();
    await h.commands.get("swarm")?.("stop all", context(h));
    expect(h.stops).toEqual(["hunter-1"]);
    await h.commands.get("swarm")?.("stop hunter-1", context(h));
    expect(h.stops).toEqual(["hunter-1", "hunter-1"]);
  });

  test("an unknown subcommand says what is available", async () => {
    const h = mount();
    await h.commands.get("swarm")?.("frobnicate", context(h));
    expect(h.notices.join("\n")).toContain("Unknown subcommand");
  });

  test("crew deploys the named role onto the first open task", async () => {
    const { addTask, saveSwarmConfig } = await import("../src/swarm/store");
    saveSwarmConfig({ enabled: true }, env);
    addTask({ id: "BB-2", title: "verify the tenant leak", by: "tester" }, env);
    const h = mount();
    await h.commands.get("swarm")?.("crew verifier", context(h));
    expect(h.spawns[0]?.role).toBe("verifier");
    expect(h.spawns[0]?.taskId).toBe("BB-2");
  });
});

describe("swarm extension — lifecycle", () => {
  test("session_shutdown stops the watcher and frees what the session held", async () => {
    const { claimScope } = await import("../src/swarm/store");
    const h = mount();
    await h.commands.get("coordinate")?.("", context(h));
    claimScope({ scope: "api.example.com/v2", owner: "coordinator", leaseSeconds: 600 }, env);

    h.events.get("session_shutdown")?.({ type: "session_shutdown" }, context(h));
    await sleep(50);
    expect(getAgent("coordinator", env)?.status).toBe("exited");
    const { listClaims } = await import("../src/swarm/store");
    expect(listClaims(env)).toHaveLength(0);
    // No further injections once the session is gone.
    const before = h.injections.length;
    sendMail({ from: "scout", to: "coordinator", body: "still there?" }, env);
    await sleep(50);
    expect(h.injections).toHaveLength(before);
  });

  test("a second session takes coordinator-2 rather than colliding with a live coordinator", async () => {
    const h1 = mount();
    const ctx1 = await start(h1);
    await h1.commands.get("coordinate")?.("", ctx1);
    expect(getAgent("coordinator", env)?.sessionId).toBe("01a1-session");

    const h2 = mount();
    const ctx2 = context(h2, "02b2-second");
    // Point the second session at the same state dir with its own name resolution.
    await h2.events.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx2);
    await h2.commands.get("coordinate")?.("", ctx2);
    const names = listAgents(env).map((a) => a.name);
    expect(names).toContain("coordinator");
    expect(names).toContain("coordinator-2");
  });

  test("the state dir it uses is the one it was configured with", async () => {
    const h = mount();
    await h.commands.get("coordinate")?.("", context(h));
    expect(swarmPaths(env).dir).toBe(dir);
    expect(getAgent("coordinator", env)).not.toBeNull();
  });
});

describe("the findings ledger rides in the system prompt", () => {
  test("an active ledger is injected once per turn, and an empty one changes nothing", async () => {
    const h = mount();
    const before = h.events.get("before_agent_start");
    expect(before).toBeDefined();
    const base = { type: "before_agent_start", systemPrompt: "BASE PROMPT" };

    // Nothing recorded yet: a session that is not hunting pays nothing.
    expect(before?.(base, context(h))).toBeUndefined();

    addFinding({ title: "share math rounds in the borrower's favour", by: "tester", target: "twyne", severity: "high" }, env);
    const injected = before?.(base, context(h)) as { systemPrompt?: string } | undefined;
    expect(injected?.systemPrompt).toContain("BASE PROMPT");
    expect(injected?.systemPrompt).toContain(LEDGER_MARKER);
    expect(injected?.systemPrompt).toContain("share math rounds in the borrower's favour");

    // The prompt already carries it: not added a second time.
    expect(before?.({ ...base, systemPrompt: injected?.systemPrompt ?? "" }, context(h))).toBeUndefined();
  });

  test("/coordinate reports the ledger, and --target scopes it to this program", async () => {
    const h = mount();
    addFinding({ title: "kelp row", by: "tester", target: "kelp" }, env);
    addFinding({ title: "twyne row", by: "tester", target: "twyne" }, env);

    await h.commands.get("coordinate")?.("--target twyne audit the delegation math", context(h));
    expect(h.notices.join("\n")).toContain("findings ledger already has 2 row(s)");

    const injected = h.events.get("before_agent_start")?.(
      { type: "before_agent_start", systemPrompt: "BASE PROMPT" },
      context(h),
    ) as { systemPrompt?: string } | undefined;
    expect(injected?.systemPrompt).toContain("twyne row");
    expect(injected?.systemPrompt).not.toContain("kelp row");
  });
});
