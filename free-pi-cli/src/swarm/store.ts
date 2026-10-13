// Built-in agent coordination (bug-bounty flavoured): the shared state that
// lets several free-pi sessions work one target without duplicating each other.
//
// WHY THIS IS NOT AN IN-SESSION SUBAGENT: free-pi's inference is ad-funded, one
// session holds one lease, and the server-side lease is the backstop — so a
// session must never run two completions at once (test/no-subagents.test.ts SB2
// proves it never does, and still does). Coordination here does not change that:
// a "subagent" is a *separate* free-pi session (`free-pi-cli --mode rpc` in its
// own process) that the coordinating session deploys through the swarm tool and
// talks to over this state. Parallelism that the user asked for comes from
// parallel sessions, each with its own lease, not from parallel calls in one.
//
// Everything lives in plain files under ~/.free-pi/swarm so that any session can
// take part with no daemon and no database:
//
//   config.json        the switch: { enabled, maxWorkers, defaultRole, ... }
//   agents/<name>.json the roster: role, cwd, pid, session id, status, task
//   mail/<name>/new/   the bus: one JSON file per message; reading moves it to read/
//   tasks/<id>.json    the board, with the history of who claimed what
//   tasks/<id>.claim/  a directory: mkdir is the atomic "exactly one owner" test
//   findings/<id>.json the ledger: lead → testing → poc → proven | dead | duplicate,
//                      with the evidence each move requires (see ledger.ts)
//   claims/<key>/      an exclusive scope claim (a host, URL, repo or path)
//   slots/<n>.json     the worker cap, enforced with O_EXCL so no daemon owns a counter
//
// The worker-count and lease settings are the *cost* controls: every deployed
// worker is its own ad-funded session, so maxWorkers is a spend ceiling, not
// just a resource one.
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ROLE_BRIEFS, ROLE_NAMES } from "./roles";

export class SwarmError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
    this.name = "SwarmError";
  }
}

/** Any name that becomes a path segment must survive this first. */
export function assertName(kind: string, name: string): string {
  const trimmed = (name ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new SwarmError(`${kind} must be 1–32 chars of letters, digits, dot, dash or underscore (got "${name}")`);
  }
  return trimmed;
}

export function swarmDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.FREEPI_SWARM_DIR || join(homedir(), ".free-pi", "swarm"));
}

export interface SwarmConfig {
  /** The switch. Gates *deployment* only — stopping a worker always works. */
  enabled: boolean;
  maxWorkers: number;
  defaultRole: string;
  leaseSeconds: number;
  cwdAllowlist: string[];
}

export const SWARM_DEFAULTS: SwarmConfig = {
  enabled: false,
  maxWorkers: 3,
  defaultRole: "hunter",
  leaseSeconds: 1_800,
  cwdAllowlist: [],
};

export function swarmPaths(env: NodeJS.ProcessEnv = process.env) {
  const dir = swarmDir(env);
  return {
    dir,
    config: join(dir, "config.json"),
    agents: join(dir, "agents"),
    mail: join(dir, "mail"),
    tasks: join(dir, "tasks"),
    findings: join(dir, "findings"),
    claims: join(dir, "claims"),
    slots: join(dir, "slots"),
    stop: join(dir, "stop"),
    logs: join(dir, "logs"),
    events: join(dir, "events.jsonl"),
  };
}

export function ensureSwarmDir(env: NodeJS.ProcessEnv = process.env): void {
  const p = swarmPaths(env);
  for (const dir of [p.dir, p.agents, p.mail, p.tasks, p.findings, p.claims, p.slots, p.stop, p.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}

// Exported for the findings ledger (swarm/ledger.ts), which keeps its own files
// in the same directory and must write them the same way.
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
}

export function logSwarmEvent(env: NodeJS.ProcessEnv, kind: string, detail: Record<string, unknown>): void {
  try {
    const p = swarmPaths(env);
    mkdirSync(p.dir, { recursive: true });
    appendFileSync(p.events, `${JSON.stringify({ ts: nowIso(), kind, ...detail })}\n`);
  } catch {
    // an audit line must never break the operation it describes
  }
}

// ---------------------------------------------------------------------------
// config / the switch
// ---------------------------------------------------------------------------
export function loadSwarmConfig(env: NodeJS.ProcessEnv = process.env): SwarmConfig {
  const p = swarmPaths(env);
  const raw = readJson<Partial<SwarmConfig>>(p.config) ?? {};
  const cfg: SwarmConfig = { ...SWARM_DEFAULTS, ...raw };
  const cap = Number(env.FREEPI_SWARM_MAX_WORKERS ?? NaN);
  if (Number.isFinite(cap) && cap >= 0) cfg.maxWorkers = Math.min(cfg.maxWorkers, cap);
  if (!Number.isFinite(cfg.maxWorkers) || cfg.maxWorkers < 0) cfg.maxWorkers = SWARM_DEFAULTS.maxWorkers;
  if (!Number.isFinite(cfg.leaseSeconds) || cfg.leaseSeconds < 30) cfg.leaseSeconds = SWARM_DEFAULTS.leaseSeconds;
  if (!Array.isArray(cfg.cwdAllowlist)) cfg.cwdAllowlist = [];
  // Keep a configured role only when this build ships a brief for it; otherwise
  // a stale config.json could point every worker at a role nobody defined.
  if (typeof cfg.defaultRole !== "string" || !(ROLE_NAMES as readonly string[]).includes(cfg.defaultRole)) {
    cfg.defaultRole = SWARM_DEFAULTS.defaultRole;
  }
  return cfg;
}

export function saveSwarmConfig(patch: Partial<SwarmConfig>, env: NodeJS.ProcessEnv = process.env): SwarmConfig {
  const next: SwarmConfig = { ...loadSwarmConfig(env), ...patch };
  ensureSwarmDir(env);
  writeJsonAtomic(swarmPaths(env).config, next);
  return next;
}

export function roleBrief(role: string): string {
  return ROLE_BRIEFS[role] ?? "";
}

// ---------------------------------------------------------------------------
// roster
// ---------------------------------------------------------------------------
export interface AgentRecord {
  name: string;
  role: string;
  cwd: string;
  pid: number | null;
  /** pid of the supervisor process that owns this worker (deployed agents only) */
  supervisorPid: number | null;
  sessionId: string | null;
  sessionFile: string | null;
  status: "starting" | "idle" | "working" | "exited";
  taskId: string | null;
  source: "deployed" | "session";
  startedAt: string;
  lastSeenAt: string;
  note?: string;
}

function agentPath(name: string, env: NodeJS.ProcessEnv): string {
  return join(swarmPaths(env).agents, `${assertName("agent name", name)}.json`);
}

export function putAgent(record: AgentRecord, env: NodeJS.ProcessEnv = process.env): AgentRecord {
  ensureSwarmDir(env);
  writeJsonAtomic(agentPath(record.name, env), record);
  return record;
}

export function getAgent(name: string, env: NodeJS.ProcessEnv = process.env): AgentRecord | null {
  return readJson<AgentRecord>(agentPath(name, env));
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A deployed agent whose supervisor is gone has exited, whatever its file says —
 * and if it died without running its own exit path (kill -9, a reboot, a crash)
 * nothing else would ever release what it was holding. The repair happens here,
 * on the next roster read, so one `swarm status` frees a dead worker's scope and
 * task instead of leaving a teammate blocked behind a lease nothing is using.
 */
export function reconcileAgent(record: AgentRecord, env: NodeJS.ProcessEnv = process.env): AgentRecord {
  if (record.source === "deployed" && record.supervisorPid && !pidAlive(record.supervisorPid) && record.status !== "exited") {
    const freed = releaseHeldBy(record.name, env);
    releaseSlot(record.name, env);
    const next: AgentRecord = { ...record, status: "exited", note: "supervisor is gone", lastSeenAt: nowIso() };
    putAgent(next, env);
    if (freed.scopes.length || freed.tasks.length) {
      logSwarmEvent(env, "worker", { action: "reconcile", name: record.name, releasedScopes: freed.scopes, releasedTasks: freed.tasks });
    }
    return next;
  }
  return record;
}

export function listAgents(env: NodeJS.ProcessEnv = process.env): AgentRecord[] {
  const dir = swarmPaths(env).agents;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: AgentRecord[] = [];
  for (const file of files) {
    const record = readJson<AgentRecord>(join(dir, file));
    if (record) out.push(reconcileAgent(record, env));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function touchAgent(name: string, patch: Partial<AgentRecord>, env: NodeJS.ProcessEnv = process.env): void {
  const current = getAgent(name, env);
  if (!current) return;
  putAgent({ ...current, ...patch, name, lastSeenAt: nowIso() }, env);
}

/** The identity a session uses when nothing else is given. */
export function selfAgentName(env: NodeJS.ProcessEnv = process.env): string {
  return env.FREEPI_SWARM_AGENT || env.FREEPI_SWARM_SESSION || "coordinator";
}

export function registerSession(input: {
  name: string;
  role: string;
  cwd: string;
  sessionId?: string | null;
  sessionFile?: string | null;
}, env: NodeJS.ProcessEnv = process.env): AgentRecord {
  const name = assertName("agent name", input.name);
  const existing = getAgent(name, env);
  // A deployed worker's own session registers itself on startup, because it runs
  // this same extension. That must never rewrite what the supervisor owns: the
  // source, its role and its task are the crew's view of a *worker*, and losing
  // them would hide a live worker from `status`, `crew` and `stop`. The session's
  // own details (id, file, cwd) are all this call is allowed to contribute.
  if (existing?.source === "deployed") {
    const merged: AgentRecord = {
      ...existing,
      cwd: resolve(input.cwd),
      sessionId: input.sessionId ?? existing.sessionId,
      sessionFile: input.sessionFile ?? existing.sessionFile,
      lastSeenAt: nowIso(),
    };
    putAgent(merged, env);
    return merged;
  }
  const record: AgentRecord = {
    name,
    role: input.role,
    cwd: resolve(input.cwd),
    pid: null,
    supervisorPid: null,
    sessionId: input.sessionId ?? existing?.sessionId ?? null,
    sessionFile: input.sessionFile ?? existing?.sessionFile ?? null,
    status: "idle",
    taskId: existing?.taskId ?? null,
    source: "session",
    startedAt: existing?.startedAt ?? nowIso(),
    lastSeenAt: nowIso(),
    note: existing?.note,
  };
  putAgent(record, env);
  logSwarmEvent(env, "roster", { action: "register", name, role: input.role });
  return record;
}

export function leaveSwarm(name: string, env: NodeJS.ProcessEnv = process.env): { scopes: string[]; tasks: string[] } {
  const freed = releaseHeldBy(name, env);
  const record = getAgent(name, env);
  if (record) putAgent({ ...record, status: "exited", note: "left the swarm", lastSeenAt: nowIso() }, env);
  logSwarmEvent(env, "roster", { action: "leave", name });
  return freed;
}

// ---------------------------------------------------------------------------
// mail — the bus
// ---------------------------------------------------------------------------
export const MAIL_KINDS = ["note", "question", "answer", "finding", "handoff", "alert"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export interface Mail {
  id: string;
  ts: string;
  from: string;
  to: string;
  kind: MailKind;
  subject: string;
  body: string;
  taskId: string | null;
  replyTo: string | null;
}

export const FINDING_MARKER = "[free-pi-swarm]";

function mailbox(name: string, box: "new" | "read", env: NodeJS.ProcessEnv): string {
  return join(swarmPaths(env).mail, assertName("agent name", name), box);
}

export function sendMail(input: {
  from: string;
  to: string;
  body: string;
  kind?: MailKind;
  subject?: string;
  taskId?: string | null;
  replyTo?: string | null;
}, env: NodeJS.ProcessEnv = process.env): Mail {
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
  // Both boxes exist before the write: a message must never be lost to a
  // missing directory (the first message to a brand-new teammate creates them).
  const box = mailbox(to, "new", env);
  mkdirSync(box, { recursive: true });
  mkdirSync(mailbox(to, "read", env), { recursive: true });
  writeJsonAtomic(join(box, `${mail.id}.json`), mail);
  logSwarmEvent(env, "mail", { id: mail.id, from: mail.from, to, kind: mail.kind, subject: mail.subject });
  return mail;
}

export function peekMail(name: string, env: NodeJS.ProcessEnv = process.env): Mail[] {
  const box = mailbox(name, "new", env);
  let files: string[];
  try {
    files = readdirSync(box).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Mail[] = [];
  for (const file of files) {
    const mail = readJson<Mail>(join(box, file));
    if (mail) out.push(mail);
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function countUnread(name: string, env: NodeJS.ProcessEnv = process.env): number {
  try {
    return readdirSync(mailbox(name, "new", env)).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** Reading a mailbox marks it read by moving each message (the file is the lock). */
export function drainMail(name: string, env: NodeJS.ProcessEnv = process.env): Mail[] {
  const fresh = peekMail(name, env);
  for (const mail of fresh) {
    try {
      renameSync(join(mailbox(name, "new", env), `${mail.id}.json`), join(mailbox(name, "read", env), `${mail.id}.json`));
    } catch {
      // already moved by another reader
    }
  }
  return fresh;
}

/** Puts a message back where it came from — a failed push must not lose mail. */
export function restoreMail(mail: Mail, env: NodeJS.ProcessEnv = process.env): void {
  try {
    writeJsonAtomic(join(mailbox(mail.to, "new", env), `${mail.id}.json`), mail);
    rmSync(join(mailbox(mail.to, "read", env), `${mail.id}.json`), { force: true });
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// the board
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

function taskPath(id: string, env: NodeJS.ProcessEnv): string {
  return join(swarmPaths(env).tasks, `${assertName("task id", id)}.json`);
}

function taskClaimDir(id: string, env: NodeJS.ProcessEnv): string {
  return join(swarmPaths(env).tasks, `${assertName("task id", id)}.claim`);
}

export function getTask(id: string, env: NodeJS.ProcessEnv = process.env): Task | null {
  return readJson<Task>(taskPath(id, env));
}

export function putTask(task: Task, env: NodeJS.ProcessEnv = process.env): Task {
  ensureSwarmDir(env);
  const next = { ...task, updatedAt: nowIso() };
  writeJsonAtomic(taskPath(task.id, env), next);
  return next;
}

export function listTasks(env: NodeJS.ProcessEnv = process.env): Task[] {
  const dir = swarmPaths(env).tasks;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Task[] = [];
  for (const file of files) {
    const task = readJson<Task>(join(dir, file));
    if (task) out.push(task);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function addTask(input: {
  id?: string;
  title: string;
  detail?: string;
  role?: string | null;
  scope?: string | null;
  by: string;
}, env: NodeJS.ProcessEnv = process.env): Task {
  const id = assertName("task id", input.id?.trim() || `T-${shortId()}`);
  if (getTask(id, env)) throw new SwarmError(`task ${id} already exists`, 4);
  const task: Task = {
    id,
    title: input.title.trim(),
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
  putTask(task, env);
  logSwarmEvent(env, "task", { id, action: "add", by: input.by, title: task.title });
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

/**
 * Exactly one owner: mkdir (non-recursive) is the lock, so a second claimer gets
 * the holder's name instead of the task. A claim whose lease ran out — in either
 * record — is reclaimable, so a killed worker cannot pin a task forever.
 */
export function claimTask(id: string, owner: string, leaseSeconds: number, force = false, env: NodeJS.ProcessEnv = process.env): Task {
  const task = getTask(id, env);
  if (!task) throw new SwarmError(`no task ${id}`);
  if (task.status === "done" || task.status === "failed") throw new SwarmError(`task ${id} is already ${task.status}`, 4);
  const dir = taskClaimDir(id, env);
  const expiry = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const take = (): void => {
    mkdirSync(dir);
    writeFileSync(join(dir, "owner"), `${owner}\n${expiry}\n`, { mode: 0o600 });
  };
  let reclaimedFrom: string | null = null;
  try {
    mkdirSync(swarmPaths(env).tasks, { recursive: true });
    take();
  } catch {
    const holder = readClaimHolder(dir);
    const now = Date.now();
    const holderExpiry = holder.expiresAt ? Date.parse(holder.expiresAt) : Number.NaN;
    const taskExpiry = task.leaseUntil ? Date.parse(task.leaseUntil) : Number.NaN;
    const expired = Number.isNaN(holderExpiry) || holderExpiry < now || (!Number.isNaN(taskExpiry) && taskExpiry < now);
    if (holder.owner === owner) {
      writeFileSync(join(dir, "owner"), `${owner}\n${expiry}\n`, { mode: 0o600 });
    } else if (force || expired) {
      rmSync(dir, { recursive: true, force: true });
      take();
      reclaimedFrom = holder.owner;
      logSwarmEvent(env, "task", { id, action: "reclaim", by: owner, was: holder.owner, expired });
    } else {
      throw new SwarmError(`task ${id} is claimed by ${holder.owner} until ${holder.expiresAt}`, 4);
    }
  }
  // A take-over is written into the task's own history, not just the event log:
  // the board is where a teammate looks to see who has what, and why.
  const claimed: Task = {
    ...task,
    status: "claimed",
    owner,
    leaseUntil: expiry,
    history: [
      ...task.history,
      ...(reclaimedFrom ? [{ ts: nowIso(), by: owner, what: `reclaim (lease expired; was ${reclaimedFrom})` }] : []),
      { ts: nowIso(), by: owner, what: "claimed" },
    ],
  };
  putTask(claimed, env);
  logSwarmEvent(env, "task", { id, action: "claim", by: owner });
  return claimed;
}

export function finishTask(
  id: string,
  owner: string,
  status: "done" | "failed" | "blocked",
  opts: { evidence?: string; result?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Task {
  const task = getTask(id, env);
  if (!task) throw new SwarmError(`no task ${id}`);
  if (task.owner && task.owner !== owner) throw new SwarmError(`task ${id} is owned by ${task.owner}, not ${owner}`, 4);
  const next: Task = {
    ...task,
    status,
    owner,
    evidence: opts.evidence ?? task.evidence,
    result: opts.result ?? task.result,
    history: [...task.history, { ts: nowIso(), by: owner, what: status }],
  };
  putTask(next, env);
  if (status !== "blocked") rmSync(taskClaimDir(id, env), { recursive: true, force: true });
  logSwarmEvent(env, "task", { id, action: status, by: owner });
  return next;
}

// ---------------------------------------------------------------------------
// scope claims — one tester per target
// ---------------------------------------------------------------------------
export interface ScopeClaim {
  scope: string;
  key: string;
  owner: string;
  claimedAt: string;
  expiresAt: string;
  taskId: string | null;
}

export function scopeKey(scope: string): string {
  const slug = scope
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "scope"}-${createHash("sha256").update(scope).digest("hex").slice(0, 8)}`;
}

function claimDir(scope: string, env: NodeJS.ProcessEnv): string {
  return join(swarmPaths(env).claims, scopeKey(scope));
}

export function claimScope(input: {
  scope: string;
  owner: string;
  leaseSeconds: number;
  force?: boolean;
  taskId?: string | null;
}, env: NodeJS.ProcessEnv = process.env): ScopeClaim {
  const scope = input.scope.trim();
  if (!scope) throw new SwarmError("a scope cannot be empty");
  const dir = claimDir(scope, env);
  const expiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
  const payload = (): ScopeClaim => ({
    scope,
    key: scopeKey(scope),
    owner: input.owner,
    claimedAt: nowIso(),
    expiresAt,
    taskId: input.taskId ?? null,
  });
  try {
    mkdirSync(swarmPaths(env).claims, { recursive: true });
    mkdirSync(dir); // atomic: EEXIST when someone already holds it
    writeJsonAtomic(join(dir, "claim.json"), payload());
  } catch {
    const held = readJson<ScopeClaim>(join(dir, "claim.json"));
    if (held && held.owner === input.owner) {
      const renewed = { ...held, expiresAt };
      writeJsonAtomic(join(dir, "claim.json"), renewed);
      return renewed;
    }
    const expired = !held || Date.parse(held.expiresAt) < Date.now();
    if (!input.force && !expired) {
      throw new SwarmError(`scope '${scope}' is held by ${held?.owner ?? "someone"} until ${held?.expiresAt ?? "unknown"}`, 4);
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const fresh = payload();
    writeJsonAtomic(join(dir, "claim.json"), fresh);
    logSwarmEvent(env, "scope", { scope, action: "reclaim", by: input.owner, was: held?.owner ?? null });
    return fresh;
  }
  const created = payload();
  logSwarmEvent(env, "scope", { scope, action: "claim", by: input.owner });
  return created;
}

export function releaseScope(scope: string, owner: string, force = false, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = claimDir(scope, env);
  const held = readJson<ScopeClaim>(join(dir, "claim.json"));
  if (!held) {
    rmSync(dir, { recursive: true, force: true });
    return false;
  }
  if (held.owner !== owner && !force) {
    throw new SwarmError(`scope '${scope}' is held by ${held.owner}`, 4);
  }
  rmSync(dir, { recursive: true, force: true });
  logSwarmEvent(env, "scope", { scope, action: "release", by: owner });
  return true;
}

export function listClaims(env: NodeJS.ProcessEnv = process.env): ScopeClaim[] {
  const dir = swarmPaths(env).claims;
  let keys: string[];
  try {
    keys = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ScopeClaim[] = [];
  for (const key of keys) {
    const held = readJson<ScopeClaim>(join(dir, key, "claim.json"));
    if (held) out.push(held);
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope));
}

/** Everything a departing agent was holding, so nobody is stuck behind a dead pid. */
export function releaseHeldBy(owner: string, env: NodeJS.ProcessEnv = process.env): { scopes: string[]; tasks: string[] } {
  const scopes: string[] = [];
  for (const held of listClaims(env)) {
    if (held.owner !== owner) continue;
    rmSync(claimDir(held.scope, env), { recursive: true, force: true });
    scopes.push(held.scope);
    logSwarmEvent(env, "scope", { scope: held.scope, action: "release", by: owner, reason: "owner left" });
  }
  const tasks: string[] = [];
  for (const task of listTasks(env)) {
    if (task.status !== "claimed" || task.owner !== owner) continue;
    putTask(
      {
        ...task,
        status: "open",
        owner: null,
        leaseUntil: null,
        history: [...task.history, { ts: nowIso(), by: owner, what: "released (owner left)" }],
      },
      env,
    );
    rmSync(taskClaimDir(task.id, env), { recursive: true, force: true });
    tasks.push(task.id);
  }
  return { scopes, tasks };
}

// ---------------------------------------------------------------------------
// worker slots — the cap, with no daemon holding a counter
// ---------------------------------------------------------------------------
export function reapSlots(env: NodeJS.ProcessEnv = process.env): number[] {
  const dir = swarmPaths(env).slots;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const freed: number[] = [];
  for (const file of files) {
    const slot = readJson<{ index: number; name: string; pid: number | null; at?: string }>(join(dir, file));
    if (!slot) {
      rmSync(join(dir, file), { force: true });
      continue;
    }
    if (slot.pid && pidAlive(slot.pid)) continue; // a live supervisor owns it
    const ageMs = slot.at ? Date.now() - Date.parse(slot.at) : Number.POSITIVE_INFINITY;
    if (!slot.pid && ageMs < 60_000) continue; // reserved by a spawn still in flight
    rmSync(join(dir, file), { force: true });
    freed.push(slot.index);
    logSwarmEvent(env, "slot", { action: "reap", name: slot.name, index: slot.index });
  }
  return freed;
}

function slotPath(index: number, env: NodeJS.ProcessEnv): string {
  return join(swarmPaths(env).slots, `${index}.json`);
}

export function takeSlot(name: string, env: NodeJS.ProcessEnv = process.env): number {
  reapSlots(env);
  const cfg = loadSwarmConfig(env);
  mkdirSync(swarmPaths(env).slots, { recursive: true });
  for (let index = 0; index < cfg.maxWorkers; index++) {
    const path = slotPath(index, env);
    if (existsSync(path)) continue;
    try {
      // The pid is bound to the supervisor once spawned — never this process's,
      // which exits immediately and would make the slot look stale to the next
      // command (that is how a "cap" quietly stops capping anything).
      writeFileSync(path, `${JSON.stringify({ index, name, pid: null, reservedBy: process.pid, at: nowIso() })}\n`, {
        flag: "wx",
      });
      return index;
    } catch {
      continue;
    }
  }
  throw new SwarmError(
    `worker limit reached (${cfg.maxWorkers}) — stop one with the swarm tool's "stop" action, or raise maxWorkers in ${swarmPaths(env).config}`,
    4,
  );
}

export function bindSlot(index: number, name: string, pid: number | null, env: NodeJS.ProcessEnv = process.env): void {
  // The directory is created here as well as in takeSlot: this is also the
  // repair path (`swarm reap`, tests) and a missing dir must never be the
  // reason a worker's slot cannot be recorded.
  mkdirSync(swarmPaths(env).slots, { recursive: true });
  writeJsonAtomic(slotPath(index, env), { index, name, pid, at: nowIso() });
}

export function releaseSlot(name: string, env: NodeJS.ProcessEnv = process.env): void {
  const dir = swarmPaths(env).slots;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const file of files) {
    const slot = readJson<{ name: string }>(join(dir, file));
    if (slot?.name === name) rmSync(join(dir, file), { force: true });
  }
}

export function activeSlotNames(env: NodeJS.ProcessEnv = process.env): string[] {
  reapSlots(env);
  const dir = swarmPaths(env).slots;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => readJson<{ name: string }>(join(dir, f))?.name)
    .filter((n): n is string => Boolean(n))
    .sort();
}

// ---------------------------------------------------------------------------
// the brief a worker starts with
// ---------------------------------------------------------------------------
export const SWARM_BUS_HELP = [
  "  free-pi-cli swarm inbox                  read mail addressed to you (marks it read)",
  '  free-pi-cli swarm send --to <name> "…"   message one session',
  '  free-pi-cli swarm send --all "…"         message every session',
  "  free-pi-cli swarm roster                 who is here and what they hold",
  "  free-pi-cli swarm task list              the board",
  "  free-pi-cli swarm task claim <id>        take a task (exactly one owner wins)",
  "  free-pi-cli swarm claim <scope>          exclusive claim on a target",
  "  free-pi-cli swarm release <scope>        hand it back when you are done",
  '  free-pi-cli swarm task done <id> --evidence "what you proved"',
  '  free-pi-cli swarm finding add --title "…" --invariant "what it breaks"   put a hypothesis on the ledger',
  '  free-pi-cli swarm finding status <id> poc --evidence "test/x.t.sol"        every state needs its evidence',
  '  free-pi-cli swarm finding next                                            the one thing to do next',
].join("\n");

export function buildWorkerBrief(input: {
  name: string;
  role: string;
  cwd: string;
  task?: Task | null;
  extra?: string;
}): string {
  const role = roleBrief(input.role);
  const task = input.task;
  return [
    `You are ${input.name}, a ${input.role} agent in a free-pi swarm. You are one of several sessions working in parallel — each in its own process, each paid for from its own free-pi session.`,
    `Your working directory is ${input.cwd}.`,
    role ? `\n# Your role\n\n${role}` : "",
    task
      ? `\n# Your assignment\n\nTask ${task.id}: ${task.title}\n\n${task.detail}${task.scope ? `\n\nScope: ${task.scope}` : ""}`
      : "\n# Your assignment\n\nNo task id was handed to you: read the board (`free-pi-cli swarm task list`) and claim the most valuable open task before starting.",
    `\n# Talking to the other sessions\n\nThere is no tool for this: run the CLI from bash. Your name is already in FREEPI_SWARM_AGENT, so it needs no --to me.`,
    SWARM_BUS_HELP,
    [
      "\n# Rules of engagement",
      "",
      "1. Never test or edit a scope someone else holds (`free-pi-cli swarm roster` shows holders). That is what stops two of us burning the same allowance on the same target.",
      "2. Announce findings on the bus the moment you have them — `swarm send --all --kind finding \"…\"` — not only in your own log. Another session may be blocked on what you just learned.",
      "3. If you need a human decision, say so explicitly (`--kind question`) and keep working on something else meanwhile.",
      '4. Finish by recording the outcome: `swarm task done <id> --evidence "<reproduction>"` (or `task fail <id> --result "<why>"`). A task left claimed blocks everyone behind your lease.',
      "5. Stop at the smallest proof. No destructive payloads, no data exfiltration, nothing outside the scope on the board.",
    ].join("\n"),
    input.extra ? `\n# Note from the coordinator\n\n${input.extra}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}
