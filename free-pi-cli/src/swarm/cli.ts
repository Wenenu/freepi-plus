// `free-pi-cli swarm …` — the swarm from a shell.
//
// This is the interface every session can use, including deployed workers that
// have only bash: it is what the worker brief tells an agent to run, and it is
// the daemon-free half of the feature (roster, bus, board, scope claims, and the
// switch all work with no server and no service running). It contacts nothing
// and needs no sign-in, so it is dispatched before the run() flow and never
// spends allowance.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addFinding,
  getFinding,
  listFindings,
  nextFindingAction,
  renderLedgerDigest,
  setFindingStatus,
  statusLine,
} from "./ledger";
import {
  MAIL_KINDS,
  type MailKind,
  addTask,
  assertName,
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
  registerSession,
  releaseScope,
  roleBrief,
  saveSwarmConfig,
  sendMail,
  selfAgentName,
  SwarmError,
  swarmDir,
  swarmPaths,
  activeSlotNames,
  reapSlots,
} from "./store";
import { crewSummary, runWorkerSupervisor, spawnWorker, stopWorker } from "./workers";

export const SWARM_HELP = `
free-pi-cli swarm — coordinate several free-pi sessions on one target (bug bounties).

  swarm status [--json]              switch, crew, board, scope claims, unread mail
  swarm on | off                     the deployment switch (spawns nothing by itself)
  swarm roster [--json]              who is on this target
  swarm register --name N [--role R] join the roster as this session
  swarm leave                        leave, releasing your scope claims and tasks

  swarm send --to NAME "text"        message one session   (--kind finding|question|answer|handoff|alert|note)
  swarm send --all "text"            message every session
  swarm inbox [--json] [--keep]      read your mail (--keep peeks without marking it read)
  swarm watch [--interval N]         print messages as they arrive

  swarm task list [--json]           the board
  swarm task add --title "…" [--id ID] [--scope S] [--role R] [--detail "…"]
  swarm task claim ID                take it (exactly one owner; exit 4 if someone holds it)
  swarm task done ID [--evidence "…"] | fail ID [--result "…"] | block ID [--result "…"]

  swarm finding add --title "…" [--target T] [--severity S] [--location "path:line"] [--invariant "…"]
                                     the ledger: what you suspect, and the invariant you believe is broken
  swarm finding list [--json]        every row, with the evidence each state required
  swarm finding status ID STATE [--evidence "…"] [--impact "…"] [--invariant "…"] [--killed "…"]
                                     lead | testing | poc | proven | dead | duplicate — the evidence is required
  swarm finding next                 the single next thing to do, chosen so money comes before curiosity

  swarm claim SCOPE [--ttl MIN]      exclusive rights to a host/URL/repo — one tester per target
  swarm release SCOPE                hand it back
  swarm claims [--json]              what is held, and by whom

  swarm spawn --name N --role R [--task ID] [--cwd DIR] [--extra "…"]   deploy a worker session
  swarm stop NAME | --all            stop workers (works even with the switch off)
  swarm reap                         free slots whose worker died
  swarm brief --role R [--task ID]   print exactly what a worker would be told
  swarm worker …                     (internal: the supervisor one deployed worker runs as)

State: ~/.free-pi/swarm (override with FREEPI_SWARM_DIR)
`.trim();

interface Parsed {
  command: string;
  flags: Map<string, string | boolean>;
  rest: string[];
}

/** Flags that never take a value, so `send --all "text"` keeps the text as text. */
const BOOLEAN_FLAGS = new Set(["json", "all", "force", "keep", "peek", "help", "dry-run"]);

export function parseSwarmArgs(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | boolean>();
  const rest: string[] = [];
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token.startsWith("--")) {
      const [key, inline] = token.slice(2).split("=", 2);
      if (!key) continue;
      if (inline !== undefined) flags.set(key, inline);
      else if (BOOLEAN_FLAGS.has(key)) flags.set(key, true);
      else if (argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith("--")) flags.set(key, argv[++i] as string);
      else flags.set(key, true);
    } else if (!command) command = token;
    else rest.push(token);
  }
  return { command, flags, rest };
}

function boolFlag(args: Parsed, key: string, fallback = false): boolean {
  const value = args.flags.get(key);
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function strFlag(args: Parsed, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function textOf(args: Parsed): string {
  return (strFlag(args, "message") ?? strFlag(args, "body") ?? args.rest.join(" ")).trim();
}

/** A roster record that a supervisor deployed — as opposed to a plain session. */
function isDeployedWorker(name: string, env: NodeJS.ProcessEnv): boolean {
  return getAgent(name, env)?.source === "deployed";
}

export interface SwarmCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface SwarmCliOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  io?: SwarmCliIo;
}

function humanStatus(env: NodeJS.ProcessEnv, me: string): string {
  const cfg = loadSwarmConfig(env);
  const agents = listAgents(env);
  const crew = agents.filter((a) => a.source === "deployed" && a.status !== "exited");
  const tasks = listTasks(env);
  const claims = listClaims(env);
  const lines = [
    `swarm — ${swarmDir(env)}`,
    `  switch: ${cfg.enabled ? "ON " : "OFF"} (max ${cfg.maxWorkers} workers, default role ${cfg.defaultRole}, lease ${Math.round(cfg.leaseSeconds / 60)} min)`,
    `  slots:  ${activeSlotNames(env).length}/${cfg.maxWorkers} in use`,
    `  you:    ${me}${countUnread(me, env) ? ` (${countUnread(me, env)} unread)` : ""}`,
  ];
  if (crew.length === 0) lines.push("  crew:   none deployed");
  else {
    lines.push("  crew:");
    for (const agent of crew) {
      lines.push(
        `    ${agent.name.padEnd(14)} ${agent.role.padEnd(9)} ${agent.status.padEnd(8)} ${
          pidAlive(agent.supervisorPid) ? `pid ${agent.pid ?? "-"}` : "supervisor gone"
        }${agent.taskId ? ` · ${agent.taskId}` : ""}`,
      );
    }
  }
  const others = agents.filter((a) => a.source === "session" && a.name !== me && a.status !== "exited");
  if (others.length) lines.push(`  sessions: ${others.map((a) => a.name).join(", ")}`);
  const exited = agents.filter((a) => a.status === "exited");
  if (exited.length) lines.push(`  exited: ${exited.map((a) => a.name).join(", ")}`);
  lines.push(
    `  board:  ${tasks.length === 0 ? "empty" : `${tasks.filter((t) => t.status === "open").length} open, ${tasks.filter((t) => t.status === "claimed").length} claimed, ${tasks.filter((t) => t.status === "done").length} done`}`,
  );
  for (const task of tasks) {
    lines.push(`    ${task.id.padEnd(12)} ${task.status.padEnd(8)} ${(task.owner ?? "-").padEnd(14)} ${task.title}${task.scope ? `  [${task.scope}]` : ""}`);
  }
  if (claims.length === 0) lines.push("  scopes: none held — claim one before testing anything");
  else for (const claim of claims) lines.push(`  scopes: ${claim.owner.padEnd(14)} ${claim.scope} (until ${claim.expiresAt})`);
  return lines.join("\n");
}

/**
 * Returns the process exit code: 0 ok, 1 error, 3 refused because the switch is
 * off, 4 a conflict (somebody else holds it, or the worker limit is reached).
 */
export async function runSwarmCli(argv: readonly string[], opts: SwarmCliOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const io = opts.io ?? { out: (line: string) => console.log(line), err: (line: string) => console.error(line) };
  const args = parseSwarmArgs(argv);
  const json = boolFlag(args, "json");
  const me = assertName("agent name", strFlag(args, "name") ?? strFlag(args, "from") ?? selfAgentName(env));
  // Who is *calling* is a different question from `--name`, which is the target
  // of `spawn`/`stop`. Only the former decides whether this process is a
  // deployed worker (and so whether the spend actions are its to take).
  const caller = assertName("agent name", selfAgentName(env));
  const print = (value: unknown, human?: string): void => {
    if (json) io.out(JSON.stringify(value, null, 2));
    else if (human !== undefined) io.out(human);
  };

  try {
    // `swarm --help` is a flag, not a command: it must print the surface rather
    // than falling through to the default `status` view.
    if (boolFlag(args, "help") || args.command === "-h") {
      io.out(SWARM_HELP);
      return 0;
    }

    switch (args.command || "status") {
      case "help":
      case "-h":
        io.out(SWARM_HELP);
        return 0;

      case "on":
      case "off": {
        // The switch is the coordinator's: a deployed worker must not be able to
        // turn deployments off (or on) for the whole crew. Who is a worker comes
        // from the roster, so a plain session that names itself keeps the switch.
        if (isDeployedWorker(caller, env) && !boolFlag(args, "force")) {
          io.err(
            `free-pi-cli swarm: the switch belongs to the coordinating session (${caller} is a deployed worker); pass --force to override deliberately`,
          );
          return 3;
        }
        const cfg = saveSwarmConfig({ enabled: args.command === "on" }, env);
        print({ ok: true, enabled: cfg.enabled, maxWorkers: cfg.maxWorkers, config: swarmPaths(env).config }, `swarm switch ${cfg.enabled ? "ON" : "OFF"} (${swarmPaths(env).config})`);
        return 0;
      }

      case "status": {
        if (json) {
          print({
            switch: loadSwarmConfig(env),
            crew: listAgents(env),
            tasks: listTasks(env),
            claims: listClaims(env),
            unread: Object.fromEntries(listAgents(env).map((a) => [a.name, countUnread(a.name, env)])),
            stateDir: swarmDir(env),
          });
        } else io.out(humanStatus(env, me));
        return 0;
      }

      case "register": {
        const record = registerSession({ name: me, role: strFlag(args, "role") ?? "hunter", cwd }, env);
        print({ ok: true, agent: record }, `${record.name} is on the roster as ${record.role} (unread: ${countUnread(record.name, env)})`);
        return 0;
      }

      case "leave": {
        const freed = leaveSwarm(me, env);
        print({ ok: true, name: me, releasedScopes: freed.scopes, releasedTasks: freed.tasks }, `${me} left the swarm (released ${freed.scopes.length} scope(s), ${freed.tasks.length} task(s))`);
        return 0;
      }

      case "roster": {
        const agents = listAgents(env);
        if (json) print({ agents });
        else if (agents.length === 0) io.out("nobody is on the roster");
        else for (const a of agents) io.out(`${a.name.padEnd(16)} ${a.role.padEnd(10)} ${a.status.padEnd(8)} ${a.source}${a.taskId ? ` · ${a.taskId}` : ""}${countUnread(a.name, env) ? ` · ${countUnread(a.name, env)} unread` : ""}`);
        return 0;
      }

      case "send": {
        const body = textOf(args);
        if (!body) throw new SwarmError("nothing to send");
        const kind = (strFlag(args, "kind") ?? "note") as MailKind;
        if (!MAIL_KINDS.includes(kind)) throw new SwarmError(`unknown kind "${kind}" (${MAIL_KINDS.join(", ")})`);
        const subject = strFlag(args, "subject") ?? "";
        const taskId = strFlag(args, "task") ?? null;
        if (boolFlag(args, "all")) {
          const others = listAgents(env).filter((a) => a.name !== me && a.status !== "exited").map((a) => a.name);
          const sent = others.map((to) => sendMail({ from: me, to, body, kind, subject, taskId }, env));
          print({ ok: true, sent: sent.map((m) => ({ id: m.id, to: m.to })) }, others.length ? `told ${others.length}: ${others.join(", ")}` : "nobody else is on the roster");
          return 0;
        }
        const to = strFlag(args, "to") ?? args.rest[0];
        if (!to) throw new SwarmError("need --to NAME (or --all)");
        const mail = sendMail({ from: me, to, body, kind, subject, taskId }, env);
        print({ ok: true, mail }, `sent to ${mail.to}${getAgent(mail.to, env) ? "" : " (not on the roster yet — it will be waiting in their inbox)"}`);
        return 0;
      }

      case "inbox": {
        const keep = boolFlag(args, "keep") || boolFlag(args, "peek");
        const messages = keep ? peekMail(me, env) : drainMail(me, env);
        if (json) print({ agent: me, count: messages.length, messages });
        else if (messages.length === 0) io.out(`no new mail for ${me}`);
        else
          for (const m of messages) {
            io.out(`── ${m.ts}  from ${m.from}  [${m.kind}]${m.subject ? ` ${m.subject}` : ""}${m.taskId ? ` (task ${m.taskId})` : ""}`);
            io.out(m.body);
            io.out("");
          }
        return 0;
      }

      case "watch": {
        const interval = Math.max(1, Number(strFlag(args, "interval") ?? 3)) * 1000;
        io.out(`watching ${me}'s inbox every ${interval / 1000}s (ctrl-c to stop)`);
        const seen = new Set(peekMail(me, env).map((m) => m.id));
        await new Promise<void>((resolvePromise) => {
          const timer = setInterval(() => {
            for (const mail of peekMail(me, env)) {
              if (seen.has(mail.id)) continue;
              seen.add(mail.id);
              io.out(`── ${mail.ts}  from ${mail.from}  [${mail.kind}]`);
              io.out(mail.body);
              io.out("");
            }
          }, interval);
          const stop = () => {
            clearInterval(timer);
            resolvePromise();
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        return 0;
      }

      case "task": {
        const sub = args.rest[0] ?? "list";
        if (sub === "list") {
          const tasks = listTasks(env);
          if (json) print({ tasks });
          else if (tasks.length === 0) io.out("the board is empty");
          else for (const t of tasks) io.out(`${t.id.padEnd(12)} ${t.status.padEnd(8)} ${(t.owner ?? "-").padEnd(14)} ${t.title}${t.scope ? `  [${t.scope}]` : ""}${t.evidence ? `\n             evidence: ${t.evidence.slice(0, 120)}` : ""}`);
          return 0;
        }
        if (sub === "add") {
          const title = strFlag(args, "title") ?? args.rest.slice(1).join(" ");
          if (!title) throw new SwarmError("need --title");
          const task = addTask(
            {
              id: strFlag(args, "id"),
              title,
              detail: strFlag(args, "detail") ?? "",
              role: strFlag(args, "role") ?? null,
              scope: strFlag(args, "scope") ?? null,
              by: me,
            },
            env,
          );
          print({ ok: true, task }, `added ${task.id}: ${task.title}`);
          return 0;
        }
        const id = args.rest[1] ?? strFlag(args, "id");
        if (!id) throw new SwarmError(`need a task id: swarm task ${sub} <id>`);
        if (sub === "claim") {
          const task = claimTask(id, me, loadSwarmConfig(env).leaseSeconds, boolFlag(args, "force"), env);
          print({ ok: true, task }, `you own ${task.id} until ${task.leaseUntil}`);
          return 0;
        }
        if (sub === "done" || sub === "fail" || sub === "block") {
          const status = sub === "done" ? "done" : sub === "fail" ? "failed" : "blocked";
          const task = finishTask(id, me, status, { evidence: strFlag(args, "evidence"), result: strFlag(args, "result") ?? textOf(args) }, env);
          print({ ok: true, task }, `${task.id} is ${task.status}`);
          return 0;
        }
        throw new SwarmError(`unknown task action "${sub}"`);
      }

      case "finding": {
        const sub = args.rest[0] ?? "list";
        if (sub === "add") {
          const title = strFlag(args, "title") ?? args.rest.slice(1).join(" ");
          if (!title) throw new SwarmError("need --title");
          const finding = addFinding(
            {
              id: strFlag(args, "id"),
              title,
              by: me,
              target: strFlag(args, "target"),
              severity: strFlag(args, "severity"),
              location: strFlag(args, "location"),
              invariant: strFlag(args, "invariant"),
              impact: strFlag(args, "impact"),
              evidence: strFlag(args, "evidence"),
              status: strFlag(args, "status"),
            },
            env,
          );
          print({ ok: true, finding }, `${finding.id} ${finding.status} (${finding.severity}) ${finding.title}`);
          return 0;
        }
        if (sub === "list" || sub === "ledger") {
          const findings = listFindings(env);
          const target = strFlag(args, "target");
          const rows = target ? findings.filter((f) => f.target === target) : findings;
          if (json) print({ findings: rows });
          else if (rows.length === 0) io.out("the ledger is empty — nothing has been tested yet");
          else {
            io.out(`${rows.length} finding(s): ${statusLine(rows)}`);
            for (const f of rows) {
              io.out(`${f.id.padEnd(6)} ${f.status.padEnd(9)} ${f.severity.padEnd(8)} ${f.title}${f.location ? `  [${f.location}]` : ""}`);
              if (f.evidence) io.out(`       evidence: ${f.evidence}`);
              if (f.impact) io.out(`       impact:   ${f.impact}`);
              if (f.killed) io.out(`       killed:   ${f.killed}`);
              if (f.duplicateOf) io.out(`       dup of:   ${f.duplicateOf}`);
            }
          }
          return 0;
        }
        if (sub === "digest") {
          const text = renderLedgerDigest(listFindings(env), { target: strFlag(args, "target") });
          io.out(text === "" ? "the ledger is empty" : text);
          return 0;
        }
        if (sub === "next" || sub === "todo") {
          const step = nextFindingAction(listFindings(env), { target: strFlag(args, "target") });
          print({ ok: true, next: step.finding, reason: step.reason, action: step.action }, step.action);
          return 0;
        }
        const id = args.rest[1] ?? strFlag(args, "id");
        if (sub === "show") {
          if (!id) throw new SwarmError("need a finding id: swarm finding show <id>");
          const finding = getFinding(id, env);
          if (!finding) throw new SwarmError(`no finding ${id} in the ledger`, 3);
          print({ ok: true, finding }, JSON.stringify(finding, null, 2));
          return 0;
        }
        if (sub === "status") {
          const status = args.rest[2] ?? strFlag(args, "status");
          if (!id || !status) {
            throw new SwarmError('usage: swarm finding status ID lead|testing|poc|proven|dead|duplicate [--evidence "…"]');
          }
          const finding = setFindingStatus(
            {
              id,
              status,
              by: me,
              evidence: strFlag(args, "evidence"),
              impact: strFlag(args, "impact"),
              invariant: strFlag(args, "invariant"),
              killed: strFlag(args, "killed"),
              duplicateOf: strFlag(args, "duplicate-of"),
              severity: strFlag(args, "severity"),
              title: strFlag(args, "title"),
              location: strFlag(args, "location"),
              target: strFlag(args, "target"),
            },
            env,
          );
          print(
            { ok: true, finding },
            `${finding.id} is ${finding.status} (${finding.severity}) ${finding.title}`,
          );
          return 0;
        }
        throw new SwarmError(`unknown finding action "${sub}" (add, list, show, status, next, digest)`);
      }

      case "claim": {
        const scope = strFlag(args, "scope") ?? args.rest[0];
        if (!scope) throw new SwarmError("need a scope (a host, URL, repo or path)");
        const ttl = Number(strFlag(args, "ttl") ?? Math.round(loadSwarmConfig(env).leaseSeconds / 60));
        const claim = claimScope(
          {
            scope,
            owner: me,
            leaseSeconds: (Number.isFinite(ttl) && ttl > 0 ? ttl : 30) * 60,
            force: boolFlag(args, "force"),
            taskId: strFlag(args, "task") ?? null,
          },
          env,
        );
        print({ ok: true, claim }, `you hold '${claim.scope}' until ${claim.expiresAt} — nobody else will work it`);
        return 0;
      }

      case "release": {
        const scope = strFlag(args, "scope") ?? args.rest[0];
        if (!scope) throw new SwarmError("need a scope to release");
        const released = releaseScope(scope, me, boolFlag(args, "force"), env);
        print({ ok: true, released }, released ? `released '${scope}'` : `nothing was holding '${scope}'`);
        return 0;
      }

      case "claims": {
        const claims = listClaims(env);
        if (json) print({ claims });
        else if (claims.length === 0) io.out("no scopes are held");
        else for (const c of claims) io.out(`${c.owner.padEnd(16)} ${c.scope}  until ${c.expiresAt}${c.taskId ? ` (task ${c.taskId})` : ""}`);
        return 0;
      }

      case "spawn": {
        // Only the coordinating session decides who gets deployed: every worker
        // is a separate session spending its own allowance, and a worker
        // spawning siblings would turn a planned crew into an unbounded one.
        if (isDeployedWorker(caller, env) && !boolFlag(args, "force")) {
          io.err(
            `free-pi-cli swarm: only the coordinating session deploys workers (${caller} is a deployed worker); report on the bus with \`swarm send\` instead, and pass --force to override deliberately`,
          );
          return 3;
        }
        const cfg = loadSwarmConfig(env);
        const role = strFlag(args, "role") ?? cfg.defaultRole;
        const name = strFlag(args, "name") ?? `${role}-${Date.now().toString(36).slice(-4)}`;
        const result = spawnWorker(
          {
            name,
            role,
            cwd: strFlag(args, "cwd") ?? cwd,
            taskId: strFlag(args, "task") ?? null,
            extra: strFlag(args, "extra"),
          },
          env,
        );
        print({ ok: true, ...result }, `deployed ${result.name} (${role}) — pid ${result.pid ?? "?"}, slot ${result.slot}, log ${result.logPath}`);
        return 0;
      }

      case "stop": {
        if (boolFlag(args, "all")) {
          const names = listAgents(env)
            .filter((a) => a.source === "deployed" && a.status !== "exited")
            .map((a) => a.name);
          for (const name of names) stopWorker(name, "swarm stop --all", env);
          print({ ok: true, stopping: names }, names.length ? `asked ${names.length} worker(s) to stop: ${names.join(", ")}` : "no workers were running");
          return 0;
        }
        const name = strFlag(args, "name") ?? args.rest[0];
        if (!name) throw new SwarmError("need a name or --all");
        stopWorker(assertName("agent name", name), "swarm stop", env);
        print({ ok: true, name }, `${name} was asked to stop (it releases its scopes and tasks as it exits)`);
        return 0;
      }

      case "reap": {
        const freed = reapSlots(env);
        print({ ok: true, freed }, `freed ${freed.length} slot(s)`);
        return 0;
      }

      case "brief": {
        const role = strFlag(args, "role") ?? loadSwarmConfig(env).defaultRole;
        const taskId = strFlag(args, "task");
        const task = taskId ? getTask(taskId, env) : null;
        const { buildWorkerBrief } = await import("./store");
        io.out(buildWorkerBrief({ name: me, role, cwd, task, extra: strFlag(args, "extra") }));
        return 0;
      }

      case "roles": {
        for (const role of ["recon", "hunter", "verifier", "scribe"]) io.out(`${role}: ${roleBrief(role).split("\n")[0]?.replace(/^#\s*/, "") ?? ""}`);
        io.out(crewSummary(env));
        return 0;
      }

      case "worker": {
        const name = strFlag(args, "name");
        if (!name) throw new SwarmError("worker needs --name (it is started by `swarm spawn`)");
        return await runWorkerSupervisor(
          {
            name,
            role: strFlag(args, "role") ?? loadSwarmConfig(env).defaultRole,
            cwd: strFlag(args, "cwd") ?? cwd,
            taskId: strFlag(args, "task") ?? null,
            extra: strFlag(args, "extra"),
          },
          env,
        );
      }

      default:
        io.err(`free-pi-cli swarm: unknown command "${args.command}"\n\n${SWARM_HELP}`);
        return 2;
    }
  } catch (err) {
    const e = err as SwarmError;
    io.err(`free-pi-cli swarm: ${e.message}`);
    return typeof e.code === "number" && e.code > 0 ? e.code : 1;
  }
}

/** Read one of this CLI's own config files, used by /swarm to show where things live. */
export function readSwarmStateFile(env: NodeJS.ProcessEnv, name: string): string | null {
  try {
    return readFileSync(join(swarmDir(env), name), "utf8");
  } catch {
    return null;
  }
}
