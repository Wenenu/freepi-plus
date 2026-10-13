// The handoff a 3-hour rotation leaves behind: where the summary document is,
// which provider/model the ending session was using, and what the new session
// should be told. Everything here is pure (paths, JSON, prompt text, and the
// decision to relaunch) so the whole rotation can be tested without starting a
// TUI, spending allowance, or waiting three hours.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HANDOFF_VERSION = 1;

/**
 * How much of the handoff document is quoted into the new session. Generous on
 * purpose — the document *is* the context a rotation exists to carry — but
 * bounded, because a runaway summary must not itself fill the new context.
 */
export const MAX_HANDOFF_CHARS = 60_000;

/** Where rotations keep their summary documents and markers. */
export function handoffDir(agentDir: string): string {
  return join(agentDir, "handoff");
}

export function handoffPath(agentDir: string): string {
  return join(handoffDir(agentDir), "latest.json");
}

/** A file name that sorts, so successive summaries stay in order. */
export function summaryFileName(at: Date): string {
  return `summary-${at.toISOString().replace(/[:.]/g, "-")}.md`;
}

export function summaryPathFor(agentDir: string, at: Date): string {
  return join(handoffDir(agentDir), summaryFileName(at));
}

export interface RotationHandoff {
  version: number;
  createdAt: string;
  /** The session that wrote the summary — the one being replaced. */
  fromSessionId: string | null;
  /** Its session file, so the new session can read the raw history if it must. */
  fromSessionFile?: string | null;
  summaryPath: string;
  /** False when the summary was never written — the kickoff must not send the
   * new session to a file that does not exist. */
  summaryWritten?: boolean;
  cwd: string;
  provider: string | null;
  model: string | null;
  /** How many rotations have happened in this chain, this one included. */
  count: number;
  /** Set when the summary could not be written, so the next chat knows. */
  note?: string;
}

export function writeHandoff(agentDir: string, handoff: RotationHandoff): string {
  mkdirSync(handoffDir(agentDir), { recursive: true });
  const path = handoffPath(agentDir);
  writeFileSync(path, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function readHandoff(path: string): RotationHandoff | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RotationHandoff;
    if (parsed?.version !== HANDOFF_VERSION || typeof parsed.summaryPath !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** How many rotations this process chain has already done (0 for a fresh run). */
export function rotationCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.FREEPI_ROTATE_COUNT ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * The handoff document, ready to be put in front of the new session.
 *
 * `null` when there is nothing usable on disk. A document larger than
 * `maxChars` comes back with `truncated: true` and the caller points at the
 * file for the rest — a session handed a truncated summary plus the path is
 * strictly better off than one handed a path it may never open.
 */
export function readSummary(
  path: string,
  maxChars: number = MAX_HANDOFF_CHARS,
): { text: string; truncated: boolean } | null {
  if (!path) return null;
  try {
    if (!statSync(path).isFile() || statSync(path).size === 0) return null;
    const raw = readFileSync(path, "utf8");
    if (raw.trim() === "") return null;
    if (raw.length <= maxChars) return { text: raw, truncated: false };
    // Cut on a line boundary where there is one, so the quote does not end
    // mid-sentence.
    const head = raw.slice(0, maxChars);
    const lastNewline = head.lastIndexOf("\n");
    return { text: lastNewline > maxChars / 2 ? head.slice(0, lastNewline) : head, truncated: true };
  } catch {
    return null;
  }
}

/**
 * The message a rotation writes *into* the new session before it is opened.
 *
 * It is the belt to the kickoff prompt's braces: the new session has no memory,
 * and asking it to "read this file" only works if the model actually opens it.
 * Quoting the document into the transcript means the handoff is present even if
 * the first turn never touches the filesystem.
 */
export function handoffContext(handoff: RotationHandoff, summary: { text: string; truncated: boolean } | null): string {
  const head = [
    "[free-pi rotation] The previous session working on this task was rotated out to keep its context manageable.",
    summary
      ? "Its handoff document is quoted below. Treat it as your working state: continue the task from it."
      : "It did not leave a handoff document; pick the work up from the state of the working directory.",
  ];
  if (summary) {
    head.push("", `--- HANDOFF DOCUMENT (${handoff.summaryPath}) ---`, summary.text.trimEnd());
    if (summary.truncated) {
      head.push(
        `--- DOCUMENT TRUNCATED AT ${MAX_HANDOFF_CHARS} CHARACTERS — read the rest from ${handoff.summaryPath} ---`,
      );
    }
    head.push("--- END HANDOFF DOCUMENT ---");
  }
  if (handoff.note) head.push("", `Note from the rotation: ${handoff.note}`);
  return head.join("\n");
}

export interface RotationPolicy {
  /** A rotation is only honoured for a handoff at most this old. */
  maxAgeMs: number;
  maxRotations: number;
}

export const DEFAULT_ROTATION_POLICY: RotationPolicy = {
  maxAgeMs: 5 * 60 * 1000,
  maxRotations: 24,
};

/**
 * Should this process relaunch itself as a new session, or just exit?
 *
 * The guards are what keep a rotation from becoming a loop: a marker left over
 * from an old run, a marker whose summary is nowhere on disk, or a chain that
 * has already rotated its budget of times all end the process instead.
 */
export function rotationDecision(
  input: { handoff: RotationHandoff | null; summaryExists: boolean; rotationsDone: number; now?: number },
  policy: RotationPolicy = DEFAULT_ROTATION_POLICY,
): { relaunch: boolean; reason: string } {
  const { handoff, summaryExists, rotationsDone } = input;
  if (!handoff) return { relaunch: false, reason: "no handoff" };
  if (rotationsDone >= policy.maxRotations) {
    return { relaunch: false, reason: `rotation limit reached (${policy.maxRotations})` };
  }
  const age = (input.now ?? Date.now()) - Date.parse(handoff.createdAt);
  if (!Number.isFinite(age) || age < 0 || age > policy.maxAgeMs) {
    return { relaunch: false, reason: "handoff is stale" };
  }
  if (!summaryExists) return { relaunch: false, reason: "the summary document is missing" };
  return { relaunch: true, reason: "continue in a new session" };
}

/**
 * The first message of the new session. It names the summary document and tells
 * the agent to pick the work up from there — the whole point of rotating.
 */
export function handoffPrompt(handoff: RotationHandoff): string {
  if (!handoff.summaryPath || handoff.summaryWritten === false) {
    return [
      "You are continuing a long-running task in a new session. The previous session was rotated out to keep its context manageable, and it did not leave a summary document.",
      handoff.note ? `Note from the rotation: ${handoff.note}` : "",
      handoff.fromSessionFile
        ? `Its raw session history is at ${handoff.fromSessionFile} — read it if you need the details of what was already tried.`
        : "",
      "Pick the work up from the state of the working directory; do not ask what to do next and do not start over.",
      `Working directory: ${handoff.cwd}. Keep going until the task is genuinely complete.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const lines = [
    "You are continuing a long-running task in a new session. The previous session was rotated out to keep its context manageable.",
    "",
    `Its full handoff document is quoted in this session's context above, and the file is at: ${handoff.summaryPath}`,
    "Read the quoted document (or the file, if the quote was truncated) before doing anything else.",
    "It contains the task, what has already been done, what remains, and the next steps that were planned.",
  ];
  if (handoff.note) {
    lines.push("", `Note from the rotation: ${handoff.note}`);
  }
  lines.push(
    "",
    `Then continue the work exactly where it left off — no preamble, no re-planning from scratch, no asking what to do next. Working directory: ${handoff.cwd}.`,
    "Keep going until the task is genuinely complete.",
  );
  return lines.join("\n");
}
