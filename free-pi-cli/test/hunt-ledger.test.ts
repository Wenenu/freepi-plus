// The findings ledger: the states a hypothesis passes through, the evidence each
// move requires, which row to work next, and the two renderings that ride along
// with a session (the system-prompt digest and the rotation's brief).
//
// The rules are the product here, so they are asserted directly: a lead with no
// invariant is a hunch, a PoC with no reproduction is a claim, a proven row with
// no impact sentence is worth nothing to the human who has to file it, and a dead
// row with no reason is the thing that costs the next session an hour.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_MARKER,
  MAX_ACTIVE,
  addFinding,
  briefFromLedger,
  checkTransition,
  countByStatus,
  getFinding,
  listFindings,
  nextFindingAction,
  renderLedgerDigest,
  setFindingStatus,
  singleTarget,
  statusLine,
  type Finding,
} from "../src/swarm/ledger";

let dir = "";
let env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "free-pi-ledger-"));
  env = { FREEPI_SWARM_DIR: dir };
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // windows handle
  }
});

/** A finding in memory, for the pure-function tests. */
function row(over: Partial<Finding> = {}): Finding {
  const base: Finding = {
    id: "F-1",
    target: "twyne",
    title: "liquidation threshold is unit-inconsistent",
    status: "lead",
    severity: "high",
    location: "src/twyne/EulerCollateralVault.sol:142",
    invariant: "",
    impact: "",
    evidence: "",
    killed: "",
    duplicateOf: "",
    owner: "coordinator",
    createdAt: "2026-10-13T02:00:00.000Z",
    updatedAt: "2026-10-13T02:00:00.000Z",
    history: [],
  };
  return { ...base, ...over };
}

describe("the ledger's transitions", () => {
  test("a lead needs an invariant before it can be tested", () => {
    expect(checkTransition("lead", "testing", {})).toHaveLength(1);
    expect(checkTransition("lead", "testing", { invariant: "debt ≤ collateral × LTV" })).toEqual([]);
  });

  test("each later state needs the evidence that makes it worth something", () => {
    expect(checkTransition("testing", "poc", {})).toEqual([expect.stringContaining("evidence")]);
    expect(checkTransition("testing", "poc", { evidence: "test/twyne/x.t.sol" })).toEqual([]);
    expect(checkTransition("poc", "proven", { evidence: "test/twyne/x.t.sol" })).toEqual([
      expect.stringContaining("impact"),
    ]);
    expect(checkTransition("poc", "proven", { evidence: "test/x.t.sol", impact: "drains 40 wei of eWETH" })).toEqual([]);
    expect(checkTransition("testing", "dead", {})).toEqual([expect.stringContaining("killed")]);
    expect(checkTransition("testing", "dead", { killed: "guard reverts before the branch" })).toEqual([]);
    expect(checkTransition("proven", "duplicate", {})).toEqual([expect.stringContaining("duplicateOf")]);
  });

  test("the graph does not let a proven row be un-proven by a status edit", () => {
    expect(checkTransition("proven", "testing", {})).toEqual([expect.stringContaining("not a step")]);
    expect(checkTransition("proven", "lead", {})).toEqual([expect.stringContaining("not a step")]);
    // Reclassifying is fine; losing the proof is not.
    expect(checkTransition("proven", "dead", { killed: "mitigated in the upgrade" })).toEqual([]);
    // And a dead end can be revived when new evidence turns up.
    expect(checkTransition("dead", "testing", {})).toEqual([]);
  });
});

describe("the ledger on disk", () => {
  test("ids are sequential, and a bad move is refused with the reason", () => {
    const first = addFinding({ title: "rounding favours the borrower", by: "coordinator", target: "kelp" }, env);
    expect(first.id).toBe("F-1");
    expect(first.status).toBe("lead");
    const second = addFinding(
      { title: "unchecked return", by: "coordinator", invariant: "every external call is checked" },
      env,
    );
    expect(second.id).toBe("F-2");
    expect(listFindings(env).map((f) => f.id)).toEqual(["F-1", "F-2"]);
    expect(getFinding("F-1", env)?.title).toBe("rounding favours the borrower");

    expect(() => setFindingStatus({ id: "F-1", status: "testing", by: "hunter" }, env)).toThrow(/invariant/);
    const moved = setFindingStatus(
      { id: "F-1", status: "testing", by: "hunter", invariant: "fees never accrue to the protocol" },
      env,
    );
    expect(moved.status).toBe("testing");
    expect(moved.history.map((h) => h.what)).toEqual(["created as lead", "lead → testing"]);
    // An invariant recorded when the row was created already satisfies the move.
    expect(setFindingStatus({ id: "F-2", status: "testing", by: "hunter" }, env).invariant).toBe(
      "every external call is checked",
    );

    // The same call that supplies the missing field is the one that moves it.
    expect(() => setFindingStatus({ id: "F-1", status: "poc", by: "hunter" }, env)).toThrow(/evidence/);
    const poc = setFindingStatus({ id: "F-1", status: "poc", by: "hunter", evidence: "test/kelp/Rounding.t.sol" }, env);
    expect(poc.evidence).toBe("test/kelp/Rounding.t.sol");
    expect(poc.status).toBe("poc");

    const proven = setFindingStatus(
      { id: "F-1", status: "proven", by: "verifier", impact: "a depositor's accrued fee is 1 wei short, repeatable" },
      env,
    );
    expect(proven.status).toBe("proven");

    expect(() => addFinding({ title: "bad severity", by: "me", severity: "catastrophic" }, env)).toThrow(/severity/);
    expect(() => addFinding({ title: "", by: "me" }, env)).toThrow(/title/);
    expect(listFindings(env)).toHaveLength(2);
  });

  test("a finding can be created straight into a state it qualifies for", () => {
    const poc = addFinding(
      { title: "first-hop slippage is unbounded", by: "hunter", status: "poc", evidence: "test/kelp/Slippage.t.sol", invariant: "output ≥ minOut" },
      env,
    );
    expect(poc.status).toBe("poc");
    expect(poc.evidence).toBe("test/kelp/Slippage.t.sol");
    // ...and it still cannot skip the steps (or the evidence) to get there.
    expect(() => addFinding({ title: "claim with no proof", by: "hunter", status: "proven" }, env)).toThrow(
      /not a step|evidence|impact/,
    );
  });
});

describe("what to do next", () => {
  test("money comes before curiosity: proven, then poc, then an unfinished test", () => {
    const findings = [
      row({ id: "F-1", status: "lead" }),
      row({ id: "F-2", status: "testing", invariant: "debt ≤ collateral × LTV" }),
      row({ id: "F-3", status: "poc", evidence: "test/x.t.sol" }),
    ];
    expect(nextFindingAction(findings).finding?.id).toBe("F-3");
    expect(nextFindingAction(findings).reason).toBe("poc");

    const withProven = [...findings, row({ id: "F-4", status: "proven", evidence: "test/y.t.sol", impact: "drain" })];
    const step = nextFindingAction(withProven);
    expect(step.finding?.id).toBe("F-4");
    expect(step.action).toContain("write the submission");
  });

  test("past the open-work limit it stops handing out new leads and says which to close", () => {
    const findings = [
      row({ id: "F-1", status: "lead", severity: "critical" }),
      row({ id: "F-2", status: "testing", updatedAt: "2026-10-13T01:00:00.000Z" }),
      row({ id: "F-3", status: "testing", updatedAt: "2026-10-13T01:30:00.000Z" }),
      row({ id: "F-4", status: "testing", updatedAt: "2026-10-13T02:00:00.000Z" }),
    ];
    const step = nextFindingAction(findings);
    expect(step.reason).toBe("too-many-open");
    // The one untouched the longest, not the newest.
    expect(step.finding?.id).toBe("F-2");
    expect(step.action).toContain("Finish or kill one");

    const exactlyAtLimit = findings.slice(0, MAX_ACTIVE + 1);
    expect(nextFindingAction(exactlyAtLimit).reason).toBe("testing");
  });

  test("an empty ledger asks for invariants before bugs", () => {
    const step = nextFindingAction([]);
    expect(step.finding).toBeNull();
    expect(step.reason).toBe("empty");
    expect(step.action).toContain("invariants");
  });

  test("a target scopes the choice, so one session is not handed another program's row", () => {
    const findings = [
      row({ id: "F-1", target: "kelp", status: "lead" }),
      row({ id: "F-2", target: "twyne", status: "lead" }),
    ];
    expect(nextFindingAction(findings, { target: "twyne" }).finding?.id).toBe("F-2");
  });
});

describe("the digest and the brief", () => {
  const rows = [
    row({ id: "F-1", status: "proven", severity: "critical", title: "oracle price is stale", evidence: "test/x.t.sol", impact: "borrow against a stale price" }),
    row({ id: "F-2", status: "poc", title: "second hop slippage", evidence: "test/y.t.sol" }),
    row({ id: "F-3", status: "dead", title: "reentrancy on withdraw", killed: "nonReentrant on the entrypoint" }),
    row({ id: "F-4", status: "dead", title: "unchecked return", killed: "call is to a trusted token" }),
    row({ id: "F-5", status: "lead", severity: "medium", title: "rounding in previewRedeem" }),
  ];

  test("the digest is small, names the counts, the next action and the dead ends", () => {
    const digest = renderLedgerDigest(rows);
    expect(digest.startsWith(LEDGER_MARKER)).toBe(true);
    expect(digest).toContain("twyne");
    // Money first: proven, then the PoC, then open leads, and the dead ends last.
    expect(statusLine(rows)).toBe("1 proven · 1 poc · 1 lead · 2 dead");
    expect(digest).toContain("1 proven");
    expect(digest).toContain("NEXT: F-1");
    expect(digest).toContain("DEAD (do not re-test)");
    expect(digest).toContain("F-3");
    expect(digest.length).toBeLessThanOrEqual(900);
    expect(countByStatus(rows)).toMatchObject({ proven: 1, poc: 1, dead: 2, lead: 1 });
  });

  test("an empty ledger contributes nothing to a system prompt", () => {
    expect(renderLedgerDigest([])).toBe("");
    expect(renderLedgerDigest([row({ target: "kelp" })], { target: "twyne" })).toBe("");
  });

  test("the digest does not label a mixed ledger with one program's name", () => {
    const mixed = [row({ id: "F-1", target: "kelp" }), row({ id: "F-2", target: "twyne" })];
    expect(singleTarget(mixed)).toBeUndefined();
    expect(renderLedgerDigest(mixed).split("\n")[0]).toBe(LEDGER_MARKER);
  });

  test("the brief is four sentences of ground truth, not a story", () => {
    const brief = briefFromLedger(rows) as string;
    expect(brief.split(/(?<=\.)\s+/)).toHaveLength(4);
    expect(brief).toContain("5 hypotheses");
    expect(brief).toContain("1 proven");
    expect(brief).toContain("Money on the table");
    expect(brief).toContain("F-1");
    expect(brief).toContain("Do not re-test F-3, F-4");
    expect(briefFromLedger([])).toBeNull();
  });

  test("with nothing proven the brief says what the job actually is", () => {
    const brief = briefFromLedger([row({ id: "F-1", status: "lead" })]) as string;
    expect(brief).toContain("Nothing is proven yet");
    expect(brief).toContain("not to start another line of enquiry");
  });
});
