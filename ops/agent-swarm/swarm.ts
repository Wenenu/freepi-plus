#!/usr/bin/env bun
/**
 * swarm.ts — deploy freepi subagents, and let freepi sessions talk to each other.
 *
 * WHY THIS IS OUT-OF-TREE, AND WHAT A "SUBAGENT" IS HERE
 *
 * free-pi-cli deliberately ships with no subagent capability: its extension list
 * is closed, `packages: []`, the SDK `tools` allowlist is exactly SAFE_TOOLS plus
 * four custom tools, and two tests (test/no-subagents.test.ts, SB1 structural +
 * SB2 dynamic) fail if that ever changes. The reason is the business model —
 * inference is ad-funded, one session holds one lease, and the server-side lease
 * (R19) is the backstop — so N concurrent model calls inside one session is
 * exactly the thing the distro refuses to allow. AGENTS.md adds that
 * free-pi-cli is a generated one-way mirror: hand edits to src/ are overwritten
 * by the next sync, which refuses to run when it finds them.
 *
 * So this file adds nothing to the CLI. A subagent is a *separate* headless
 * session — `freepi --mode rpc` in its own process, with its own lease, its own
 * credential selection and its own single-concurrent-completion guarantee. That
 * is the same mechanism pi's own examples/extensions/subagent uses ("spawns a
 * separate `pi` process for each subagent invocation"), and it is what
 * `--mode rpc` + `--session` in this repo make possible.
 *
 * Session-to-session communication is a filesystem bus, not a broker: sessions
 * are separate processes that may be attached to a TUI, a browser panel or
 * nothing at all, and mail that survives restarts and is readable with `cat` is
 * worth more here than a socket. Every session — human-driven or deployed —
 * coordinates by running the `swarm` CLI from bash (bash is in SAFE_TOOLS, so
 * this needs no new tool registration and trips no allowlist).
 *
 *   swarm rosters / mail / tasks / scope-claims   need NO daemon: plain files.
 *   deploying and steering workers needs the supervisor this file also is:
 *     `swarm spawn` starts `swarm worker` (detached) which owns one RPC child.
 *   the web UI (`swarm serve`) is a viewer plus the on/off switch.
 *
 * THE TOGGLE. config.json's `enabled` is authoritative and gates *deployment*
 * only (spawn/up and the UI switch). It never gates the off-switch: `down`,
 * `stop`, `kill` and mail always work, because a kill switch you cannot use with
 * the feature disabled is not a kill switch. Default is off, so a box with this
 * installed deploys nothing until someone flips it.
 *
 * SECURITY. The service starts processes and reads agent output, so it binds
 * loopback only, requires a token (0600, never printed) for every /api route,
 * checks same-origin on mutations, validates every name against a strict charset
 * before it becomes a path, and refuses a worker cwd outside `cwdAllowlist`
 * unless that list is empty (an empty list means "any directory", which is only
 * sane because the service is loopback + token-gated).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const ENV = process.env;
const STATE_DIR = resolve(ENV.SWARM_STATE_DIR ?? join(homedir(), ".free-pi", "swarm"));
const CONFIG_PATH = ENV.SWARM_CONFIG ?? join(STATE_DIR, "config.json");
const ROLES_DIR = ENV.SWARM_ROLES_DIR ?? join(import.meta.dir, "roles");
const HOST = ENV.SWARM_HOST ?? "127.0.0.1";
const PORT = Number(ENV.SWARM_PORT ?? 8790);
/** How to start freepi. `freepi` is the installed bin; the panel-style
 * `bun run <checkout>/free-pi-cli/src/index.ts` also works. */
const FREEPI_CMD = (ENV.SWARM_FREEPI_CMD ?? "freepi").split(/\s+/).filter(Boolean);
const SELF = [process.execPath, resolve(import.meta.dir, basename(import.meta.path))];

const MAIL_POLL_MS = Number(ENV.SWARM_MAIL_POLL_MS ?? 2_000);
const HEARTBEAT_MS = Number(ENV.SWARM_HEARTBEAT_MS ?? 10_000);

export interface SwarmConfig {
  /** The switch. Gates deployment only. */
  enabled: boolean;
  maxWorkers: number;
  defaultRole: string;
  /** How long a task claim or scope claim stays valid without renewal. */
  leaseSeconds: number;
  /** Push new mail into a running worker as a message (vs leaving it for `swarm inbox`). */
  deliverMail: boolean;
  /** Directories a worker may be given as cwd; empty = any. */
  cwdAllowlist: string[];
}

const DEFAULTS: SwarmConfig = {
  enabled: false,
  maxWorkers: 3,
  defaultRole: "hunter",
  leaseSeconds: 1_800,
  deliverMail: true,
  cwdAllowlist: [],
};

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------
function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(join(path, ".."));
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
}

/** Every name that becomes a path segment must survive this. */
function assertName(kind: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name)) {
    throw new SwarmError(`invalid ${kind} '${name}': use letters, digits, . _ - (max 32 chars)`);
  }
  if (name === "." || name === "..") throw new SwarmError(`invalid ${kind} '${name}'`);
  return name;
}

class SwarmError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

function loadConfig(): SwarmConfig {
  const raw = readJson<Partial<SwarmConfig>>(CONFIG_PATH);
  const cfg: SwarmConfig = { ...DEFAULTS, ...(raw ?? {}) };
  const cap = Number(ENV.SWARM_MAX_WORKERS ?? NaN);
  if (Number.isFinite(cap) && cap > 0) cfg.maxWorkers = Math.min(cfg.maxWorkers, cap);
  if (!Number.isFinite(cfg.maxWorkers) || cfg.maxWorkers < 0) cfg.maxWorkers = DEFAULTS.maxWorkers;
  if (!Number.isFinite(cfg.leaseSeconds) || cfg.leaseSeconds < 30) cfg.leaseSeconds = DEFAULTS.leaseSeconds;
  if (!Array.isArray(cfg.cwdAllowlist)) cfg.cwdAllowlist = [];
  return cfg;
}

function saveConfig(patch: Partial<SwarmConfig>): SwarmConfig {
  const next = { ...loadConfig(), ...patch };
  ensureDir(STATE_DIR);
  writeJsonAtomic(CONFIG_PATH, next);
  return next;
}

function event(kind: string, detail: Record<string, unknown>): void {
  try {
    ensureDir(STATE_DIR);
    appendFileSync(join(STATE_DIR, "events.jsonl"), `${JSON.stringify({ ts: nowIso(), kind, ...detail })}\n`);
  } catch {
    // an audit line must never break the operation it describes
  }
}

// ---------------------------------------------------------------------------
// roster — who is here
// ---------------------------------------------------------------------------
export interface AgentRecord {
  name: string;
  role: string;
  cwd: string;
  pid: number | null;
  /** pid of the `swarm worker` supervisor that owns this agent (deployed only) */
  supervisorPid: number | null;
  sessionId: string | null;
  sessionFile: string | null;
  status: "starting" | "idle" | "working" | "exited" | "detached";
  taskId: string | null;
  source: "deployed" | "self";
  startedAt: string;
  lastSeenAt: string;
  note?: string;
}

function agentsDir(): string {
  return join(STATE_DIR, "agents");
}
function agentPath(name: string): string {
  return join(agentsDir(), `${assertName("agent name", name)}.json`);
}

function putAgent(record: AgentRecord): AgentRecord {
  ensureDir(agentsDir());
  writeJsonAtomic(agentPath(record.name), record);
  return record;
}

function getAgent(name: string): AgentRecord | null {
  return readJson<AgentRecord>(agentPath(name));
}

function listAgents(): AgentRecord[] {
  let names: string[];
  try {
    names = readdirSync(agentsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: AgentRecord[] = [];
  for (const file of names) {
    const record = readJson<AgentRecord>(join(agentsDir(), file));
    if (record) out.push(record);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function pidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is not ours — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A deployed agent whose supervisor is gone is exited, whatever its file says. */
function reconcileAgent(record: AgentRecord): AgentRecord {
  if (record.source === "deployed" && record.supervisorPid && !pidAlive(record.supervisorPid)) {
    if (record.status !== "exited") {
      record.status = "exited";
      record.note = "supervisor is gone";
      record.lastSeenAt = nowIso();
      putAgent(record);
    }
  }
  return record;
}

function markAgent(name: string, patch: Partial<AgentRecord>): void {
  const current = getAgent(name) ?? {
    name: assertName("agent name", name),
    role: "unknown",
    cwd: process.cwd(),
    pid: null,
    supervisorPid: null,
    sessionId: null,
    sessionFile: null,
    status: "detached" as const,
    taskId: null,
    source: "self" as const,
    startedAt: nowIso(),
    lastSeenAt: nowIso(),
  };
  putAgent({ ...current, ...patch, name, lastSeenAt: nowIso() });
}

/** The unqualified agent every session is by default: the one it runs as. */
function selfName(explicit?: string): string {
  return explicit ?? ENV.SWARM_SESSION ?? ENV.SWARM_AGENT ?? `session-${process.ppid || process.pid}`;
}

// ---------------------------------------------------------------------------
// mail — the bus. Plain files, so any session can use it with no daemon.
// ---------------------------------------------------------------------------
export interface Mail {
  id: string;
  ts: string;
  from: string;
  to: string;
  kind: "note" | "question" | "answer" | "handoff" | "finding" | "alert" | "release";
  subject: string;
  body: string;
  taskId: string | null;
  replyTo: string | null;
}

function mailDir(name: string, box: "new" | "read" = "new"): string {
  return join(STATE_DIR, "mail", assertName("agent name", name), box);
}

function sendMail(input: {
  from: string;
  to: string;
  body: string;
  kind?: Mail["kind"];
  subject?: string;
  taskId?: string | null;
  replyTo?: string | null;
}): Mail {
  const to = assertName("recipient", input.to);
  const mail: Mail = {
    id: `m${shortId()}`,
    ts: nowIso(),
    from: input.from,
    to,
    kind: input.kind ?? "note",
    subject: input.subject ?? "",
    body: input.body,
    taskId: input.taskId ?? null,
    replyTo: input.replyTo ?? null,
  };
  ensureDir(mailDir(to, "new"));
  ensureDir(mailDir(to, "read"));
  writeJsonAtomic(join(mailDir(to, "new"), `${mail.id}.json`), mail);
  event("mail", { id: mail.id, from: mail.from, to, kind: mail.kind, subject: mail.subject });
  return mail;
}

function readMailBox(name: string, box: "new" | "read"): Mail[] {
  let files: string[];
  try {
    files = readdirSync(mailDir(name, box)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Mail[] = [];
  for (const file of files) {
    const mail = readJson<Mail>(join(mailDir(name, box), file));
    if (mail) out.push(mail);
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

function countUnread(name: string): number {
  try {
    return readdirSync(mailDir(name, "new")).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** Reads a mailbox, marking messages read by moving them (atomic per message). */
function drainMail(name: string): Mail[] {
  const fresh = readMailBox(name, "new");
  for (const mail of fresh) {
    try {
      renameSync(join(mailDir(name, "new"), `${mail.id}.json`), join(mailDir(name, "read"), `${mail.id}.json`));
    } catch {
      // already moved by another reader — the file is the lock, so that is fine
    }
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// tasks — the board
// ---------------------------------------------------------------------------
export interface Task {
  id: string;
  title: string;
  detail: string;
  role: string | null;
  scope: string | null;
  status: "open" | "claimed" | "done" | "failed" | "blocked";
  owner: string | null;
  createdAt: string;
  updatedAt: string;
  leaseUntil: string | null;
  evidence: string | null;
  result: string | null;
  history: Array<{ ts: string; by: string; what: string }>;
}

function tasksDir(): string {
  return join(STATE_DIR, "tasks");
}

function taskPath(id: string): string {
  return join(tasksDir(), `${assertName("task id", id)}.json`);
}

function taskClaimDir(id: string): string {
  return join(tasksDir(), `${assertName("task id", id)}.claim`);
}

function getTask(id: string): Task | null {
  return readJson<Task>(taskPath(id));
}

function putTask(task: Task): Task {
  ensureDir(tasksDir());
  task.updatedAt = nowIso();
  writeJsonAtomic(taskPath(task.id), task);
  return task;
}

function listTasks(): Task[] {
  let files: string[];
  try {
    files = readdirSync(tasksDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Task[] = [];
  for (const file of files) {
    const task = readJson<Task>(join(tasksDir(), file));
    if (task) out.push(task);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function addTask(input: { id?: string; title: string; detail?: string; role?: string | null; scope?: string | null; by: string }): Task {
  const id = assertName("task id", input.id?.trim() || `T-${shortId()}`);
  if (getTask(id)) throw new SwarmError(`task ${id} already exists`, 4);
  const task: Task = {
    id,
    title: input.title,
    detail: input.detail ?? "",
    role: input.role ?? null,
    scope: input.scope ?? null,
    status: "open",
    owner: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    leaseUntil: null,
    evidence: null,
    result: null,
    history: [{ ts: nowIso(), by: input.by, what: "created" }],
  };
  putTask(task);
  event("task", { id, action: "add", by: input.by, title: task.title });
  return task;
}

/** The claim directory is the lock: mkdir either wins the task or shows the holder. */
function claimTask(id: string, owner: string, leaseSeconds: number, force = false): Task {
  const task = getTask(id);
  if (!task) throw new SwarmError(`no task ${id}`, 1);
  if (task.status === "done" || task.status === "failed") {
    throw new SwarmError(`task ${id} is ${task.status}`, 4);
  }
  const dir = taskClaimDir(id);
  const expiry = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  // Non-recursive mkdir is the whole lock: it throws EEXIST if the claim dir is
  // already there (recursive: true would silently succeed and hand the task to
  // everyone). ensureDir() is only used for the parent.
  const take = (): void => {
    mkdirSync(dir);
    writeFileSync(join(dir, "owner"), `${owner}\n${expiry}\n`, { mode: 0o600 });
  };
  try {
    ensureDir(tasksDir());
    take();
  } catch {
    // Two records describe the same lease — the lock's owner file and the task's
    // own `leaseUntil` — so the claim counts as expired when either says so. A
    // stale owner file with no stamp, or a record edited by a human, must not pin
    // a task forever.
    const holder = readClaimHolder(dir);
    const now = Date.now();
    const holderExpiry = holder.expiresAt ? Date.parse(holder.expiresAt) : Number.NaN;
    const taskExpiry = task.leaseUntil ? Date.parse(task.leaseUntil) : Number.NaN;
    const expired =
      Number.isNaN(holderExpiry) || holderExpiry < now || (!Number.isNaN(taskExpiry) && taskExpiry < now);
    if (holder.owner === owner) {
      // renewing our own claim
      writeFileSync(join(dir, "owner"), `${owner}\n${expiry}\n`, { mode: 0o600 });
    } else if (force || expired) {
      rmSync(dir, { recursive: true, force: true });
      take();
      event("task", { id, action: "reclaim", by: owner, was: holder.owner, expired });
    } else {
      throw new SwarmError(`task ${id} is claimed by ${holder.owner} until ${holder.expiresAt}`, 4);
    }
  }
  task.status = "claimed";
  task.owner = owner;
  task.leaseUntil = expiry;
  task.history.push({ ts: nowIso(), by: owner, what: "claimed" });
  putTask(task);
  event("task", { id, action: "claim", by: owner });
  return task;
}

function finishTask(id: string, owner: string, status: "done" | "failed" | "blocked", evidence?: string, result?: string): Task {
  const task = getTask(id);
  if (!task) throw new SwarmError(`no task ${id}`, 1);
  if (task.owner && task.owner !== owner) {
    throw new SwarmError(`task ${id} is owned by ${task.owner}, not ${owner}`, 4);
  }
  task.status = status;
  task.owner = owner;
  if (evidence !== undefined) task.evidence = evidence;
  if (result !== undefined) task.result = result;
  task.history.push({ ts: nowIso(), by: owner, what: status });
  putTask(task);
  if (status !== "blocked") rmSync(taskClaimDir(id), { recursive: true, force: true });
  event("task", { id, action: status, by: owner });
  return task;
}

function readClaimHolder(dir: string): { owner: string; expiresAt: string | null } {
  try {
    const lines = readFileSync(join(dir, "owner"), "utf8").split("\n");
    return { owner: (lines[0] ?? "").trim(), expiresAt: (lines[1] ?? "").trim() || null };
  } catch {
    return { owner: "(unknown)", expiresAt: null };
  }
}

/** Claims whose lease ran out with the owner gone: reported, never silently stolen. */
function staleTasks(): string[] {
  const out: string[] = [];
  for (const task of listTasks()) {
    if (task.status !== "claimed" || !task.leaseUntil) continue;
    if (Date.parse(task.leaseUntil) < Date.now()) out.push(task.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// scope claims — for bug bounties: one tester per target, enforced
// ---------------------------------------------------------------------------
export interface ScopeClaim {
  scope: string;
  key: string;
  owner: string;
  claimedAt: string;
  expiresAt: string;
  taskId: string | null;
}

function scopeKey(scope: string): string {
  const slug = scope
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "scope"}-${createHash("sha256").update(scope).digest("hex").slice(0, 8)}`;
}

function claimsDir(): string {
  return join(STATE_DIR, "claims");
}

function claimPath(scope: string): string {
  return join(claimsDir(), scopeKey(scope));
}

function claimScope(input: { scope: string; owner: string; leaseSeconds: number; force?: boolean; taskId?: string | null }): ScopeClaim {
  const dir = claimPath(input.scope);
  const expiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
  const payload = (): ScopeClaim => ({
    scope: input.scope,
    key: scopeKey(input.scope),
    owner: input.owner,
    claimedAt: nowIso(),
    expiresAt,
    taskId: input.taskId ?? null,
  });
  try {
    ensureDir(claimsDir());
    mkdirSync(dir); // atomic: EEXIST when someone already holds this scope
    writeJsonAtomic(join(dir, "claim.json"), payload());
  } catch {
    const held = readJson<ScopeClaim>(join(dir, "claim.json"));
    if (held && held.owner === input.owner) {
      writeJsonAtomic(join(dir, "claim.json"), { ...held, expiresAt });
      return { ...held, expiresAt };
    }
    const expired = !held || Date.parse(held.expiresAt) < Date.now();
    if (!input.force && !expired) {
      throw new SwarmError(
        `scope '${input.scope}' is held by ${held?.owner ?? "someone"} until ${held?.expiresAt ?? "unknown"}`,
        4,
      );
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const fresh = payload();
    writeJsonAtomic(join(dir, "claim.json"), fresh);
    event("scope", { scope: input.scope, action: "reclaim", by: input.owner, was: held?.owner ?? null });
    return fresh;
  }
  const created = payload();
  event("scope", { scope: input.scope, action: "claim", by: input.owner });
  return created;
}

function releaseScope(scope: string, owner: string, force = false): boolean {
  const dir = claimPath(scope);
  const held = readJson<ScopeClaim>(join(dir, "claim.json"));
  if (!held) {
    rmSync(dir, { recursive: true, force: true });
    return false;
  }
  if (held.owner !== owner && !force) {
    throw new SwarmError(`scope '${scope}' is held by ${held.owner}; only they (or --force) can release it`, 4);
  }
  rmSync(dir, { recursive: true, force: true });
  event("scope", { scope, action: "release", by: owner });
  return true;
}

function listClaims(): ScopeClaim[] {
  let keys: string[];
  try {
    keys = readdirSync(claimsDir());
  } catch {
    return [];
  }
  const out: ScopeClaim[] = [];
  for (const key of keys) {
    const held = readJson<ScopeClaim>(join(claimsDir(), key, "claim.json"));
    if (held) out.push(held);
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope));
}

/** Everything a departing agent was holding: released so nobody is stuck behind a dead pid. */
function releaseHeldBy(owner: string): { scopes: string[]; tasks: string[] } {
  const scopes: string[] = [];
  for (const held of listClaims()) {
    if (held.owner === owner) {
      rmSync(claimPath(held.scope), { recursive: true, force: true });
      scopes.push(held.scope);
      event("scope", { scope: held.scope, action: "release", by: owner, reason: "owner left" });
    }
  }
  const tasks: string[] = [];
  for (const task of listTasks()) {
    if (task.status === "claimed" && task.owner === owner) {
      task.status = "open";
      task.owner = null;
      task.leaseUntil = null;
      task.history.push({ ts: nowIso(), by: owner, what: "released (owner left)" });
      putTask(task);
      rmSync(taskClaimDir(task.id), { recursive: true, force: true });
      tasks.push(task.id);
    }
  }
  return { scopes, tasks };
}

// ---------------------------------------------------------------------------
// the brief: what a deployed worker is told
// ---------------------------------------------------------------------------
function loadRole(role: string): string {
  const name = assertName("role", role);
  for (const candidate of [join(ROLES_DIR, `${name}.md`), join(ROLES_DIR, `${name}.txt`)]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8").trim();
  }
  return "";
}

function buildBrief(input: { name: string; role: string; cwd: string; task?: Task | null; extra?: string }): string {
  const role = loadRole(input.role);
  const lines = [
    `You are ${input.name}, a ${input.role} agent in a freepi swarm. You are one of several sessions working in parallel, each in its own process.`,
    `Your working directory is ${input.cwd}.`,
    "",
    role ? `# Your role\n\n${role}` : "",
    input.task
      ? `# Your assignment\n\nTask ${input.task.id}: ${input.task.title}\n\n${input.task.detail}${
          input.task.scope ? `\n\nClaimed scope: ${input.task.scope}` : ""
        }`
      : "# Your assignment\n\nNo task id was handed to you: read the board (`swarm task list`) and claim the most valuable open task before you start.",
    "",
    "# Talking to the other sessions (this is the point of the swarm)",
    "",
    "There is no tool for this — run the `swarm` CLI with bash. Your identity is already in $SWARM_SESSION, so it needs no --from.",
    "",
    "  swarm inbox                       read mail addressed to you (marks it read)",
    '  swarm send --to <name> "text"     message one session',
    '  swarm send --all "text"           message every session',
    "  swarm roster                      who is here and what they are doing",
    "  swarm task list                   the board",
    "  swarm task claim <id>             take ownership of a task (atomic: one owner wins)",
    "  swarm claim <scope>               exclusive claim on a target, host or path",
    "  swarm release <scope>             hand it back",
    '  swarm task done <id> --evidence "<what you proved>"',
    "",
    "# Rules of engagement",
    "",
    "1. Never test or edit a scope someone else holds (`swarm status` shows holders). That is what stops two of us from burning the same allowance on the same target.",
    "2. Announce findings on the bus as you get them — `swarm send --all` — not just in your own log. Another session may be blocked on what you just learned.",
    "3. If you need a human decision, say so explicitly: `swarm send --all \"QUESTION: ...\"` and keep working on something else meanwhile.",
    "4. Finish by recording the outcome: `swarm task done <id> --evidence \"<reproduction>\"` (or `swarm task fail <id> --result \"<why>\"`). A task left claimed blocks everyone behind your lease.",
    input.extra ? `\n# Note from the coordinator\n\n${input.extra}` : "",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

// ---------------------------------------------------------------------------
// worker supervisor: one detached process per deployed subagent
// ---------------------------------------------------------------------------
interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerRuntime {
  name: string;
  role: string;
  taskId: string | null;
  cwd: string;
  proc: ReturnType<typeof spawn>;
  seq: number;
  pending: Map<string, Pending>;
  streaming: boolean;
  stopping: boolean;
  logPath: string;
  eventsPath: string;
  lastText: string | null;
  turns: number;
  startedAt: number;
}

function slotsDir(): string {
  return join(STATE_DIR, "slots");
}

function slotPath(index: number): string {
  return join(slotsDir(), `${index}.json`);
}

function stopMarker(name: string): string {
  return join(STATE_DIR, "stop", assertName("agent name", name));
}

/** Slots enforce maxWorkers with mkdir/openExcl semantics, so the cap holds
 * across processes without a daemon holding a counter. */
function reapSlots(): number[] {
  const freed: number[] = [];
  let files: string[];
  try {
    files = readdirSync(slotsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return freed;
  }
  for (const file of files) {
    const slot = readJson<{ index: number; name: string; pid: number | null; at?: string }>(join(slotsDir(), file));
    if (!slot) {
      rmSync(join(slotsDir(), file), { force: true });
      continue;
    }
    if (slot.pid && pidAlive(slot.pid)) continue; // a live supervisor owns it
    const ageMs = slot.at ? Date.now() - Date.parse(slot.at) : Number.POSITIVE_INFINITY;
    if (!slot.pid && ageMs < 60_000) continue; // reserved by a spawn that is still in flight
    rmSync(join(slotsDir(), file), { force: true });
    freed.push(slot.index);
    event("slot", { action: "reap", name: slot.name, index: slot.index, pid: slot.pid });
  }
  return freed;
}

/**
 * Reserve a slot. The pid written here is the *supervisor's*, bound once it has
 * been spawned (bindSlot) — never the CLI's own pid, which exits immediately and
 * would make every slot look stale to the next command, quietly defeating the
 * cap. Until it is bound the slot is only "reserved": reapSlots gives it a
 * minute of grace so an in-flight spawn is not stolen.
 */
function takeSlot(name: string): number {
  reapSlots();
  const cfg = loadConfig();
  ensureDir(slotsDir());
  for (let index = 0; index < cfg.maxWorkers; index++) {
    const path = slotPath(index);
    if (existsSync(path)) continue;
    try {
      writeFileSync(path, `${JSON.stringify({ index, name, pid: null, reservedBy: process.pid, at: nowIso() })}\n`, {
        flag: "wx",
      });
      return index;
    } catch {
      continue; // someone took it between existsSync and write
    }
  }
  throw new SwarmError(`at capacity: ${cfg.maxWorkers} worker slot(s) in use (swarm down <name>, or raise maxWorkers)`, 4);
}

function bindSlot(index: number, name: string, pid: number | null): void {
  writeJsonAtomic(slotPath(index), { index, name, pid, at: nowIso() });
}

function releaseSlot(name: string): void {
  let files: string[];
  try {
    files = readdirSync(slotsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const file of files) {
    const slot = readJson<{ name: string }>(join(slotsDir(), file));
    if (slot?.name === name) rmSync(join(slotsDir(), file), { force: true });
  }
}

function activeWorkerNames(): string[] {
  reapSlots();
  let files: string[];
  try {
    files = readdirSync(slotsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => readJson<{ name: string }>(join(slotsDir(), f))?.name)
    .filter((n): n is string => Boolean(n))
    .sort();
}

function cwdAllowed(cwd: string): boolean {
  const cfg = loadConfig();
  if (cfg.cwdAllowlist.length === 0) return true;
  const target = resolve(cwd);
  return cfg.cwdAllowlist.some((allowed) => {
    const base = resolve(allowed);
    return target === base || target.startsWith(`${base}/`) || target.startsWith(`${base}\\`);
  });
}

function spawnWorker(input: {
  name: string;
  role: string;
  cwd: string;
  taskId?: string | null;
  prompt?: string;
  extra?: string;
}): { name: string; pid: number | null; logPath: string; slot: number } {
  const cfg = loadConfig();
  const name = assertName("agent name", input.name);
  if (!cfg.enabled) {
    throw new SwarmError("the swarm switch is OFF — nothing will be deployed. Turn it on with `swarm on`", 3);
  }
  const existing = getAgent(name);
  if (existing && existing.status !== "exited" && (pidAlive(existing.supervisorPid) || pidAlive(existing.pid))) {
    throw new SwarmError(`an agent named ${name} is already running (swarm down ${name} first)`, 4);
  }
  const cwd = resolve(input.cwd);
  if (!existsSync(cwd)) throw new SwarmError(`cwd does not exist: ${cwd}`, 1);
  if (!cwdAllowed(cwd)) {
    throw new SwarmError(`cwd ${cwd} is outside cwdAllowlist (${cfg.cwdAllowlist.join(", ")})`, 3);
  }

  const slot = takeSlot(name);
  const logPath = join(STATE_DIR, "logs", `${name}.log`);
  ensureDir(join(STATE_DIR, "logs"));
  const args = [
    ...SELF.slice(1),
    "worker",
    "--name",
    name,
    "--role",
    input.role || cfg.defaultRole,
    "--cwd",
    cwd,
    ...(input.taskId ? ["--task", input.taskId] : []),
    ...(input.prompt ? ["--prompt", input.prompt] : []),
    ...(input.extra ? ["--extra", input.extra] : []),
  ];
  let pid: number | null = null;
  try {
    const child = spawn(SELF[0] as string, args, {
      cwd,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SWARM_SESSION: name,
        SWARM_STATE_DIR: STATE_DIR,
        SWARM_ROLE: input.role || cfg.defaultRole,
        SWARM_TASK: input.taskId ?? "",
        SWARM_LOG: logPath,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });
    pid = child.pid ?? null;
    child.unref();
    bindSlot(slot, name, pid);
  } catch (err) {
    releaseSlot(name);
    throw new SwarmError(`could not start the worker supervisor: ${(err as Error).message}`, 1);
  }

  markAgent(name, {
    role: input.role || cfg.defaultRole,
    cwd,
    pid,
    supervisorPid: pid,
    status: "starting",
    taskId: input.taskId ?? null,
    sessionId: null,
    sessionFile: null,
    source: "deployed",
    startedAt: nowIso(),
    note: `slot ${slot}`,
  });
  event("worker", { action: "spawn", name, role: input.role || cfg.defaultRole, pid, slot, task: input.taskId ?? null });
  return { name, pid, logPath, slot };
}

/** `swarm worker` — the detached half. Owns one `freepi --mode rpc` child for
 * its whole life: sends the brief, pushes mail in, writes events out. */
async function runWorker(opts: {
  name: string;
  role: string;
  cwd: string;
  taskId: string | null;
  prompt?: string;
  extra?: string;
}): Promise<number> {
  const cfg = loadConfig();
  const name = assertName("agent name", opts.name);
  const eventsPath = join(STATE_DIR, "logs", `${name}.jsonl`);
  const logPath = ENV.SWARM_LOG ?? join(STATE_DIR, "logs", `${name}.log`);
  ensureDir(join(STATE_DIR, "logs"));

  const log = (line: string): void => {
    const stamped = `${nowIso()} ${line}\n`;
    try {
      appendFileSync(logPath, stamped);
    } catch {
      // best effort
    }
  };

  const task = opts.taskId ? getTask(opts.taskId) : null;
  const brief = buildBrief({ name, role: opts.role, cwd: opts.cwd, task, extra: opts.extra ?? opts.prompt });
  log(`worker start role=${opts.role} cwd=${opts.cwd} task=${opts.taskId ?? "-"}`);

  const argv = [...FREEPI_CMD.slice(1), "--mode", "rpc"];
  const proc = spawn(FREEPI_CMD[0] as string, argv, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      SWARM_SESSION: name,
      SWARM_STATE_DIR: STATE_DIR,
      SWARM_ROLE: opts.role,
      SWARM_TASK: opts.taskId ?? "",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      TERM: "dumb",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const runtime: WorkerRuntime = {
    name,
    role: opts.role,
    taskId: opts.taskId,
    cwd: opts.cwd,
    proc,
    seq: 0,
    pending: new Map(),
    streaming: false,
    stopping: false,
    logPath,
    eventsPath,
    lastText: null,
    turns: 0,
    startedAt: Date.now(),
  };

  markAgent(name, {
    role: opts.role,
    cwd: opts.cwd,
    pid: proc.pid ?? null,
    supervisorPid: process.pid,
    status: "starting",
    taskId: opts.taskId,
    source: "deployed",
    lastSeenAt: nowIso(),
    note: "worker supervisor up",
  });

  const emit = (payload: Record<string, unknown>): void => {
    try {
      appendFileSync(eventsPath, `${JSON.stringify({ ts: nowIso(), name, ...payload })}\n`);
    } catch {
      // best effort
    }
  };

  const send = (command: Record<string, unknown>, timeoutMs = 120_000): Promise<Record<string, unknown>> => {
    if (proc.exitCode !== null || proc.killed) return Promise.reject(new Error("freepi exited"));
    const id = `w${++runtime.seq}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        runtime.pending.delete(id);
        reject(new Error(`no response to ${String(command.type)} within ${timeoutMs}ms`));
      }, timeoutMs);
      runtime.pending.set(id, { resolve: resolvePromise, reject, timer });
      try {
        proc.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
      } catch (err) {
        clearTimeout(timer);
        runtime.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  const settlePending = (err: Error): void => {
    for (const [, pending] of runtime.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    runtime.pending.clear();
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
        const pending = id ? runtime.pending.get(id) : undefined;
        if (pending) {
          runtime.pending.delete(id as string);
          clearTimeout(pending.timer);
          pending.resolve(evt);
        }
        if (evt.command === "get_state" && evt.data) {
          const data = evt.data as Record<string, unknown>;
          markAgent(name, {
            sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
            sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : null,
          });
        }
        if (evt.command === "prompt" && evt.success === true) runtime.streaming = true;
        if (evt.command === "abort") runtime.streaming = false;
      } else if (type === "turn_start" || type === "agent_start") {
        runtime.streaming = true;
        markAgent(name, { status: "working" });
        emit({ type });
      } else if (type === "turn_end" || type === "agent_settled") {
        runtime.streaming = false;
        runtime.turns += 1;
        markAgent(name, { status: "idle" });
        emit({ type });
      } else if (type === "extension_error" || type === "auto_retry_end") {
        emit({ type, detail: evt });
      } else if (type === "message_end") {
        const message = evt.message as { role?: string; content?: unknown } | undefined;
        if (message?.role === "assistant" && Array.isArray(message.content)) {
          const text = message.content
            .map((block) => (block as { text?: unknown })?.text)
            .filter((t): t is string => typeof t === "string")
            .join("")
            .trim();
          if (text) {
            runtime.lastText = text;
            emit({ type: "assistant_text", text: text.slice(0, 4_000) });
          }
        }
      }
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => log(`stderr: ${chunk.toString("utf8").trim()}`));

  // One terminal path, reached by a normal exit *or* by a spawn failure. A
  // supervisor whose freepi cannot start must not sit there holding a worker
  // slot and an "idle" roster entry forever: that would silently eat capacity
  // and make `swarm ps` lie about what is running.
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
    emit({ type: "worker_exit", reason });
    settlePending(new Error(reason));
    resolveExited();
  };
  proc.on("exit", (code, signal) => finish(`freepi exited (code ${code}${signal ? `, signal ${signal}` : ""})`));
  proc.on("error", (err) => finish(`could not start ${FREEPI_CMD.join(" ")}: ${err.message}`));

  // Every handshake step races the child's exit: if freepi never comes up, the
  // supervisor must give up in a second and free its slot, not block for the
  // full command timeout while the roster still claims it is fine.
  const ended = exited.then(() => null);
  const trySend = async (command: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> => {
    try {
      return await Promise.race([send(command, timeoutMs), ended]);
    } catch (err) {
      log(`${String(command.type)} failed: ${(err as Error).message}`);
      return null;
    }
  };

  // Identity first, so the panel and `swarm roster` can see which session this is.
  const state = await trySend({ type: "get_state" }, 30_000);
  if (state?.data) {
    const data = state.data as Record<string, unknown>;
    markAgent(name, {
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : null,
      status: "idle",
    });
  }
  // Older builds may not know set_session_name; the roster still identifies it.
  await trySend({ type: "set_session_name", name: `swarm:${opts.role}:${name}` }, 15_000);

  if (finished) {
    log("freepi never came up — skipping the brief");
  } else {
    const res = await trySend({ type: "prompt", message: brief }, 120_000);
    if (res?.success === false) log(`brief was rejected: ${JSON.stringify(res).slice(0, 300)}`);
    else if (res) log("brief sent");
  }

  // Heartbeat, mail delivery and the stop marker — the loop the supervisor exists for.
  const tick = setInterval(() => {
    void (async () => {
      if (runtime.stopping) return;
      markAgent(name, { status: runtime.streaming ? "working" : "idle" });

      if (existsSync(stopMarker(name))) {
        runtime.stopping = true;
        log("stop requested by the swarm");
        emit({ type: "worker_stop", reason: "stop marker" });
        try {
          proc.stdin?.end();
        } catch {
          // already closed
        }
        setTimeout(() => {
          if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM");
        }, 3_000).unref?.();
        return;
      }

      if (!loadConfig().deliverMail) return;
      const fresh = drainMail(name);
      if (fresh.length === 0) return;
      const text = fresh
        .map((mail) => `[swarm mail from ${mail.from}]${mail.subject ? ` ${mail.subject}` : ""}\n${mail.body}`)
        .join("\n\n");
      emit({ type: "mail_delivered", count: fresh.length, ids: fresh.map((m) => m.id) });
      log(`delivering ${fresh.length} message(s) from the bus`);
      try {
        if (runtime.streaming) await send({ type: "steer", message: text }, 60_000);
        else await send({ type: "prompt", message: text }, 60_000);
      } catch (err) {
        log(`delivery failed, leaving it for \`swarm inbox\`: ${(err as Error).message}`);
        for (const mail of fresh) {
          // put it back: a failed push must not lose a message
          try {
            writeJsonAtomic(join(mailDir(name, "new"), `${mail.id}.json`), mail);
            rmSync(join(mailDir(name, "read"), `${mail.id}.json`), { force: true });
          } catch {
            // best effort
          }
        }
      }
    })();
  }, MAIL_POLL_MS);

  await exited;
  clearInterval(tick);
  // Release what this agent was holding *before* declaring it exited: anything
  // watching the roster would otherwise see "exited" while its scope claim is
  // still on the books, and a session that reacts to that sees a phantom holder.
  const freed = releaseHeldBy(name);
  releaseSlot(name);
  markAgent(name, { status: "exited", note: finishReason || "freepi exited" });
  rmSync(stopMarker(name), { force: true });
  emit({ type: "worker_done", releasedScopes: freed.scopes, releasedTasks: freed.tasks, turns: runtime.turns });
  log(`worker finished: released ${freed.scopes.length} scope(s), ${freed.tasks.length} task(s)`);
  return 0;
}

function stopWorker(name: string, reason = "stop requested"): void {
  const agent = getAgent(assertName("agent name", name));
  if (!agent) throw new SwarmError(`no agent named ${name}`, 1);
  ensureDir(join(STATE_DIR, "stop"));
  writeFileSync(stopMarker(name), `${reason}\n${nowIso()}\n`, { mode: 0o600 });
  event("worker", { action: "stop", name, reason, supervisorPid: agent.supervisorPid });
  // A supervisor that is already gone can never read the marker, so nothing
  // would ever release this agent's claims and slot: do it here instead.
  if (!pidAlive(agent.supervisorPid)) {
    const freed = releaseHeldBy(name);
    releaseSlot(name);
    rmSync(stopMarker(name), { force: true });
    markAgent(name, { status: "exited", note: `supervisor already gone (${reason})` });
    event("worker", { action: "cleanup", name, releasedScopes: freed.scopes, releasedTasks: freed.tasks });
    return;
  }
  // The marker is the graceful path (the supervisor end()s the child's stdin).
  // A dead supervisor can never read it, so fall back to a signal.
  setTimeout(() => {
    if (agent.supervisorPid && pidAlive(agent.supervisorPid)) {
      try {
        process.kill(agent.supervisorPid, "SIGTERM");
      } catch {
        // gone
      }
    }
  }, 4_000).unref?.();
}

// ---------------------------------------------------------------------------
// service: the UI + the switch (a viewer over the same files, plus spawn/stop)
// ---------------------------------------------------------------------------
function tokenPath(): string {
  const explicit = ENV.SWARM_TOKEN_FILE;
  if (explicit) return explicit;
  const etc = "/etc/freepi-swarm/token";
  return existsSync(etc) ? etc : join(STATE_DIR, "token");
}

function readToken(create: boolean): string {
  const path = tokenPath();
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token) return token;
  } catch {
    // fall through to creation
  }
  if (!create) return "";
  ensureDir(join(path, ".."));
  const token = randomBytes(32).toString("base64");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // windows
  }
  return token;
}

function stateSnapshot() {
  const cfg = loadConfig();
  const agents = listAgents().map(reconcileAgent);
  const tasks = listTasks();
  const claims = listClaims();
  const mail: Record<string, number> = {};
  for (const agent of agents) {
    const unread = countUnread(agent.name);
    if (unread > 0) mail[agent.name] = unread;
  }
  return {
    stateDir: STATE_DIR,
    host: (() => {
      try {
        return hostname();
      } catch {
        return "this box";
      }
    })(),
    config: cfg,
    configPath: CONFIG_PATH,
    slots: { used: activeWorkerNames(), max: cfg.maxWorkers },
    freepiCmd: FREEPI_CMD.join(" "),
    agents,
    tasks: {
      items: tasks,
      open: tasks.filter((t) => t.status === "open").length,
      claimed: tasks.filter((t) => t.status === "claimed").length,
      done: tasks.filter((t) => t.status === "done").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      blocked: tasks.filter((t) => t.status === "blocked").length,
      stale: staleTasks(),
    },
    claims,
    mail,
  };
}

function tailEvents(afterBytes: number): { events: Record<string, unknown>[]; offset: number } {
  const path = join(STATE_DIR, "events.jsonl");
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { events: [], offset: 0 };
  }
  if (afterBytes > size) afterBytes = 0;
  if (afterBytes === size) return { events: [], offset: size };
  let text = "";
  try {
    text = readFileSync(path, "utf8").slice(afterBytes);
  } catch {
    return { events: [], offset: size };
  }
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // partial line; the next poll re-reads from the last complete newline
    }
  }
  const lastNewline = text.lastIndexOf("\n");
  return { events, offset: afterBytes + (lastNewline === -1 ? 0 : lastNewline + 1) };
}

async function serve(): Promise<number> {
  const token = readToken(true);
  const cookieValue = createHmac("sha256", token).update("freepi-swarm:v1").digest("hex");
  const COOKIE = "fp_swarm";
  const publicDir = join(import.meta.dir, "public");

  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    });

  function parseCookies(header: string | null): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (header ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
  }

  function isAuthed(req: Request): boolean {
    const cookie = parseCookies(req.headers.get("cookie"))[COOKIE];
    if (cookie) {
      const a = createHash("sha256").update(cookie).digest();
      const b = createHash("sha256").update(cookieValue).digest();
      if (timingSafeEqual(a, b)) return true;
    }
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (bearer) {
      const a = createHash("sha256").update(bearer).digest();
      const b = createHash("sha256").update(token).digest();
      return timingSafeEqual(a, b);
    }
    return false;
  }

  function sameOrigin(req: Request): boolean {
    if (req.headers.get("sec-fetch-site") === "cross-site") return false;
    const origin = req.headers.get("origin");
    if (!origin) return true;
    try {
      return new URL(origin).host === (req.headers.get("host") ?? "");
    } catch {
      return false;
    }
  }

  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const secure = (req.headers.get("x-forwarded-proto") ?? "").includes("https");
      try {
        if (path === "/" || path === "/index.html") {
          try {
            return new Response(readFileSync(join(publicDir, "index.html"), "utf8"), {
              headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
            });
          } catch {
            return new Response("swarm UI missing", { status: 500 });
          }
        }
        if (path === "/healthz") {
          const snapshot = stateSnapshot();
          return json({
            ok: true,
            enabled: snapshot.config.enabled,
            agents: snapshot.agents.filter((a) => a.status !== "exited").length,
            slotsUsed: snapshot.slots.used.length,
            maxWorkers: snapshot.config.maxWorkers,
            stateDir: STATE_DIR,
          });
        }
        if (path === "/api/login" && req.method === "POST") {
          let body: { token?: string } = {};
          try {
            body = (await req.json()) as { token?: string };
          } catch {
            return json({ error: "expected JSON { token }" }, 400);
          }
          const a = createHash("sha256").update(String(body.token ?? "").trim()).digest();
          const b = createHash("sha256").update(readToken(false) || token).digest();
          if (!body.token || !timingSafeEqual(a, b)) return json({ error: "that token does not match" }, 401);
          return json({ ok: true }, 200, {
            "set-cookie": `${COOKIE}=${cookieValue}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`,
          });
        }

        if (!isAuthed(req)) return json({ error: "not signed in" }, 401);
        if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
          return json({ error: "cross-origin request refused" }, 403);
        }

        if (path === "/api/state") return json(stateSnapshot());

        if (path === "/api/toggle" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { enabled?: boolean };
          if (typeof body.enabled !== "boolean") return json({ error: "need { enabled: boolean }" }, 400);
          const cfg = saveConfig({ enabled: body.enabled });
          event("toggle", { enabled: cfg.enabled, by: "panel" });
          return json({ ok: true, config: cfg });
        }

        if (path === "/api/spawn" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as {
            name?: string;
            role?: string;
            cwd?: string;
            taskId?: string;
            prompt?: string;
          };
          const cfg = loadConfig();
          const name = body.name?.trim() || `agent-${shortId()}`;
          const result = spawnWorker({
            name,
            role: body.role?.trim() || cfg.defaultRole,
            cwd: body.cwd?.trim() || process.cwd(),
            taskId: body.taskId?.trim() || null,
            prompt: body.prompt,
          });
          return json({ ok: true, worker: result });
        }

        if (path === "/api/stop" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { name?: string; all?: boolean };
          const targets = body.all
            ? listAgents()
                .filter((a) => a.source === "deployed" && a.status !== "exited")
                .map((a) => a.name)
            : body.name
              ? [body.name]
              : [];
          if (targets.length === 0) return json({ error: "need { name } or { all: true }" }, 400);
          for (const name of targets) stopWorker(name, "stopped from the panel");
          return json({ ok: true, stopping: targets });
        }

        if (path === "/api/tasks" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as {
            action?: string;
            id?: string;
            title?: string;
            detail?: string;
            role?: string;
            scope?: string;
            evidence?: string;
            result?: string;
            owner?: string;
          };
          const owner = assertName("owner", body.owner?.trim() || "panel");
          if (body.action === "add") {
            if (!body.title?.trim()) return json({ error: "need { title }" }, 400);
            return json({ ok: true, task: addTask({ id: body.id, title: body.title, detail: body.detail ?? "", role: body.role ?? null, scope: body.scope ?? null, by: owner }) });
          }
          if (!body.id) return json({ error: "need { id }" }, 400);
          if (body.action === "claim") return json({ ok: true, task: claimTask(body.id, owner, loadConfig().leaseSeconds) });
          if (body.action === "done" || body.action === "fail" || body.action === "block") {
            const status = body.action === "done" ? "done" : body.action === "fail" ? "failed" : "blocked";
            return json({ ok: true, task: finishTask(body.id, owner, status, body.evidence, body.result) });
          }
          return json({ error: `unknown action ${body.action}` }, 400);
        }

        if (path === "/api/mail" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { to?: string; from?: string; body?: string; subject?: string };
          if (!body.to?.trim() || !body.body?.trim()) return json({ error: "need { to, body }" }, 400);
          const mail = sendMail({
            from: assertName("sender", body.from?.trim() || "panel"),
            to: body.to.trim(),
            body: body.body,
            subject: body.subject?.trim() || "",
          });
          return json({ ok: true, mail });
        }

        if (path === "/api/stream") {
          let offset = 0;
          let closed = false;
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              const push = (payload: unknown) => {
                if (closed) return;
                try {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
                } catch {
                  closed = true;
                }
              };
              push({ type: "swarm_ready" });
              const timer = setInterval(() => {
                const { events, offset: next } = tailEvents(offset);
                offset = next;
                for (const evt of events) push(evt);
                push({ type: "swarm_heartbeat", at: Date.now(), state: stateSnapshot().slots });
              }, 1_500);
              (controller as unknown as { _cleanup?: () => void })._cleanup = () => clearInterval(timer);
            },
            cancel() {
              closed = true;
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-store",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            },
          });
        }

        if (path === "/api/log") {
          const name = url.searchParams.get("name") ?? "";
          if (!name) return json({ error: "need ?name=" }, 400);
          try {
            const text = readFileSync(join(STATE_DIR, "logs", `${assertName("agent name", name)}.log`), "utf8");
            return json({ log: text.slice(-20_000) });
          } catch {
            return json({ log: "" });
          }
        }

        return json({ error: `no route for ${path}` }, 404);
      } catch (err) {
        const e = err as SwarmError;
        return json({ error: e.message }, e.code === 3 ? 403 : e.code === 4 ? 409 : 500);
      }
    },
  });

  console.log(
    `freepi-swarm listening on http://${HOST}:${server.port}\n` +
      `  state:      ${STATE_DIR}\n` +
      `  token file: ${tokenPath()}\n` +
      `  workers:    ${loadConfig().enabled ? `ON (max ${loadConfig().maxWorkers})` : "OFF (swarm on to enable)"}\n` +
      `  freepi cmd: ${FREEPI_CMD.join(" ")}`,
  );

  const sweeper = setInterval(() => {
    reapSlots();
    for (const agent of listAgents()) reconcileAgent(agent);
  }, 30_000);
  sweeper.unref?.();

  await new Promise(() => {});
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface Args {
  command: string;
  flags: Map<string, string | boolean>;
  rest: string[];
}

/** Flags that never take a value — `swarm send --all "text"` must keep the text
 * as the message, not hand it to --all as its argument. */
const BOOLEAN_FLAGS = new Set(["json", "all", "force", "keep", "peek", "help", "quiet", "verbose", "dry-run"]);

function parseArgs(argv: string[]): Args {
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
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) {
        flags.set(key, argv[++i] as string);
      } else flags.set(key, true);
    } else if (!command) command = token;
    else rest.push(token);
  }
  return { command, flags, rest };
}

const HELP = `swarm — deploy freepi subagents and let freepi sessions coordinate.

  swarm on | off | toggle            the switch that gates deployment
  swarm status [--json]              toggle, slots, roster, board, claims, unread mail

  swarm spawn --name N [--role R] [--cwd DIR] [--task ID] [--prompt "extra"]
  swarm up --tasks ID [ID...] [--role R] [--prefix NAME]   one worker per task
  swarm ps                           live agents and their supervisors
  swarm down NAME|--all [--reason "..."]   stop workers (works while the switch is off)
  swarm reap                         free slots whose supervisor died

  swarm register --name N [--role R]          announce this session
  swarm leave [--name N]             leave the roster, releasing claims and tasks
  swarm roster [--json]

  swarm send --to NAME|--all "text" [--subject S] [--kind note|question|answer|finding|alert]
  swarm inbox [--json] [--keep]      read your mail (--keep = peek, do not mark read)
  swarm watch [--interval 3]         print mail as it arrives

  swarm task add --title "..." [--id ID] [--detail "..."] [--role R] [--scope S]
  swarm task list [--json] | claim ID | done ID [--evidence "..."]
  swarm task fail ID [--result "..."] | block ID [--result "..."]
  swarm claim SCOPE [--ttl MIN] [--force] [--task ID]   exclusive: one tester per scope
  swarm release SCOPE [--force] | claims [--json]

  swarm brief --name N --role R [--task ID]            print the worker brief
  swarm worker --name N --role R --cwd DIR [--task ID] (what spawn starts)
  swarm serve [--port N]                               the UI + the switch

Config: ${CONFIG_PATH}
State:  ${STATE_DIR}
`;

function boolFlag(args: Args, key: string, fallback = false): boolean {
  const value = args.flags.get(key);
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function strFlag(args: Args, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function textFrom(args: Args): string {
  return (strFlag(args, "message") ?? strFlag(args, "body") ?? args.rest.join(" ")).trim();
}

function humanStatus(): string {
  const snapshot = stateSnapshot();
  const cfg = snapshot.config;
  const lines: string[] = [];
  lines.push(`swarm — state ${snapshot.stateDir}`);
  lines.push(
    `  switch: ${cfg.enabled ? "ON " : "OFF"} (max ${cfg.maxWorkers} workers, default role ${cfg.defaultRole}, lease ${Math.round(
      cfg.leaseSeconds / 60,
    )} min)`,
  );
  lines.push(`  slots:  ${snapshot.slots.used.length}/${snapshot.slots.max} in use${snapshot.slots.used.length ? ` (${snapshot.slots.used.join(", ")})` : ""}`);
  const live = snapshot.agents.filter((a) => a.status !== "exited");
  if (live.length === 0) lines.push("  agents: none deployed or registered");
  else {
    lines.push("  agents:");
    for (const agent of live) {
      const unread = snapshot.mail[agent.name] ?? 0;
      lines.push(
        `    ${agent.name.padEnd(14)} ${agent.role.padEnd(9)} ${agent.status.padEnd(8)} ` +
          `${agent.source === "deployed" ? `pid ${agent.pid ?? "-"}` : "self-registered"} ` +
          `${agent.taskId ? `task ${agent.taskId} ` : ""}${unread ? `${unread} unread` : ""}`.trimEnd(),
      );
    }
  }
  if (snapshot.agents.some((a) => a.status === "exited")) {
    lines.push(`  exited: ${snapshot.agents.filter((a) => a.status === "exited").map((a) => a.name).join(", ")}`);
  }
  const t = snapshot.tasks;
  lines.push(`  board:  ${t.open} open, ${t.claimed} claimed, ${t.done} done, ${t.failed} failed, ${t.blocked} blocked`);
  if (t.stale.length) lines.push(`  stale:  ${t.stale.join(", ")} (lease expired — reclaim with \`swarm task claim <id>\`)`);
  if (snapshot.claims.length) {
    lines.push("  scopes held:");
    for (const claim of snapshot.claims) lines.push(`    ${claim.owner.padEnd(14)} ${claim.scope} (until ${claim.expiresAt})`);
  } else lines.push("  scopes held: none");
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args.command || "status";
  const json = boolFlag(args, "json");
  const out = (value: unknown): void => {
    if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else if (typeof value === "string") process.stdout.write(`${value}\n`);
  };
  ensureDir(STATE_DIR);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;

    case "on":
    case "off": {
      const cfg = saveConfig({ enabled: command === "on" });
      event("toggle", { enabled: cfg.enabled, by: selfName(strFlag(args, "by")) });
      out({ ok: true, enabled: cfg.enabled, maxWorkers: cfg.maxWorkers, path: CONFIG_PATH });
      if (!json) process.stdout.write(`swarm switch ${cfg.enabled ? "ON" : "OFF"} (${CONFIG_PATH})\n`);
      return 0;
    }
    case "toggle": {
      const cfg = saveConfig({ enabled: !loadConfig().enabled });
      event("toggle", { enabled: cfg.enabled, by: selfName(strFlag(args, "by")) });
      if (!json) process.stdout.write(`swarm switch ${cfg.enabled ? "ON" : "OFF"}\n`);
      out({ ok: true, enabled: cfg.enabled });
      return 0;
    }

    case "status":
      if (json) out(stateSnapshot());
      else process.stdout.write(`${humanStatus()}\n`);
      return 0;

    case "register": {
      const name = assertName("agent name", strFlag(args, "name") ?? selfName());
      const role = strFlag(args, "role") ?? loadConfig().defaultRole;
      const record: AgentRecord = {
        ...(getAgent(name) ?? {
          name,
          pid: null,
          supervisorPid: null,
          sessionId: null,
          sessionFile: null,
          startedAt: nowIso(),
          taskId: null,
          source: "self" as const,
          lastSeenAt: nowIso(),
          cwd: process.cwd(),
          status: "idle" as const,
          role,
        }),
        name,
        role,
        cwd: resolve(strFlag(args, "cwd") ?? process.cwd()),
        // No pid: a hand-driven session registers from a short-lived CLI process,
        // so any pid here would be a lie that `swarm ps` would repeat.
        pid: null,
        source: "self",
        status: "idle",
        lastSeenAt: nowIso(),
      };
      putAgent(record);
      event("roster", { action: "register", name, role });
      out({ ok: true, agent: record });
      if (!json) process.stdout.write(`${name} is on the roster as ${role} (unread mail: ${countUnread(name)})\n`);
      return 0;
    }

    case "leave": {
      const name = assertName("agent name", strFlag(args, "name") ?? selfName());
      const freed = releaseHeldBy(name);
      const record = getAgent(name);
      if (record) {
        record.status = "exited";
        record.note = "left the swarm";
        record.lastSeenAt = nowIso();
        putAgent(record);
      } else {
        rmSync(agentPath(name), { force: true });
      }
      event("roster", { action: "leave", name });
      out({ ok: true, name, releasedScopes: freed.scopes, releasedTasks: freed.tasks });
      return 0;
    }

    case "roster": {
      const agents = listAgents().map(reconcileAgent);
      if (json) out({ agents });
      else {
        if (agents.length === 0) process.stdout.write("nobody is on the roster\n");
        for (const agent of agents) {
          process.stdout.write(
            `${agent.name.padEnd(16)} ${agent.role.padEnd(10)} ${agent.status.padEnd(8)} ${
              agent.source === "deployed" ? `pid ${agent.pid ?? "-"}` : "self"
            }${agent.taskId ? ` task ${agent.taskId}` : ""}${countUnread(agent.name) ? ` · ${countUnread(agent.name)} unread` : ""}\n`,
          );
        }
      }
      return 0;
    }

    case "spawn": {
      const result = spawnWorker({
        name: strFlag(args, "name") ?? `agent-${shortId()}`,
        role: strFlag(args, "role") ?? loadConfig().defaultRole,
        cwd: strFlag(args, "cwd") ?? process.cwd(),
        taskId: strFlag(args, "task") ?? null,
        prompt: strFlag(args, "prompt"),
        extra: strFlag(args, "extra"),
      });
      out({ ok: true, ...result });
      if (!json) process.stdout.write(`deployed ${result.name} (pid ${result.pid}, slot ${result.slot}) — log: ${result.logPath}\n`);
      return 0;
    }

    case "up": {
      const cfg = loadConfig();
      const role = strFlag(args, "role") ?? cfg.defaultRole;
      const prefix = strFlag(args, "prefix") ?? role;
      const tasks = [strFlag(args, "tasks") ?? "", ...args.rest]
        .join(",")
        .split(/[\s,]+/)
        .filter(Boolean);
      if (tasks.length === 0) throw new SwarmError("need --tasks ID [ID...] (or use `swarm spawn`)", 1);
      const started: Array<Record<string, unknown>> = [];
      for (const [index, taskId] of tasks.entries()) {
        const task = getTask(taskId);
        if (!task) throw new SwarmError(`no task ${taskId}`, 1);
        const name = `${prefix}-${index + 1}`;
        started.push(spawnWorker({ name, role, cwd: strFlag(args, "cwd") ?? process.cwd(), taskId }));
      }
      out({ ok: true, workers: started });
      if (!json) process.stdout.write(`deployed ${started.length} worker(s): ${started.map((s) => s.name).join(", ")}\n`);
      return 0;
    }

    case "ps": {
      const agents = listAgents().map(reconcileAgent);
      if (json) out({ agents });
      else {
        for (const agent of agents) {
          const live = agent.status !== "exited";
          process.stdout.write(
            `${agent.name.padEnd(16)} ${(live ? agent.status : "exited").padEnd(8)} supervisor ${live && pidAlive(agent.supervisorPid) ? agent.supervisorPid : "-"} pid ${live && pidAlive(agent.pid) ? agent.pid : "-"} session ${(agent.sessionId ?? "-").slice(0, 12)}\n`,
          );
        }
        if (agents.length === 0) process.stdout.write("no agents\n");
      }
      return 0;
    }

    case "down": {
      if (boolFlag(args, "all")) {
        const names = listAgents()
          .filter((a) => a.source === "deployed" && a.status !== "exited")
          .map((a) => a.name);
        for (const name of names) stopWorker(name, strFlag(args, "reason") ?? "swarm down --all");
        out({ ok: true, stopping: names });
        if (!json) process.stdout.write(`asked ${names.length} worker(s) to stop: ${names.join(", ") || "(none)"}\n`);
        return 0;
      }
      const name = strFlag(args, "name") ?? args.rest[0];
      if (!name) throw new SwarmError("need a name or --all", 1);
      stopWorker(name, strFlag(args, "reason") ?? "swarm down");
      out({ ok: true, name });
      if (!json) process.stdout.write(`asked ${name} to stop (graceful; the supervisor ends freepi's stdin and releases its claims)\n`);
      return 0;
    }
    case "kill": {
      const name = assertName("agent name", strFlag(args, "name") ?? args.rest[0] ?? "");
      const agent = getAgent(name);
      if (!agent) throw new SwarmError(`no agent named ${name}`, 1);
      if (agent.supervisorPid && pidAlive(agent.supervisorPid)) process.kill(agent.supervisorPid, "SIGKILL");
      if (agent.pid && pidAlive(agent.pid)) process.kill(agent.pid, "SIGKILL");
      markAgent(name, { status: "exited", note: "killed" });
      releaseSlot(name);
      releaseHeldBy(name);
      event("worker", { action: "kill", name });
      out({ ok: true, name });
      return 0;
    }

    case "reap": {
      const freed = reapSlots();
      for (const agent of listAgents()) {
        const reconciled = reconcileAgent(agent);
        if (reconciled.status === "exited") releaseSlot(reconciled.name);
        // A hand-driven session leaves no process to notice: retire it once it has
        // gone a day without a heartbeat, rather than showing it as present forever.
        if (
          reconciled.source === "self" &&
          reconciled.status !== "exited" &&
          Date.now() - Date.parse(reconciled.lastSeenAt) > 24 * 60 * 60_000
        ) {
          markAgent(reconciled.name, { status: "exited", note: "no heartbeat for 24h" });
        }
      }
      out({ ok: true, freed });
      if (!json) process.stdout.write(`freed ${freed.length} slot(s)\n`);
      return 0;
    }

    case "send": {
      const from = assertName("sender", strFlag(args, "from") ?? selfName());
      const body = textFrom(args);
      if (!body) throw new SwarmError("nothing to send", 1);
      const kind = (strFlag(args, "kind") ?? "note") as Mail["kind"];
      const subject = strFlag(args, "subject") ?? "";
      const taskId = strFlag(args, "task") ?? null;
      const replyTo = strFlag(args, "reply-to") ?? null;
      if (boolFlag(args, "all")) {
        const recipients = listAgents()
          .map((a) => a.name)
          .filter((name) => name !== from);
        if (recipients.length === 0) {
          out({ ok: true, sent: [] });
          if (!json) process.stdout.write("nobody else is on the roster — nobody to tell\n");
          return 0;
        }
        const sent = recipients.map((to) => sendMail({ from, to, body, kind, subject, taskId, replyTo }));
        out({ ok: true, sent: sent.map((m) => ({ id: m.id, to: m.to })) });
        if (!json) process.stdout.write(`told ${recipients.length}: ${recipients.join(", ")}\n`);
        return 0;
      }
      const to = strFlag(args, "to") ?? args.rest[0];
      if (!to) throw new SwarmError("need --to NAME (or --all)", 1);
      const mail = sendMail({ from, to, body, kind, subject, taskId, replyTo });
      out({ ok: true, mail });
      if (!json) {
        const known = Boolean(getAgent(mail.to));
        process.stdout.write(`sent ${mail.id} to ${mail.to}${known ? "" : " (not on the roster yet — it will be in their inbox)"}\n`);
      }
      return 0;
    }

    case "inbox": {
      const name = assertName("agent name", strFlag(args, "name") ?? selfName());
      const keep = boolFlag(args, "keep") || boolFlag(args, "peek");
      const messages = keep ? readMailBox(name, "new") : drainMail(name);
      if (json) out({ agent: name, count: messages.length, messages });
      else if (messages.length === 0) process.stdout.write(`no new mail for ${name}\n`);
      else {
        for (const mail of messages) {
          process.stdout.write(
            `── ${mail.ts}  from ${mail.from}  [${mail.kind}]${mail.subject ? ` ${mail.subject}` : ""}${mail.taskId ? ` (task ${mail.taskId})` : ""}\n${mail.body}\n\n`,
          );
        }
      }
      return 0;
    }

    case "watch": {
      const name = assertName("agent name", strFlag(args, "name") ?? selfName());
      const interval = Math.max(1, Number(strFlag(args, "interval") ?? 3)) * 1000;
      process.stdout.write(`watching ${name}'s inbox every ${interval / 1000}s (ctrl-c to stop)\n`);
      let seen = new Set(readMailBox(name, "new").map((m) => m.id));
      const timer = setInterval(() => {
        for (const mail of readMailBox(name, "new")) {
          if (seen.has(mail.id)) continue;
          seen.add(mail.id);
          process.stdout.write(`── ${mail.ts}  from ${mail.from}  [${mail.kind}]\n${mail.body}\n\n`);
          event("mail", { id: mail.id, action: "seen", by: name });
        }
      }, interval);
      await new Promise<void>((resolvePromise) => {
        const stop = () => {
          clearInterval(timer);
          resolvePromise();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      });
      return 0;
    }

    case "task": {
      const action = args.rest[0] ?? "list";
      const by = assertName("owner", strFlag(args, "by") ?? selfName());
      if (action === "list") {
        const tasks = listTasks();
        if (json) out({ tasks });
        else if (tasks.length === 0) process.stdout.write("the board is empty — add one with `swarm task add --title \"...\"`\n");
        else
          for (const task of tasks) {
            process.stdout.write(
              `${task.id.padEnd(10)} ${task.status.padEnd(8)} ${(task.owner ?? "-").padEnd(14)} ${task.title}${task.scope ? `  [${task.scope}]` : ""}\n`,
            );
          }
        return 0;
      }
      if (action === "add") {
        const title = strFlag(args, "title") ?? args.rest.slice(1).join(" ");
        if (!title) throw new SwarmError("need --title", 1);
        const task = addTask({
          id: strFlag(args, "id"),
          title,
          detail: strFlag(args, "detail") ?? "",
          role: strFlag(args, "role") ?? null,
          scope: strFlag(args, "scope") ?? null,
          by,
        });
        out({ ok: true, task });
        if (!json) process.stdout.write(`added ${task.id}: ${task.title}\n`);
        return 0;
      }
      const id = args.rest[1] ?? strFlag(args, "id");
      if (!id) throw new SwarmError(`need a task id: swarm task ${action} <id>`, 1);
      if (action === "claim") {
        const task = claimTask(id, by, loadConfig().leaseSeconds, boolFlag(args, "force"));
        out({ ok: true, task });
        if (!json) process.stdout.write(`you own ${task.id} until ${task.leaseUntil}\n`);
        return 0;
      }
      if (action === "done" || action === "fail" || action === "block") {
        const status = action === "done" ? "done" : action === "fail" ? "failed" : "blocked";
        const task = finishTask(id, by, status, strFlag(args, "evidence"), strFlag(args, "result") ?? textFrom(args) ?? "");
        out({ ok: true, task });
        if (!json) process.stdout.write(`${task.id} is ${task.status}\n`);
        return 0;
      }
      if (action === "reopen") {
        const task = getTask(id);
        if (!task) throw new SwarmError(`no task ${id}`, 1);
        task.status = "open";
        task.owner = null;
        task.leaseUntil = null;
        putTask(task);
        rmSync(taskClaimDir(id), { recursive: true, force: true });
        out({ ok: true, task });
        return 0;
      }
      throw new SwarmError(`unknown task action '${action}'`, 1);
    }

    case "claim": {
      const scope = strFlag(args, "scope") ?? args.rest[0];
      if (!scope) throw new SwarmError("need a scope to claim (a host, URL, repo or path)", 1);
      const owner = assertName("owner", strFlag(args, "by") ?? selfName());
      const ttlMinutes = Number(strFlag(args, "ttl") ?? Math.round(loadConfig().leaseSeconds / 60));
      const claim = claimScope({
        scope,
        owner,
        leaseSeconds: ttlMinutes * 60,
        force: boolFlag(args, "force"),
        taskId: strFlag(args, "task") ?? null,
      });
      out({ ok: true, claim });
      if (!json) process.stdout.write(`you hold '${scope}' until ${claim.expiresAt} — nobody else will work it\n`);
      return 0;
    }
    case "release": {
      const scope = strFlag(args, "scope") ?? args.rest[0];
      if (!scope) throw new SwarmError("need a scope to release", 1);
      const owner = assertName("owner", strFlag(args, "by") ?? selfName());
      const released = releaseScope(scope, owner, boolFlag(args, "force"));
      out({ ok: true, released });
      if (!json) process.stdout.write(released ? `released '${scope}'\n` : `nothing was holding '${scope}'\n`);
      return 0;
    }
    case "claims": {
      const claims = listClaims();
      if (json) out({ claims });
      else if (claims.length === 0) process.stdout.write("no scopes are held\n");
      else for (const claim of claims) process.stdout.write(`${claim.owner.padEnd(16)} ${claim.scope}  until ${claim.expiresAt}${claim.taskId ? ` (task ${claim.taskId})` : ""}\n`);
      return 0;
    }

    case "brief": {
      const name = strFlag(args, "name") ?? "worker";
      const role = strFlag(args, "role") ?? loadConfig().defaultRole;
      const taskId = strFlag(args, "task");
      const brief = buildBrief({
        name,
        role,
        cwd: resolve(strFlag(args, "cwd") ?? process.cwd()),
        task: taskId ? getTask(taskId) : null,
        extra: strFlag(args, "extra"),
      });
      process.stdout.write(`${brief}\n`);
      return 0;
    }

    case "worker": {
      const name = strFlag(args, "name");
      if (!name) throw new SwarmError("worker needs --name", 1);
      const role = strFlag(args, "role") ?? loadConfig().defaultRole;
      const cwd = resolve(strFlag(args, "cwd") ?? process.cwd());
      const stopOnSignal = () => {
        ensureDir(join(STATE_DIR, "stop"));
        writeFileSync(stopMarker(name), "signal\n", { mode: 0o600 });
      };
      process.on("SIGTERM", stopOnSignal);
      process.on("SIGINT", stopOnSignal);
      return await runWorker({
        name,
        role,
        cwd,
        taskId: strFlag(args, "task") ?? null,
        prompt: strFlag(args, "prompt"),
        extra: strFlag(args, "extra"),
      });
    }

    case "serve": {
      if (strFlag(args, "port")) process.env.SWARM_PORT = strFlag(args, "port");
      if (strFlag(args, "host")) process.env.SWARM_HOST = strFlag(args, "host");
      return await serve();
    }

    default:
      process.stderr.write(`swarm: unknown command '${command}'\n\n${HELP}`);
      return 2;
  }
}

if (import.meta.main) {
  try {
    const code = await main(process.argv.slice(2));
    process.exit(code);
  } catch (err) {
    const e = err as SwarmError;
    process.stderr.write(`swarm: ${e.message}\n`);
    process.exit(typeof e.code === "number" && e.code > 0 ? e.code : 1);
  }
}
