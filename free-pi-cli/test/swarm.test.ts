// The swarm's shared state, its tool surface and its CLI, all against a
// throwaway state directory: the switch, the bus, the board, exclusive scope
// claims, the worker cap and the worker brief.
//
// Deliberately no processes here — worker *deployment* (spawning, mail push,
// stopping, cleanup) is exercised in test/swarm-extension.test.ts and against a
// stub freepi by scripts/verify-swarm.sh, so a unit test can never spend
// somebody's free allowance.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Mail,
  SwarmError,
  activeSlotNames,
  addTask,
  bindSlot,
  buildWorkerBrief,
  claimScope,
  claimTask,
  countUnread,
  drainMail,
  finishTask,
  getAgent,
  getTask,
  leaveSwarm,
  listAgents,
  listClaims,
  listTasks,
  loadSwarmConfig,
  peekMail,
  pidAlive,
  putAgent,
  putTask,
  reapSlots,
  registerSession,
  releaseScope,
  roleBrief,
  saveSwarmConfig,
  scopeKey,
  sendMail,
  swarmPaths,
  takeSlot,
} from "../src/swarm/store";
import { SWARM_SPAWN_OPTS, spawnWorker } from "../src/swarm/workers";
import { runSwarmCli, parseSwarmArgs } from "../src/swarm/cli";
import { SWARM_TOOL_NAME, createSwarmTool, runSwarmAction } from "../src/swarm/tool";

let dir = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "free-pi-swarm-"));
  env = { FREEPI_SWARM_DIR: dir, FREEPI_SWARM_AGENT: "tester" };
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // windows can hold a handle briefly
  }
});

function readdirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  return runSwarmCli(argv, { env, cwd: dir, io: { out: (l) => out.push(l), err: (l) => err.push(l) } }).then((code) => ({
    code,
    out: out.join("\n"),
    err: err.join("\n"),
  }));
}

const silentIo = { out: () => {}, err: () => {} };
const toolDeps = () => ({ env, self: () => env.FREEPI_SWARM_AGENT ?? "tester", cwd: () => dir });

describe("swarm — the switch", () => {
  test("a fresh install is OFF: nothing is deployed until the user turns it on", () => {
    expect(loadSwarmConfig(env).enabled).toBe(false);
    expect(loadSwarmConfig(env).maxWorkers).toBe(3);
    expect(readdirOrEmpty(swarmPaths(env).dir)).toHaveLength(0);
  });

  test("`swarm on` / `swarm off` flip it, and the tool's enable/disable agree", async () => {
    expect((await cli(["on"])).code).toBe(0);
    expect(loadSwarmConfig(env).enabled).toBe(true);
    const off = await runSwarmAction({ action: "disable" }, toolDeps());
    expect(off.details.ok).toBe(true);
    expect(loadSwarmConfig(env).enabled).toBe(false);
    const on = await runSwarmAction({ action: "enable" }, toolDeps());
    expect(on.text).toContain("ON");
    expect(loadSwarmConfig(env).enabled).toBe(true);
  });

  test("spawning while OFF is refused with a distinct code, and deploys nothing", () => {
    saveSwarmConfig({ enabled: false }, env);
    let code = 0;
    try {
      spawnWorker({ name: "nope", role: "hunter", cwd: dir }, env);
    } catch (err) {
      code = (err as SwarmError).code;
    }
    expect(code).toBe(3);
    expect(listAgents(env)).toHaveLength(0);
    expect(readdirOrEmpty(swarmPaths(env).slots)).toHaveLength(0);
  });

  test("FREEPI_SWARM_MAX_WORKERS caps the configured maximum", () => {
    saveSwarmConfig({ maxWorkers: 10 }, env);
    expect(loadSwarmConfig({ ...env, FREEPI_SWARM_MAX_WORKERS: "2" }).maxWorkers).toBe(2);
  });

  test("an unknown defaultRole in config.json falls back rather than pointing every worker at nothing", () => {
    saveSwarmConfig({ defaultRole: "not-a-role" }, env);
    expect(loadSwarmConfig(env).defaultRole).toBe("hunter");
  });
});

describe("swarm — the bus", () => {
  test("a message lands in the recipient's inbox, attributed, and reading it archives it", () => {
    registerSession({ name: "scout", role: "recon", cwd: dir }, env);
    const sent = sendMail({ from: "tester", to: "scout", body: "staging host is in scope too" }, env);
    expect(countUnread("scout", env)).toBe(1);
    const inbox = drainMail("scout", env);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.from).toBe("tester");
    expect(inbox[0]?.body).toBe("staging host is in scope too");
    // Moved, not deleted: it stays readable at mail/<name>/read/.
    expect(countUnread("scout", env)).toBe(0);
    expect(readFileSync(join(swarmPaths(env).mail, "scout", "read", `${sent.id}.json`), "utf8")).toContain("staging host");
  });

  test("--keep peeks without marking anything read", () => {
    sendMail({ from: "tester", to: "scout", body: "hello" }, env);
    expect(peekMail("scout", env)).toHaveLength(1);
    expect(countUnread("scout", env)).toBe(1);
  });

  test("mail to a name that is not on the roster still queues (an agent may be about to exist)", async () => {
    const res = await cli(["send", "--to", "not-yet", "anyone home?"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("not on the roster yet");
    expect(countUnread("not-yet", env)).toBe(1);
  });

  test("send --all reaches every other session and never the sender", () => {
    registerSession({ name: "a", role: "hunter", cwd: dir }, env);
    registerSession({ name: "b", role: "verifier", cwd: dir }, env);
    return cli(["send", "--all", "standup: I have the redirect"]).then((res) => {
      expect(res.code).toBe(0);
      expect(countUnread("a", env)).toBe(1);
      expect(countUnread("b", env)).toBe(1);
      expect(countUnread("tester", env)).toBe(0);
    });
  });

  test("a recipient name that would be a path is refused", async () => {
    const res = await cli(["send", "--to", "../../etc/passwd", "hi"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("recipient");
  });

  test("an empty message is refused", async () => {
    const res = await cli(["send", "--to", "scout"]);
    expect(res.code).toBe(1);
  });

  test("the tool's send/inbox/report actions round-trip, and report is a finding broadcast", async () => {
    registerSession({ name: "verifier-1", role: "verifier", cwd: dir }, env);
    await runSwarmAction({ action: "send", to: "verifier-1", body: "please reproduce /v2/orders", kind: "handoff" }, toolDeps());
    const heard = await runSwarmAction({ action: "inbox" }, { env, self: () => "verifier-1", cwd: () => dir });
    expect(heard.text).toContain("please reproduce /v2/orders");
    const report = await runSwarmAction({ action: "report", body: "tenant leak confirmed", scope: "api.example.com/v2" }, toolDeps());
    expect(report.details.summary).toContain("finding broadcast");
    const finding = peekMail("verifier-1", env).find((m) => m.kind === "finding") as Mail;
    expect(finding.body).toContain("[api.example.com/v2] tenant leak confirmed");
  });
});

describe("swarm — the board", () => {
  test("exactly one owner: a second claimer is told who holds it", () => {
    addTask({ id: "BB-1", title: "audit /v2/orders", scope: "api.example.com/v2", by: "tester" }, env);
    claimTask("BB-1", "alpha", 1800, false, env);
    expect(() => claimTask("BB-1", "beta", 1800, false, env)).toThrow(/claimed by alpha/);
    expect(getTask("BB-1", env)?.owner).toBe("alpha");
  });

  test("the owner may renew; a non-owner may not close it", () => {
    addTask({ id: "BB-1", title: "t", by: "tester" }, env);
    const first = claimTask("BB-1", "alpha", 1800, false, env);
    const renewed = claimTask("BB-1", "alpha", 1800, false, env);
    expect(Date.parse(renewed.leaseUntil as string)).toBeGreaterThanOrEqual(Date.parse(first.leaseUntil as string));
    expect(() => finishTask("BB-1", "beta", "done", {}, env)).toThrow(/owned by alpha/);
  });

  test("an expired lease is reclaimable, so a dead session cannot pin a task", () => {
    addTask({ id: "BB-2", title: "t", by: "tester" }, env);
    claimTask("BB-2", "alpha", 1800, false, env);
    const task = getTask("BB-2", env)!;
    putTask({ ...task, leaseUntil: "2000-01-01T00:00:00.000Z" }, env);
    const stolen = claimTask("BB-2", "beta", 1800, false, env);
    expect(stolen.owner).toBe("beta");
    // The take-over is visible on the board itself, not only in the event log.
    const history = stolen.history.map((h) => h.what);
    expect(history.some((what) => what.startsWith("reclaim"))).toBe(true);
    expect(history.join(" ")).toContain("was alpha");
  });

  test("done records the evidence and keeps the history", () => {
    addTask({ id: "BB-3", title: "t", by: "tester" }, env);
    claimTask("BB-3", "alpha", 1800, false, env);
    const done = finishTask("BB-3", "alpha", "done", { evidence: "GET /v2/orders?tenant=2 returns tenant 1 rows" }, env);
    expect(done.status).toBe("done");
    expect(done.evidence).toContain("tenant=2");
    expect(done.history.map((h) => h.what)).toEqual(["created", "claimed", "done"]);
  });

  test("the tool can plan several tasks at once and claim one", async () => {
    const planned = await runSwarmAction(
      {
        action: "plan",
        tasks: [
          { id: "S-1", title: "audit /v2/orders", scope: "api.example.com/v2" },
          { id: "S-2", title: "audit the staging host", scope: "staging.example.com" },
        ],
      },
      toolDeps(),
    );
    expect(planned.text).toContain("S-1");
    expect(listTasks(env)).toHaveLength(2);
    const claimed = await runSwarmAction({ action: "task", op: "claim", id: "S-1" }, toolDeps());
    expect(claimed.details.summary).toBe("claimed S-1");
    const conflict = await runSwarmAction({ action: "task", op: "claim", id: "S-1" }, { env, self: () => "other", cwd: () => dir }).catch((e) => e as SwarmError);
    expect((conflict as SwarmError).code).toBe(4);
  });

  test("a task id that would be a path is refused", () => {
    expect(() => addTask({ id: "../evil", title: "t", by: "tester" }, env)).toThrow(/task id/);
  });
});

describe("swarm — what a deployed worker's own session may do", () => {
  // Running the real binary end to end (a deployed worker boots this same
  // extension, registers itself, and gets the crew tool) found these: without
  // them a live worker disappeared from the crew view the moment it started.
  const deploy = () => {
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
  };

  test("its session registering does not erase the worker's own record", () => {
    deploy();
    const merged = registerSession({ name: "hunter-1", role: "coordinator", cwd: dir, sessionId: "sess-1" }, env);
    expect(merged.source).toBe("deployed");
    expect(merged.role).toBe("hunter");
    expect(merged.taskId).toBe("BB-1");
    expect(merged.status).toBe("working");
    // ...while still taking the details only the session itself knows.
    expect(merged.sessionId).toBe("sess-1");
    const listed = listAgents(env).find((a) => a.name === "hunter-1");
    expect(listed?.source).toBe("deployed");
  });

  test("it is refused the deployment actions, and keeps the board and the bus", async () => {
    deploy();
    const workerDeps = { env: { ...env, FREEPI_SWARM_AGENT: "hunter-1" }, self: () => "hunter-1", cwd: () => dir };
    await expect(runSwarmAction({ action: "spawn", role: "hunter" }, workerDeps)).rejects.toThrow(/coordinating session/);
    await expect(runSwarmAction({ action: "disable" }, workerDeps)).rejects.toThrow(/coordinating session/);
    // The CLI a worker actually talks through refuses the same two actions.
    const spawned = await runSwarmCli(["spawn", "--name", "sibling", "--role", "hunter"], {
      env: { ...env, FREEPI_SWARM_AGENT: "hunter-1" },
      cwd: dir,
      io: silentIo,
    });
    expect(spawned).toBe(3);
    const switched = await runSwarmCli(["off"], { env: { ...env, FREEPI_SWARM_AGENT: "hunter-1" }, cwd: dir, io: silentIo });
    expect(switched).toBe(3);
    expect(loadSwarmConfig(env).enabled).toBe(false);
    // Its own work is untouched: claims, the board and the bus all still work.
    saveSwarmConfig({ enabled: true }, env);
    const reported = await runSwarmAction({ action: "report", body: "tenant leak confirmed" }, workerDeps);
    expect(reported.details.ok).toBe(true);
    const claimed = await runSwarmAction({ action: "claim", scope: "api.example.com/v2" }, workerDeps);
    expect(claimed.details.ok).toBe(true);
  });

  test("a session that merely names itself keeps the whole tool", async () => {
    // FREEPI_SWARM_AGENT is also how a session picks its own name; only a roster
    // record a supervisor created makes it a worker.
    registerSession({ name: "tester", role: "coordinator", cwd: dir }, env);
    saveSwarmConfig({ enabled: true }, env);
    const off = await runSwarmAction({ action: "disable" }, toolDeps());
    expect(off.details.ok).toBe(true);
  });
});

describe("swarm — a deployed worker never opens a window", () => {
  // The whole point of a background crew is that it works while the user does
  // something else: a console window per deployed session would take focus away
  // from whatever they were doing, on every deploy. This is a structural test
  // (the same style as test/no-subagents.test.ts) because the failure mode is
  // an option on a spawn call, which no unit test can observe.
  const source = readFileSync(join(import.meta.dir, "..", "src", "swarm", "workers.ts"), "utf8");
  // Line comments stripped, so prose about spawning (and about `detached`) is
  // never mistaken for a spawn call.
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  test("every spawn in the worker layer is hidden", () => {
    expect(SWARM_SPAWN_OPTS.windowsHide).toBe(true);
    const calls = code.split("spawn(").slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      const options = call.slice(0, 400);
      expect(options).toContain("...SWARM_SPAWN_OPTS");
      expect(options).not.toContain("shell:");
    }
  });

  test("only the supervisor is detached — the session inside it is a plain child", () => {
    expect(code.match(/detached: true/g)?.length).toBe(1);
  });

  test("the stub the end-to-end script deploys is hidden too", () => {
    const stub = readFileSync(join(import.meta.dir, "..", "scripts", "stub-freepi.ts"), "utf8");
    for (const call of stub.split("spawnSync(").slice(1)) {
      expect(call.slice(0, 400)).toContain("windowsHide: true");
    }
  });
});

describe("swarm — scope claims (one tester per target)", () => {
  test("a second claimer is refused and told who holds it; --force takes over deliberately", () => {
    claimScope({ scope: "api.example.com/v2", owner: "alpha", leaseSeconds: 1800 }, env);
    expect(() => claimScope({ scope: "api.example.com/v2", owner: "beta", leaseSeconds: 1800 }, env)).toThrow(/held by alpha/);
    const forced = claimScope({ scope: "api.example.com/v2", owner: "beta", leaseSeconds: 60, force: true }, env);
    expect(forced.owner).toBe("beta");
  });

  test("renewing your own claim extends it, and only the owner (or --force) can release it", () => {
    const first = claimScope({ scope: "github.com/org/repo:auth", owner: "alpha", leaseSeconds: 60 }, env);
    const renewed = claimScope({ scope: "github.com/org/repo:auth", owner: "alpha", leaseSeconds: 600 }, env);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
    expect(() => releaseScope("github.com/org/repo:auth", "beta", false, env)).toThrow(/held by alpha/);
    expect(releaseScope("github.com/org/repo:auth", "alpha", false, env)).toBe(true);
    expect(listClaims(env)).toHaveLength(0);
  });

  test("an expired claim is reclaimable — nobody is stuck behind a dead pid", () => {
    claimScope({ scope: "example.test/wild", owner: "alpha", leaseSeconds: 30 }, env);
    const path = join(swarmPaths(env).claims, scopeKey("example.test/wild"), "claim.json");
    const stored = JSON.parse(readFileSync(path, "utf8")) as { expiresAt: string };
    writeFileSync(path, JSON.stringify({ ...stored, expiresAt: "2000-01-01T00:00:00.000Z" }));
    expect(claimScope({ scope: "example.test/wild", owner: "beta", leaseSeconds: 600 }, env).owner).toBe("beta");
  });

  test("leaving releases everything that session held", () => {
    registerSession({ name: "alpha", role: "hunter", cwd: dir }, env);
    claimScope({ scope: "api.example.com/v2", owner: "alpha", leaseSeconds: 600 }, env);
    addTask({ id: "BB-9", title: "t", by: "alpha" }, env);
    claimTask("BB-9", "alpha", 600, false, env);
    const freed = leaveSwarm("alpha", env);
    expect(freed.scopes).toEqual(["api.example.com/v2"]);
    expect(freed.tasks).toEqual(["BB-9"]);
    expect(listClaims(env)).toHaveLength(0);
    expect(getTask("BB-9", env)?.status).toBe("open");
    expect(getAgent("alpha", env)?.status).toBe("exited");
  });

  test("the CLI exposes claim/release/claims with sensible exit codes", async () => {
    expect((await cli(["claim", "api.example.com/v2", "--ttl", "5"])).code).toBe(0);
    const conflict = await cli(["claim", "api.example.com/v2", "--name", "other"]);
    expect(conflict.code).toBe(4);
    expect(conflict.err).toContain("held by tester");
    const listed = await cli(["claims", "--json"]);
    expect(listed.out).toContain("api.example.com/v2");
    expect((await cli(["release", "api.example.com/v2"])).code).toBe(0);
    expect((await cli(["release", "api.example.com/v2"])).code).toBe(0);
  });
});

describe("swarm — the worker cap", () => {
  test("slots cap the crew; a live supervisor holds its slot", () => {
    saveSwarmConfig({ maxWorkers: 1 }, env);
    const slot = takeSlot("alpha", env);
    expect(slot).toBe(0);
    bindSlot(slot, "alpha", process.pid, env);
    expect(() => takeSlot("beta", env)).toThrow(/worker limit reached/);
  });

  test("a slot reserved by a spawn still in flight is not stolen, but a dead one is reaped", () => {
    saveSwarmConfig({ maxWorkers: 1 }, env);
    takeSlot("alpha", env); // pid null, fresh: reserved
    expect(() => takeSlot("beta", env)).toThrow(/worker limit reached/);
    // Age it past the reservation grace period, as if the spawn died mid-flight.
    writeFileSync(join(swarmPaths(env).slots, "0.json"), JSON.stringify({ index: 0, name: "alpha", pid: null, at: "2000-01-01T00:00:00.000Z" }));
    expect(reapSlots(env)).toEqual([0]);
    expect(takeSlot("beta", env)).toBe(0);
  });

  test("a slot whose pid is gone is reaped, a live one is not", () => {
    bindSlot(0, "alpha", process.pid, env);
    expect(reapSlots(env)).toEqual([]);
    bindSlot(0, "alpha", 999_999_999, env);
    expect(reapSlots(env)).toEqual([0]);
  });

  test("a worker killed without a graceful exit has its scope and task freed on the next roster read", () => {
    registerSession({ name: "hunter-9", role: "hunter", cwd: dir }, env);
    putAgent(
      {
        ...(getAgent("hunter-9", env) as NonNullable<ReturnType<typeof getAgent>>),
        source: "deployed",
        supervisorPid: 999_999_999,
        pid: 999_999_999,
        status: "working",
      },
      env,
    );
    claimScope({ scope: "api.example.com/v2", owner: "hunter-9", leaseSeconds: 1800 }, env);
    addTask({ id: "BB-8", title: "audit /v2/orders", by: "tester" }, env);
    claimTask("BB-8", "hunter-9", 1800, false, env);
    bindSlot(0, "hunter-9", 999_999_999, env);

    // Nothing polls the roster in the background: the repair has to happen on a
    // plain read, which is all a coordinator is guaranteed to do.
    const agents = listAgents(env);
    expect(agents.find((a) => a.name === "hunter-9")?.status).toBe("exited");
    expect(listClaims(env)).toHaveLength(0);
    expect(getTask("BB-8", env)?.status).toBe("open");
    expect(getTask("BB-8", env)?.owner).toBeNull();
    expect(activeSlotNames(env)).toEqual([]);
  });

  test("pidAlive is honest about a pid that cannot exist", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(999_999_999)).toBe(false);
    expect(pidAlive(null)).toBe(false);
  });
});

describe("swarm — the worker brief", () => {
  test("it names the agent and its role, and carries the role's own text", () => {
    const brief = buildWorkerBrief({ name: "hunter-1", role: "hunter", cwd: "/tmp/target" });
    expect(brief).toContain("You are hunter-1, a hunter agent");
    expect(brief).toContain("/tmp/target");
    expect(brief).toContain("You work exactly one claimed scope");
  });

  test("it teaches the bus and the rules of engagement, because a worker has no tool", () => {
    const brief = buildWorkerBrief({ name: "recon-1", role: "recon", cwd: "/tmp/t" });
    expect(brief).toContain("free-pi-cli swarm inbox");
    expect(brief).toContain("free-pi-cli swarm task claim <id>");
    expect(brief).toContain("Never test or edit a scope someone else holds");
    expect(brief).toContain("Stop at the smallest proof");
  });

  test("a task on the brief is spelled out", () => {
    addTask({ id: "BB-7", title: "audit /v2/orders", detail: "start with the tenant filter", scope: "api.example.com/v2", by: "tester" }, env);
    const brief = buildWorkerBrief({ name: "hunter-1", role: "hunter", cwd: dir, task: getTask("BB-7", env) });
    expect(brief).toContain("Task BB-7: audit /v2/orders");
    expect(brief).toContain("start with the tenant filter");
    expect(brief).toContain("Scope: api.example.com/v2");
  });

  test("every shipped role has a brief, and an unknown role degrades rather than throwing", () => {
    for (const role of ["recon", "hunter", "verifier", "scribe"]) expect(roleBrief(role).length).toBeGreaterThan(200);
    expect(roleBrief("nope")).toBe("");
    expect(buildWorkerBrief({ name: "x", role: "nope", cwd: dir })).toContain("You are x, a nope agent");
  });
});

describe("swarm — the tool surface", () => {
  test("the tool is registered under a name the allowlist knows", () => {
    const tool = createSwarmTool(toolDeps());
    expect(tool.name).toBe(SWARM_TOOL_NAME);
    expect(tool.name).toBe("free_pi_swarm");
    expect(tool.description).toContain("SEPARATE free-pi session");
    expect(tool.promptGuidelines?.join(" ")).toContain("never work a scope another session holds");
  });

  test("status reports the switch, the crew, the board and the held scopes", async () => {
    saveSwarmConfig({ enabled: true, maxWorkers: 2 }, env);
    addTask({ id: "BB-1", title: "audit /v2/orders", scope: "api.example.com/v2", by: "tester" }, env);
    claimScope({ scope: "api.example.com/v2", owner: "tester", leaseSeconds: 600 }, env);
    const status = await runSwarmAction({ action: "status" }, toolDeps());
    expect(status.text).toContain("swarm: ON");
    expect(status.text).toContain("board: BB-1");
    expect(status.text).toContain("scopes held: tester → api.example.com/v2");
    expect(status.details.info?.tasks).toBe(1);
  });

  test("status nudges toward the open work rather than leaving the agent idle", async () => {
    addTask({ id: "BB-1", title: "t", by: "tester" }, env);
    const status = await runSwarmAction({ action: "status" }, toolDeps());
    expect(status.text).toContain("hint:");
    expect(status.text).toContain("BB-1");
  });

  test("stop is not gated on the switch: the kill switch always works", async () => {
    saveSwarmConfig({ enabled: false }, env);
    registerSession({ name: "ghost", role: "hunter", cwd: dir }, env);
    const stopped = await runSwarmAction({ action: "stop", all: true }, toolDeps());
    expect(stopped.details.ok).toBe(true);
    expect(stopped.text).toContain("no workers were running");
  });

  test("an unknown/missing required argument fails loudly instead of doing something surprising", async () => {
    await expect(runSwarmAction({ action: "claim" }, toolDeps())).rejects.toThrow(/needs a scope/);
    await expect(runSwarmAction({ action: "send", body: "hi" }, toolDeps())).rejects.toThrow(/recipient/);
    await expect(runSwarmAction({ action: "spawn", role: "hunter" }, { ...toolDeps(), env: { ...env, FREEPI_SWARM_DIR: dir } })).rejects.toThrow(/switch is OFF/);
  });
});

describe("swarm — CLI parsing and help", () => {
  test("a boolean flag never swallows the message", () => {
    const parsed = parseSwarmArgs(["send", "--all", "standup: something"]);
    expect(parsed.command).toBe("send");
    expect(parsed.flags.get("all")).toBe(true);
    expect(parsed.rest).toEqual(["standup: something"]);
  });

  test("value flags still take a value", () => {
    const parsed = parseSwarmArgs(["send", "--to", "scout", "hello"]);
    expect(parsed.flags.get("to")).toBe("scout");
    expect(parsed.rest).toEqual(["hello"]);
  });

  test("--help prints the whole surface", async () => {
    const res = await cli(["--help"]);
    expect(res.code).toBe(0);
    for (const needle of ["swarm inbox", "swarm claim SCOPE", "swarm spawn", "swarm stop", "free-pi-cli swarm"]) {
      expect(res.out).toContain(needle);
    }
  });

  test("an unknown subcommand exits 2 and says so", async () => {
    const res = await cli(["frobnicate"]);
    expect(res.code).toBe(2);
    expect(res.err).toContain("unknown command");
  });

  test("status --json is machine-readable", async () => {
    registerSession({ name: "scout", role: "recon", cwd: dir }, env);
    const res = await cli(["status", "--json"]);
    const parsed = JSON.parse(res.out) as { crew: Array<{ name: string }>; switch: { enabled: boolean } };
    expect(parsed.crew.some((a) => a.name === "scout")).toBe(true);
    expect(parsed.switch.enabled).toBe(false);
  });

  test("the human status view shows the switch, the board and who holds what", async () => {
    saveSwarmConfig({ enabled: true }, env);
    addTask({ id: "BB-1", title: "audit /v2/orders", scope: "api.example.com/v2", by: "tester" }, env);
    claimScope({ scope: "api.example.com/v2", owner: "tester", leaseSeconds: 600 }, env);
    const res = await cli(["status"]);
    expect(res.out).toContain("switch: ON");
    expect(res.out).toContain("BB-1");
    expect(res.out).toContain("api.example.com/v2");
  });

  test("`swarm brief` prints exactly what a worker would be told", async () => {
    const res = await cli(["brief", "--role", "verifier", "--name", "v-1", "--json", "--keep"]);
    // --json is swallowed as a normal flag here; brief always prints human text
    expect(res.code).toBe(0);
    expect(res.out).toContain("You are v-1, a verifier agent");
    expect(res.out).toContain("You exist to disbelieve");
  });

  test("`swarm inbox` reads as the calling session, and every path stays inside the state dir", async () => {
    registerSession({ name: "scout", role: "recon", cwd: dir }, env);
    sendMail({ from: "tester", to: "tester", body: "a note to myself" }, env);
    expect(swarmPaths(env).dir).toBe(dir);
    const res = await runSwarmCli(["inbox"], { env, cwd: dir, io: silentIo });
    expect(res).toBe(0);
    expect(countUnread("tester", env)).toBe(0);
    expect(listTasks(env)).toHaveLength(0);
  });
});
