// The brief: the four sentences a rotation injects into the next chat's system
// prompt. These are the pure parts — what counts as a usable brief, what happens
// to one that is too long, and what a fresh on-disk brief means. The rotation's
// use of them is asserted in rotate.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_MARKER,
  HANDOFF_VERSION,
  MAX_BRIEF_CHARS,
  briefFromDocument,
  briefPromptBlock,
  deriveBrief,
  freshBrief,
  latestBriefPath,
  readBrief,
  writeBrief,
  writeHandoff,
} from "../src/handoff";

let agentDir = "";

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "free-pi-handoff-"));
});

afterEach(() => {
  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch {
    // windows handle
  }
});

const sentence = (n: number) => `Point ${n} of the audit is settled and written up.`;

describe("deriveBrief — the agent's closing reply", () => {
  test("keeps four sentences and drops anything after them", () => {
    const reply = [sentence(1), sentence(2), sentence(3), sentence(4), sentence(5)].join(" ");
    const brief = deriveBrief(reply);
    expect(brief).toBe([sentence(1), sentence(2), sentence(3), sentence(4)].join(" "));
  });

  test("refuses a shrug: too short to orient a session that has no context", () => {
    expect(deriveBrief("Handoff written.")).toBeNull();
    expect(deriveBrief("HANDOFF READY")).toBeNull();
    expect(deriveBrief("")).toBeNull();
    expect(deriveBrief(null)).toBeNull();
  });

  test("cuts an over-long brief at a hard limit, and says it was cut", () => {
    const long = [1, 2, 3, 4].map(() => "x".repeat(500)).join(". ");
    const brief = deriveBrief(long) as string;
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(brief.endsWith("…")).toBe(true);
  });
});

describe("briefFromDocument — the fallback", () => {
  test("digests body prose and leaves headings and bullets out of it", () => {
    const document = [
      "# Handoff",
      "",
      "## Where the work stands",
      "- The vault math is verified clean.",
      "1. The composer is still untested.",
      "The remaining lead is the slippage bound, which nobody has fuzzed yet.",
      "Next: write a Foundry fork test for it and check the rounding direction.",
    ].join("\n");
    const brief = briefFromDocument(document) as string;
    expect(brief).toContain("vault math is verified clean");
    expect(brief).toContain("slippage bound");
    expect(brief).not.toContain("#");
    expect(brief).not.toContain("- ");
    expect(brief).not.toContain("1.");
  });

  test("nothing worth summarising is no brief at all", () => {
    expect(briefFromDocument("# Handoff\n\n## Notes\n")).toBeNull();
    expect(briefFromDocument("")).toBeNull();
    expect(briefFromDocument(null)).toBeNull();
  });
});

describe("briefPromptBlock — how it reaches the model", () => {
  test("is framed as background the session already knows, under a marker", () => {
    const block = briefPromptBlock(sentence(1));
    expect(block.startsWith(BRIEF_MARKER)).toBe(true);
    expect(block).toContain("do not answer it as if it were a request");
    expect(block).toContain(sentence(1));
  });
});

describe("the brief on disk", () => {
  test("writeBrief keeps a timestamped copy beside the latest one", () => {
    const at = new Date("2026-10-13T02:00:00.000Z");
    const path = writeBrief(agentDir, "  A settled brief.  ", at);
    expect(path).toContain("brief-2026-10-13T02-00-00-000Z.md");
    expect(readBrief(path)).toBe("A settled brief.");
    expect(readBrief(latestBriefPath(agentDir))).toBe("A settled brief.");
    expect(readFileSync(latestBriefPath(agentDir), "utf8").endsWith("\n")).toBe(true);
  });

  test("a missing or empty brief reads as none", () => {
    expect(readBrief(join(agentDir, "nope.md"))).toBeNull();
  });

  test("freshBrief only trusts a rotation recent enough to have made this session", () => {
    const now = Date.parse("2026-10-13T02:00:00.000Z");
    const handoff = (createdAt: string) => ({
      version: HANDOFF_VERSION,
      createdAt,
      fromSessionId: null,
      summaryPath: join(agentDir, "handoff", "summary.md"),
      cwd: agentDir,
      provider: "antseed",
      model: "deepseek-v4.1-flash",
      count: 1,
      brief: "Four sentences of where the work stands.",
      briefPath: latestBriefPath(agentDir),
    });

    writeHandoff(agentDir, handoff(new Date(now - 60_000).toISOString()));
    expect(freshBrief(agentDir, now)?.brief).toBe("Four sentences of where the work stands.");

    writeHandoff(agentDir, handoff(new Date(now - 30 * 60_000).toISOString()));
    expect(freshBrief(agentDir, now)).toBeNull();
  });

  test("a record with no brief hands over nothing", () => {
    writeHandoff(agentDir, {
      version: HANDOFF_VERSION,
      createdAt: new Date().toISOString(),
      fromSessionId: null,
      summaryPath: join(agentDir, "handoff", "summary.md"),
      cwd: agentDir,
      provider: null,
      model: null,
      count: 1,
    });
    expect(freshBrief(agentDir, Date.now())).toBeNull();
  });
});
