// The findings ledger: what has been tested on a target, what it proved, and what
// is dead — so no session (and no rotation) pays for the same work twice.
//
// WHY THIS IS THE MONEY FILE. An agent hunting bugs loses most of its allowance to
// two things that are not hunting: re-deriving a fact it already established, and
// carrying a dozen half-tested suspicions that never become a report. The ledger
// is deliberately the smallest structure that prevents both:
//
//   lead → testing → poc → proven | dead | duplicate
//
// and it will not let a row move without the evidence that makes it worth
// anything: a `testing` row needs the invariant being attacked, a `poc` row needs
// a reproduction, a `proven` row needs an impact sentence (which asset, what the
// attacker gets), a `dead` row needs the reason it is not exploitable, and a
// `duplicate` row needs the prior report it matches. The transitions are the
// product: they are what turn "this rounding looks odd" into either a submission
// or a recorded kill instead of another zombie hypothesis.
//
// State is plain files under the swarm directory (~/.free-pi/swarm/findings), so
// every session — the coordinator, a deployed worker, a session that just rotated
// — reads and writes the same ledger with no daemon, no database and no account.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SwarmError, assertName, logSwarmEvent, nowIso, readJson, swarmPaths, writeJsonAtomic } from "./store";

export const FINDING_STATUSES = ["lead", "testing", "poc", "proven", "dead", "duplicate"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "unknown"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** How many hypotheses one session may hold open at once. See `nextFindingAction`. */
export const MAX_ACTIVE = 2;

/** The marker the digest carries inside a system prompt, so it is added only once. */
export const LEDGER_MARKER = "[free-pi findings ledger]";

/** Caps for the digest: it rides in the system prompt of every request. */
export const MAX_DIGEST_CHARS = 900;
export const MAX_DIGEST_LEADS = 3;
export const MAX_DIGEST_DEAD = 6;

export interface Finding {
  id: string;
  /** The program/bug-bounty target this belongs to (e.g. "twyne"). */
  target: string;
  /** One line: what is wrong. */
  title: string;
  status: FindingStatus;
  severity: FindingSeverity;
  /** Where it lives: `path/Contract.sol:142`, a URL, a host. */
  location: string;
  /** The invariant believed broken — required before a lead becomes `testing`. */
  invariant: string;
  /** One sentence of impact: which asset, and what an attacker gains. */
  impact: string;
  /** The reproduction: a PoC path, or the exact command that demonstrates it. */
  evidence: string;
  /** Why it is not exploitable after all — required to mark something `dead`. */
  killed: string;
  /** For `duplicate`: the prior report/issue this matches. */
  duplicateOf: string;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
  history: Array<{ ts: string; by: string; what: string }>;
}

export type FindingPatch = Partial<{
  title: string;
  location: string;
  invariant: string;
  impact: string;
  evidence: string;
  killed: string;
  duplicateOf: string;
  target: string;
}>;

/**
 * A move on the ledger. `status`/`severity` are plain strings on purpose: callers
 * pass whatever a command line or a tool call produced, and the validators below
 * are what reject a bad value with a message worth reading.
 */
export interface FindingUpdate extends FindingPatch {
  id: string;
  status: string;
  by: string;
  severity?: string;
}

export function isFindingStatus(value: string): value is FindingStatus {
  return (FINDING_STATUSES as readonly string[]).includes(value);
}

export function isFindingSeverity(value: string): value is FindingSeverity {
  return (FINDING_SEVERITIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

export function findingsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(swarmPaths(env).dir, "findings");
}

function findingPath(id: string, env: NodeJS.ProcessEnv): string {
  return join(findingsDir(env), `${assertName("finding id", id)}.json`);
}

export function ensureLedgerDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = findingsDir(env);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Every finding on every target, oldest id first. */
export function listFindings(env: NodeJS.ProcessEnv = process.env): Finding[] {
  const dir = findingsDir(env);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Finding[] = [];
  for (const file of files) {
    const finding = readJson<Finding>(join(dir, file));
    if (finding?.id && finding.status) out.push(finding);
  }
  return out.sort((a, b) => idNumber(a.id) - idNumber(b.id) || a.id.localeCompare(b.id));
}

function idNumber(id: string): number {
  const match = /^F-(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function getFinding(id: string, env: NodeJS.ProcessEnv = process.env): Finding | null {
  return readJson<Finding>(findingPath(id, env));
}

export function putFinding(finding: Finding, env: NodeJS.ProcessEnv = process.env): Finding {
  ensureLedgerDir(env);
  const next = { ...finding, updatedAt: nowIso() };
  writeJsonAtomic(findingPath(finding.id, env), next);
  return next;
}

/** The next id in the sequence. Ids are sequential because humans cite them. */
export function nextFindingId(env: NodeJS.ProcessEnv = process.env): string {
  const used = new Set(listFindings(env).map((finding) => finding.id));
  for (let n = 1; n < 100_000; n++) {
    const candidate = `F-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new SwarmError("the ledger is full (100000 findings) — start a new target directory", 5);
}

export function addFinding(
  input: {
    id?: string;
    title: string;
    by: string;
    target?: string;
    severity?: string;
    location?: string;
    invariant?: string;
    impact?: string;
    evidence?: string;
    status?: string;
    owner?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): Finding {
  const title = (input.title ?? "").trim();
  if (!title) throw new SwarmError("a finding needs a one-line title");
  const severity = (input.severity ?? "unknown").trim().toLowerCase();
  if (!isFindingSeverity(severity)) {
    throw new SwarmError(`severity must be one of ${FINDING_SEVERITIES.join("|")} (got "${input.severity}")`);
  }
  const status = (input.status ?? "lead").trim().toLowerCase();
  if (!isFindingStatus(status)) {
    throw new SwarmError(`status must be one of ${FINDING_STATUSES.join("|")} (got "${input.status}")`);
  }

  const id = assertName("finding id", input.id?.trim() || nextFindingId(env));
  if (getFinding(id, env)) throw new SwarmError(`finding ${id} already exists`, 4);

  const finding: Finding = {
    id,
    target: (input.target ?? "").trim(),
    title,
    status: "lead",
    severity,
    location: (input.location ?? "").trim(),
    invariant: (input.invariant ?? "").trim(),
    impact: (input.impact ?? "").trim(),
    evidence: (input.evidence ?? "").trim(),
    killed: "",
    duplicateOf: "",
    owner: input.owner ?? input.by ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    history: [{ ts: nowIso(), by: input.by, what: `created as lead` }],
  };

  // Creating straight into a later state is allowed (`--status poc` when a PoC
  // already exists), but it has to satisfy the same rules as moving there.
  if (status !== "lead") {
    finding.status = "testing";
    putFinding(finding, env);
    return setFindingStatus(
      {
        id,
        status,
        by: input.by,
        severity: input.severity,
        location: input.location,
        invariant: input.invariant,
        impact: input.impact,
        evidence: input.evidence,
      },
      env,
    );
  }
  putFinding(finding, env);
  logSwarmEvent(env, "finding", { id, action: "add", by: input.by, title, severity });
  return finding;
}

// ---------------------------------------------------------------------------
// transitions — the discipline that makes a finding worth something
// ---------------------------------------------------------------------------

const ALLOWED: Record<FindingStatus, FindingStatus[]> = {
  lead: ["testing", "dead", "duplicate"],
  // testing → proven directly is allowed for the case it actually happens in: the
  // reproduction already exists (a scratch path, a copied trace) and all that is
  // missing is the impact sentence. The evidence rules still apply, so nothing is
  // skipped — only the extra hop through `poc`.
  testing: ["poc", "proven", "lead", "dead", "duplicate"],
  poc: ["proven", "testing", "dead", "duplicate"],
  proven: ["duplicate", "dead"],
  dead: ["testing"],
  duplicate: ["dead"],
};

/**
 * What this transition still needs. Pure, so the rules can be read and tested
 * without touching a ledger on disk. An empty array means the move is allowed.
 */
export function checkTransition(from: FindingStatus, to: FindingStatus, fields: FindingPatch = {}): string[] {
  if (from === to) return [];
  if (!ALLOWED[from].includes(to)) {
    return [`${from} → ${to} is not a step this ledger takes (allowed: ${ALLOWED[from].join(" | ") || "nothing"})`];
  }
  const missing: string[] = [];
  const has = (value: string | undefined): boolean => typeof value === "string" && value.trim() !== "";
  switch (to) {
    case "testing":
      if (from === "lead" && !has(fields.invariant)) missing.push("invariant (what you believe is broken — a lead without one is a hunch, not a hypothesis)");
      break;
    case "poc":
      if (!has(fields.evidence)) missing.push("evidence (the PoC path or the exact command)");
      break;
    case "proven":
      if (!has(fields.evidence)) missing.push("evidence (the reproduction a verifier can run)");
      if (!has(fields.impact)) missing.push("impact (which asset, and what the attacker gains)");
      break;
    case "dead":
      if (!has(fields.killed)) missing.push("killed (why it is not exploitable — this is what stops the next session re-testing it)");
      break;
    case "duplicate":
      if (!has(fields.duplicateOf)) missing.push("duplicateOf (the prior report/issue it matches)");
      break;
    default:
      break;
  }
  return missing;
}

export function setFindingStatus(input: FindingUpdate, env: NodeJS.ProcessEnv = process.env): Finding {
  const current = getFinding(input.id, env);
  if (!current) throw new SwarmError(`no finding ${input.id} in the ledger`, 3);
  const to = input.status.trim().toLowerCase();
  if (!isFindingStatus(to)) {
    throw new SwarmError(`status must be one of ${FINDING_STATUSES.join("|")} (got "${input.status}")`);
  }
  if (input.severity !== undefined && !isFindingSeverity(String(input.severity).trim().toLowerCase())) {
    throw new SwarmError(`severity must be one of ${FINDING_SEVERITIES.join("|")} (got "${input.severity}")`);
  }

  // Fields are merged before the check, so a transition can be satisfied by the
  // same call that makes it (the normal case: `status poc --evidence test/x.t.sol`).
  const merged: Finding = {
    ...current,
    ...definedFields(input),
    severity: input.severity !== undefined ? (String(input.severity).trim().toLowerCase() as FindingSeverity) : current.severity,
  };
  const problems = checkTransition(current.status, to, merged);
  if (problems.length > 0) {
    throw new SwarmError(`${input.id}: cannot move to ${to} yet — ${problems.join("; ")}`, 5);
  }

  const next: Finding = {
    ...merged,
    status: to,
    history: [...current.history, { ts: nowIso(), by: input.by, what: `${current.status} → ${to}` }],
  };
  putFinding(next, env);
  logSwarmEvent(env, "finding", { id: next.id, action: "status", from: current.status, to, by: input.by });
  return next;
}

function definedFields(input: FindingPatch): FindingPatch {
  const out: FindingPatch = {};
  for (const key of ["title", "location", "invariant", "impact", "evidence", "killed", "duplicateOf", "target"] as const) {
    const value = input[key];
    if (typeof value === "string") out[key] = value.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// what to do next
// ---------------------------------------------------------------------------

export interface NextStep {
  /** The row to work, or null when there is nothing worth starting. */
  finding: Finding | null;
  /** The instruction, written to be followed literally. */
  action: string;
  /** Which rule chose it — useful in a log, and asserted in tests. */
  reason: string;
}

const severityRank: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
const byValue = (a: Finding, b: Finding): number =>
  severityRank[a.severity] - severityRank[b.severity] || a.createdAt.localeCompare(b.createdAt);

/**
 * The single next action, chosen so that money comes before curiosity:
 * a `proven` row is a report waiting to be written, a `poc` row is one step from
 * that, an unfinished `testing` row is a hypothesis that must be resolved rather
 * than left to rot, and only then does a new `lead` deserve attention.
 *
 * Past `MAX_ACTIVE` open rows it stops handing out new leads entirely and says
 * which ones to close first: a session with six live hypotheses finishes none,
 * which is the most expensive failure mode this whole file exists to prevent.
 */
export function nextFindingAction(
  findings: Finding[],
  opts: { target?: string } = {},
): NextStep {
  const rows = opts.target ? findings.filter((finding) => finding.target === opts.target) : findings;
  const proven = rows.filter((f) => f.status === "proven").sort(byValue);
  const poc = rows.filter((f) => f.status === "poc").sort(byValue);
  const testing = rows.filter((f) => f.status === "testing").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const leads = rows.filter((f) => f.status === "lead").sort(byValue);

  if (proven.length > 0) {
    const finding = proven[0]!;
    return {
      finding,
      reason: "proven",
      action: `${finding.id} is proven — write the submission now (impact sentence + the reproduction in ${finding.evidence || "the ledger"}), then mark it duplicate if someone filed it first.`,
    };
  }
  if (poc.length > 0) {
    const finding = poc[0]!;
    return {
      finding,
      reason: "poc",
      action: `${finding.id} has a PoC — finish it: run ${finding.evidence} end to end, write the one-sentence impact, and move it to proven (or kill it with the reason).`,
    };
  }
  if (testing.length > 0) {
    const finding = testing[0]!;
    const openCount = testing.length + poc.length;
    return {
      finding,
      reason: openCount > MAX_ACTIVE ? "too-many-open" : "testing",
      action:
        openCount > MAX_ACTIVE
          ? `You have ${openCount} hypotheses open (${[...testing, ...poc].map((f) => f.id).join(", ")}). Finish or kill one before starting anything new — begin with ${finding.id}, untouched the longest: "${finding.title}".`
          : `${finding.id} is still being tested — resolve it before opening anything new: prove it (needs evidence + impact), or kill it with the reason why "${finding.invariant || finding.title}" holds.`,
    };
  }
  if (leads.length > 0) {
    const finding = leads[0]!;
    return {
      finding,
      reason: "lead",
      action: `${finding.id} is the next lead — name the invariant you believe is broken (${finding.invariant ? `you wrote: ${finding.invariant}` : "none recorded yet"}), then attack it until you have a reproduction or a reason it cannot be broken.`,
    };
  }
  return {
    finding: null,
    reason: "empty",
    action: "The ledger is empty: recon the target, write down the invariants the money depends on, and put each one on the ledger as a lead before you start reading for bugs.",
  };
}

// ---------------------------------------------------------------------------
// rendering: the digest (system prompt) and the brief (rotation)
// ---------------------------------------------------------------------------

/** The one target every row belongs to, when there is exactly one. */
export function singleTarget(findings: Finding[]): string | undefined {
  const named = [...new Set(findings.map((finding) => finding.target).filter((value) => value !== ""))];
  return named.length === 1 ? named[0] : undefined;
}

export function countByStatus(findings: Finding[]): Record<FindingStatus, number> {
  const counts = { lead: 0, testing: 0, poc: 0, proven: 0, dead: 0, duplicate: 0 } as Record<FindingStatus, number>;
  for (const finding of findings) counts[finding.status]++;
  return counts;
}

/** `1 proven · 1 poc · 2 testing · 4 dead` — what the run has to show for itself. */
export function statusLine(findings: Finding[]): string {
  const counts = countByStatus(findings);
  // Ordered as the work matters, not as the states are defined: what is proven
  // first, dead ends last (they are a result, but never the headline).
  const order: FindingStatus[] = ["proven", "poc", "testing", "lead", "duplicate", "dead"];
  return order
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(" · ");
}

/**
 * The ledger as a handful of lines for a system prompt: what is proven, what to
 * do next, what is in flight, what is dead *and must not be re-tested*. The dead
 * list is the point — it is the one line that saves a session an hour.
 */
export function renderLedgerDigest(
  findings: Finding[],
  opts: { target?: string; maxChars?: number } = {},
): string {
  const rows = opts.target ? findings.filter((finding) => finding.target === opts.target) : findings;
  if (rows.length === 0) return "";
  const maxChars = opts.maxChars ?? MAX_DIGEST_CHARS;

  // Name the target only when there is no doubt which one it is: a digest that
  // says "twyne" while showing another program's rows is worse than no label.
  const target = opts.target ?? singleTarget(rows) ?? "";
  const next = nextFindingAction(rows);
  const dead = rows.filter((f) => f.status === "dead");
  const leads = rows.filter((f) => f.status === "lead").sort(byValue);
  const inFlight = rows.filter((f) => f.status === "testing" || f.status === "poc").sort(byValue);

  const essential = [
    `${LEDGER_MARKER}${target ? ` ${target}` : ""}`,
    `${statusLine(rows)} — ${rows.length} finding(s) on file. Tested and killed is a result, not a gap: do not re-open a dead row.`,
    `NEXT: ${next.finding ? next.action : next.action}`,
  ];
  const optional = [
    ...inFlight.slice(0, MAX_DIGEST_LEADS).map((f) => `IN FLIGHT: ${f.id} ${f.status} (${f.severity}) — ${f.title}${f.location ? ` [${f.location}]` : ""}`),
    ...leads.slice(0, MAX_DIGEST_LEADS).map((f) => `LEAD: ${f.id} (${f.severity}) — ${f.title}${f.location ? ` [${f.location}]` : ""}`),
    dead.length > 0
      ? `DEAD (do not re-test): ${dead.slice(0, MAX_DIGEST_DEAD).map((f) => `${f.id} ${f.title}`).join("; ")}${dead.length > MAX_DIGEST_DEAD ? `; +${dead.length - MAX_DIGEST_DEAD} more` : ""}`
      : "",
  ].filter((line) => line !== "");

  const lines = [...essential];
  for (const line of optional) {
    if (lines.join("\n").length + line.length + 1 > maxChars) break;
    lines.push(line);
  }
  return lines.join("\n").slice(0, maxChars);
}

/**
 * The ledger as a rotation's four-sentence brief — machine-accurate, and free of
 * whatever the ending session felt like saying. Used when the session's own
 * closing reply is unusable; the counts and the next action are always true.
 */
export function briefFromLedger(findings: Finding[], opts: { target?: string } = {}): string | null {
  const rows = opts.target ? findings.filter((finding) => finding.target === opts.target) : findings;
  if (rows.length === 0) return null;
  const counts = countByStatus(rows);
  const next = nextFindingAction(rows);
  const dead = rows.filter((f) => f.status === "dead");
  const proven = rows.filter((f) => f.status === "proven").sort(byValue);
  const target = opts.target ?? singleTarget(rows) ?? "the ledger's target";

  const sentences = [
    `Work on ${target} has ${rows.length} hypotheses on the ledger: ${counts.proven} proven, ${counts.poc} with a proof of concept, ${counts.testing} still being tested, ${counts.lead} untested leads, and ${counts.dead + counts.duplicate} closed as dead or duplicate.`,
    proven.length > 0
      ? `Money on the table: ${proven.slice(0, 3).map((f) => `${f.id} (${f.severity}) ${f.title}`).join("; ")} — write these up before testing anything new.`
      : `Nothing is proven yet, so the next session's job is to turn one hypothesis into a reproduction, not to start another line of enquiry.`,
    next.finding ? `Next: ${next.action}` : `There is nothing left to test on the ledger.`,
    dead.length > 0
      ? `Do not re-test ${dead.slice(0, 4).map((f) => f.id).join(", ")}: each is recorded dead with the reason it cannot be exploited, in the ledger.`
      : `No dead ends are recorded yet, so record the reason whenever something is killed — that is what stops the next session paying for it twice.`,
  ];
  return sentences.join(" ");
}
