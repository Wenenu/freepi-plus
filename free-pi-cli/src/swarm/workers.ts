// Deploying a worker, and the supervisor that owns one.
//
// A deployed worker is `free-pi-cli --mode rpc` in its own process: its own
// session, its own lease, its own single-concurrent-completion guarantee. The
// supervisor (`free-pi-cli swarm worker …`) is what makes a worker usable:
// without a process holding its stdin there is nobody to push a teammate's
// message into its turn, so every worker would have to poll for mail.
//
// The supervisor is started detached, so a worker's lifetime is independent of
// the coordinating session's: closing the TUI does not silently kill the crew
// mid-task. It exits when its freepi child exits, when it is told to stop (a
// marker file it polls, plus a SIGTERM fallback), or when its child never comes
// up at all — in which case it says why, releases its slot and releases the
// scopes and tasks it was holding.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertName,
  bindSlot,
  buildWorkerBrief,
  type SwarmConfig,
  type Task,
  drainMail,
  ensureSwarmDir,
  getAgent,
  getTask,
  listAgents,
  loadSwarmConfig,
  logSwarmEvent,
  nowIso,
  pidAlive,
  putAgent,
  releaseHeldBy,
  releaseSlot,
  restoreMail,
  swarmPaths,
  SwarmError,
  takeSlot,
  touchAgent,
} from "./store";

// A spawned supervisor is a *console* process on Windows, so without this it
// would open its own console window and take focus away from whatever the user
// is doing — every time a worker is deployed. Every spawn in this file spreads
// these options, nothing here is ever launched in a visible shell, and
// test/swarm.test.ts asserts both facts so a later edit cannot quietly undo it.
//
// (`detached: true` is only used for the supervisor. On Windows that means
// DETACHED_PROCESS: the child gets no console at all, and windowsHide's
// CREATE_NO_WINDOW covers the inner session, whose stdio is pipes.)
export const SWARM_SPAWN_OPTS = { windowsHide: true } as const;

/**
 * How to start a worker's freepi. Defaults to *this* CLI (`node dist/index.js` /
 * `bun src/index.ts`), which is the only thing guaranteed to be installed.
 * FREEPI_SWARM_CMD overrides it — a wrapper path on a machine that runs the CLI
 * some other way, and the test seam that lets the suite deploy against a stub
 * instead of spending anyone's allowance.
 */
export function workerCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.FREEPI_SWARM_CMD?.trim();
  if (override) return override.split(/\s+/).filter(Boolean);
  const entry = process.argv[1];
  if (!entry) throw new Error("cannot locate the free-pi-cli entry point to deploy a worker");
  return [process.execPath, entry];
}

export interface SpawnRequest {
  name: string;
  role: string;
  cwd: string;
  taskId?: string | null;
  /** Extra instruction appended to the worker's brief. */
  extra?: string;
}

export interface SpawnResult {
  name: string;
  role: string;
  cwd: string;
  pid: number | null;
  slot: number;
  logPath: string;
  taskId: string | null;
}

function cwdAllowed(cwd: string, cfg: SwarmConfig): boolean {
  if (cfg.cwdAllowlist.length === 0) return true;
  const target = resolve(cwd);
  return cfg.cwdAllowlist.some((allowed) => {
    const base = resolve(allowed);
    return target === base || target.startsWith(`${base}/`) || target.startsWith(`${base}\\`);
  });
}

/**
 * The gate the whole feature hangs off. The switch is checked here rather than
 * inside the supervisor, so a box with the swarm merely installed never starts a
 * process at all. Stopping a worker is deliberately not gated on it.
 */
export function assertDeployable(req: SpawnRequest, env: NodeJS.ProcessEnv = process.env): SwarmConfig {
  const cfg = loadSwarmConfig(env);
  if (!cfg.enabled) {
    throw new SwarmError(
      `the swarm switch is OFF, so nothing was deployed. Turn it on with the swarm tool ("enable") or \`free-pi-cli swarm on\`.`,
      3,
    );
  }
  const name = assertName("agent name", req.name);
  const existing = getAgent(name, env);
  if (existing && existing.status !== "exited" && (pidAlive(existing.supervisorPid) || pidAlive(existing.pid))) {
    throw new SwarmError(`an agent named ${name} is already running — stop it first`, 4);
  }
  const cwd = resolve(req.cwd);
  if (!existsSync(cwd)) throw new SwarmError(`working directory does not exist: ${cwd}`);
  if (!cwdAllowed(cwd, cfg)) {
    throw new SwarmError(`working directory ${cwd} is outside cwdAllowlist (${cfg.cwdAllowlist.join(", ")})`, 3);
  }
  return cfg;
}

export function spawnWorker(req: SpawnRequest, env: NodeJS.ProcessEnv = process.env): SpawnResult {
  const cfg = assertDeployable(req, env);
  const name = assertName("agent name", req.name);
  const role = req.role && req.role.trim() ? req.role.trim() : cfg.defaultRole;
  const cwd = resolve(req.cwd);
  if (req.taskId && !getTask(req.taskId, env)) throw new SwarmError(`no task ${req.taskId}`);

  const command = workerCommand(env);
  const program = command[0] as string;
  // A program given as a path that is not there cannot produce a session, and
  // the failure would otherwise arrive asynchronously as a "starting" worker
  // that silently never does anything. Refuse it now, with the path in the
  // message (an MSYS-style `/d/repo/bun` on Windows lands exactly here).
  if (/[\\/]/.test(program) && !existsSync(program)) {
    throw new SwarmError(`cannot start the worker: ${program} does not exist (FREEPI_SWARM_CMD must be a native path)`);
  }

  const slot = takeSlot(name, env);
  ensureSwarmDir(env);
  const logPath = join(swarmPaths(env).logs, `${name}.log`);
  // A first line in the log, so "nothing happened" is never the whole story.
  workerLog(logPath, `starting: ${command.join(" ")}`);
  const args = [
    ...command.slice(1),
    "swarm",
    "worker",
    "--name",
    name,
    "--role",
    role,
    "--cwd",
    cwd,
    ...(req.taskId ? ["--task", req.taskId] : []),
    ...(req.extra ? ["--extra", req.extra] : []),
  ];
  let pid: number | null = null;
  try {
    const child = spawn(command[0] as string, args, {
      ...SWARM_SPAWN_OPTS,
      cwd,
      detached: true,
      stdio: "ignore",
      env: {
        ...env,
        FREEPI_SWARM_AGENT: name,
        FREEPI_SWARM_ROLE: role,
        FREEPI_SWARM_TASK: req.taskId ?? "",
        FREEPI_SWARM_LOG: logPath,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });
    pid = child.pid ?? null;
    // A spawn can still fail after it "succeeds" (a missing interpreter, a
    // permission problem): say so in the log and on the roster instead of
    // leaving a worker that looks deployed and never starts.
    child.on("error", (err) => {
      workerLog(logPath, `could not start ${command.join(" ")}: ${err.message}`);
      const current = getAgent(name, env);
      if (current) putAgent({ ...current, status: "exited", note: `could not start: ${err.message}`, lastSeenAt: nowIso() }, env);
      releaseSlot(name, env);
      logSwarmEvent(env, "worker", { action: "spawn-failed", name, error: err.message });
    });
    child.unref();
    bindSlot(slot, name, pid, env);
  } catch (err) {
    releaseSlot(name, env);
    throw new SwarmError(`could not start the worker supervisor: ${(err as Error).message}`);
  }

  putAgent(
    {
      name,
      role,
      cwd,
      pid,
      supervisorPid: pid,
      sessionId: null,
      sessionFile: null,
      status: "starting",
      taskId: req.taskId ?? null,
      source: "deployed",
      startedAt: nowIso(),
      lastSeenAt: nowIso(),
      note: `slot ${slot}`,
    },
    env,
  );
  logSwarmEvent(env, "worker", { action: "spawn", name, role, pid, slot, task: req.taskId ?? null });
  return { name, role, cwd, pid, slot, logPath, taskId: req.taskId ?? null };
}

/** Ask a worker to stop. Works whether or not the switch is on. */
export function stopWorker(name: string, reason = "stop requested", env: NodeJS.ProcessEnv = process.env): void {
  const agent = getAgent(assertName("agent name", name), env);
  if (!agent) throw new SwarmError(`no agent named ${name}`);
  ensureSwarmDir(env);
  const marker = join(swarmPaths(env).stop, name);
  writeFileSync(marker, `${reason}\n${nowIso()}\n`, { mode: 0o600 });
  logSwarmEvent(env, "worker", { action: "stop", name, reason, supervisorPid: agent.supervisorPid });

  if (!pidAlive(agent.supervisorPid)) {
    // Its supervisor is already gone and can never read the marker, so nothing
    // else would ever release what this agent was holding.
    const freed = releaseHeldBy(name, env);
    releaseSlot(name, env);
    rmSync(marker, { force: true });
    putAgent({ ...agent, status: "exited", note: `supervisor already gone (${reason})`, lastSeenAt: nowIso() }, env);
    logSwarmEvent(env, "worker", { action: "cleanup", name, releasedScopes: freed.scopes, releasedTasks: freed.tasks });
  }
}

export interface SupervisorOptions {
  name: string;
  role: string;
  cwd: string;
  taskId: string | null;
  extra?: string;
}

function workerLog(logPath: string, line: string): void {
  try {
    appendFileSync(logPath, `${nowIso()} ${line}\n`);
  } catch {
    // best effort: a log line must never break a worker
  }
}

/**
 * `free-pi-cli swarm worker …` — the detached half. Owns one freepi RPC child
 * for its whole life: sends the brief, pushes mail into turns, heartbeats the
 * roster, watches for its stop marker, and on the way out releases the scopes
 * and tasks its agent still held so nothing is stuck behind a dead pid.
 */
export async function runWorkerSupervisor(opts: SupervisorOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const name = assertName("agent name", opts.name);
  ensureSwarmDir(env);
  const logPath = env.FREEPI_SWARM_LOG || join(swarmPaths(env).logs, `${name}.log`);
  const log = (line: string): void => workerLog(logPath, line);

  const task: Task | null = opts.taskId ? getTask(opts.taskId, env) : null;
  const brief = buildWorkerBrief({ name, role: opts.role, cwd: opts.cwd, task, extra: opts.extra });
  const command = workerCommand(env);
  log(`worker start role=${opts.role} cwd=${opts.cwd} task=${opts.taskId ?? "-"} (${command.join(" ")} --mode rpc)`);

  const argv = [...command.slice(1), "--mode", "rpc"];
  const proc = spawn(command[0] as string, argv, {
    ...SWARM_SPAWN_OPTS,
    cwd: opts.cwd,
    env: {
      ...env,
      FREEPI_SWARM_AGENT: name,
      FREEPI_SWARM_ROLE: opts.role,
      FREEPI_SWARM_TASK: opts.taskId ?? "",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      TERM: "dumb",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const base = getAgent(name, env);
  putAgent(
    {
      name,
      role: opts.role,
      cwd: opts.cwd,
      pid: proc.pid ?? null,
      supervisorPid: process.pid,
      sessionId: base?.sessionId ?? null,
      sessionFile: base?.sessionFile ?? null,
      status: "starting",
      taskId: opts.taskId,
      source: "deployed",
      startedAt: base?.startedAt ?? nowIso(),
      lastSeenAt: nowIso(),
      note: "worker supervisor up",
    },
    env,
  );

  let seq = 0;
  let streaming = false;
  let stopping = false;
  let turns = 0;
  const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  let finishReason = "";
  let finished = false;
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolvePromise) => {
    resolveExited = resolvePromise;
  });
  const finish = (reason: string): void => {
    if (finished) return;
    finished = true;
    finishReason = reason;
    log(reason);
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
    resolveExited();
  };
  proc.on("exit", (code, signal) => finish(`freepi exited (code ${code}${signal ? `, signal ${signal}` : ""})`));
  proc.on("error", (err) => finish(`could not start ${command.join(" ")}: ${err.message}`));

  const send = (command: Record<string, unknown>, timeoutMs = 120_000): Promise<Record<string, unknown>> => {
    if (finished) return Promise.reject(new Error(finishReason || "the agent has exited"));
    const id = `w${++seq}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no response to ${String(command.type)} within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: resolvePromise, reject, timer });
      try {
        proc.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  let carry = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    carry += chunk.toString("utf8");
    let index: number;
    while ((index = carry.indexOf("\n")) !== -1) {
      let line = carry.slice(0, index);
      carry = carry.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = evt.type as string | undefined;
      if (type === "response") {
        const id = evt.id as string | undefined;
        const p = id ? pending.get(id) : undefined;
        if (p && id) {
          pending.delete(id);
          clearTimeout(p.timer);
          p.resolve(evt);
        }
        if (evt.command === "get_state" && evt.data) {
          const data = evt.data as Record<string, unknown>;
          touchAgent(
            name,
            {
              sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
              sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : null,
            },
            env,
          );
        }
        if (evt.command === "prompt" && evt.success === true) streaming = true;
        if (evt.command === "abort") streaming = false;
      } else if (type === "turn_start" || type === "agent_start") {
        streaming = true;
        touchAgent(name, { status: "working" }, env);
      } else if (type === "turn_end" || type === "agent_settled") {
        streaming = false;
        turns += 1;
        touchAgent(name, { status: "idle" }, env);
      }
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => log(`stderr: ${chunk.toString("utf8").trim()}`));

  // Every handshake step races the child's exit, so a worker whose freepi cannot
  // start reports why and frees its slot in about a second instead of blocking
  // for a full command timeout while still claiming to be fine.
  const ended = exited.then(() => null);
  const trySend = async (command: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> => {
    try {
      return await Promise.race([send(command, timeoutMs), ended]);
    } catch (err) {
      log(`${String(command.type)} failed: ${(err as Error).message}`);
      return null;
    }
  };

  const state = await trySend({ type: "get_state" }, 30_000);
  if (state?.data) {
    const data = state.data as Record<string, unknown>;
    touchAgent(
      name,
      {
        sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
        sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : null,
        status: "idle",
      },
      env,
    );
  }
  await trySend({ type: "set_session_name", name: `swarm:${opts.role}:${name}` }, 15_000);

  if (finished) log("freepi never came up — skipping the brief");
  else {
    const res = await trySend({ type: "prompt", message: brief }, 120_000);
    if (res?.success === false) log(`the brief was rejected: ${JSON.stringify(res).slice(0, 300)}`);
    else if (res) log("brief sent");
  }

  const pollMs = Number(env.FREEPI_SWARM_MAIL_POLL_MS ?? 2_000);
  const tick = setInterval(() => {
    void (async () => {
      if (stopping) return;
      touchAgent(name, { status: streaming ? "working" : "idle" }, env);

      if (existsSync(join(swarmPaths(env).stop, name))) {
        stopping = true;
        log("stop requested by the swarm");
        try {
          proc.stdin?.end();
        } catch {
          // already closed
        }
        setTimeout(() => {
          if (!finished && !proc.killed) proc.kill("SIGTERM");
        }, 3_000).unref?.();
        return;
      }

      const fresh = drainMail(name, env);
      if (fresh.length === 0) return;
      const text = [
        `${FINDING_HEADER}`,
        ...fresh.map((mail) => `[from ${mail.from}${mail.kind !== "note" ? `, ${mail.kind}` : ""}${mail.subject ? `: ${mail.subject}` : ""}] ${mail.body}`),
        "(Answer with the swarm CLI from bash; `free-pi-cli swarm send --to <name> \"…\"`.)",
      ].join("\n");
      log(`delivering ${fresh.length} message(s) from the bus`);
      try {
        if (streaming) await send({ type: "steer", message: text }, 60_000);
        else await send({ type: "prompt", message: text }, 60_000);
      } catch (err) {
        log(`delivery failed, leaving it for \`swarm inbox\`: ${(err as Error).message}`);
        for (const mail of fresh) restoreMail(mail, env);
      }
    })();
  }, Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 2_000);

  await exited;
  clearInterval(tick);
  const freed = releaseHeldBy(name, env);
  releaseSlot(name, env);
  touchAgent(name, { status: "exited", note: finishReason || "freepi exited" }, env);
  rmSync(join(swarmPaths(env).stop, name), { force: true });
  log(`worker finished: released ${freed.scopes.length} scope(s), ${freed.tasks.length} task(s), ${turns} turn(s)`);
  return 0;
}

export const FINDING_HEADER = "[free-pi-swarm] new messages from your teammates:";

/** One line for the coordinator's footer and for `swarm status`. */
export function crewSummary(env: NodeJS.ProcessEnv = process.env): string {
  const agents = listAgents(env);
  const live = agents.filter((a) => a.source === "deployed" && a.status !== "exited");
  const working = live.filter((a) => a.status === "working").length;
  const idle = live.filter((a) => a.status !== "working").length;
  const cfg = loadSwarmConfig(env);
  if (live.length === 0) return cfg.enabled ? `swarm on · no crew (max ${cfg.maxWorkers})` : "swarm off";
  return `crew ${live.length}/${cfg.maxWorkers}: ${working} working, ${idle} idle`;
}

