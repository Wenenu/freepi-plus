// The Antseed footer line: "[Antseed] <model> · $0.45 USDC left". Text comes
// from pi's footer renderer (modes/interactive/components/footer.js renders
// every ctx.ui.setStatus entry on its own line), so what this file pins down is
// the text itself, the cache that keeps a CLI spawn + on-chain read off the
// hot path, and the rule that the line exists only while antseed is active.
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { ANTSEED_PROVIDER_NAME, type AntseedBalance } from "../src/antseed";
import {
  ANTSEED_STATUS_KEY,
  antseedStatusPending,
  antseedStatusText,
  createAntseedBalanceReader,
  createAntseedStatusExtension,
  formatUsdc,
  shortModelId,
} from "../src/antseed-status";

const PEER_MODEL = "666e688780b9fdee5d2fe8ccafa666bb084c4666@gpt-6.1-sol";

const BALANCE: AntseedBalance = {
  address: "0x25108E51c7ecA58976320117C969cd021D869644",
  availableUsd: 0.45,
  reservedUsd: 2,
  connectionState: "connected",
  activeChannels: 2,
};

function factoryOf(ext: InlineExtension): (pi: ExtensionAPI) => void {
  return (typeof ext === "function" ? ext : ext.factory) as (pi: ExtensionAPI) => void;
}

/** Captures the handlers an extension registers, plus its status writes. */
function harness(ext: InlineExtension) {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  factoryOf(ext)({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers[name] = handler;
    },
  } as unknown as ExtensionAPI);

  const ctx = (model: { provider: string; id: string } | undefined) => ({
    model,
    ui: {
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      notify: (message: string) => notifications.push(message),
    },
  });

  return { handlers, statuses, notifications, ctx };
}

describe("antseed status text", () => {
  test("money is formatted as USDC with two decimals", () => {
    expect(formatUsdc(0.45)).toBe("$0.45");
    expect(formatUsdc(2)).toBe("$2.00");
    expect(formatUsdc(0)).toBe("$0.00");
    expect(formatUsdc(undefined)).toBe("?");
  });

  test("a peer id is shortened but the model name is kept readable", () => {
    expect(shortModelId(PEER_MODEL)).toBe("666e6887…@gpt-6.1-sol");
    expect(shortModelId("deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  test("the line carries the model and what is left", () => {
    expect(antseedStatusText(PEER_MODEL, BALANCE)).toBe(
      "[Antseed] 666e6887…@gpt-6.1-sol · $0.45 USDC left · $2.00 reserved",
    );
  });

  test("reserved funds and connection state only appear when they mean something", () => {
    expect(antseedStatusText("deepseek-v4-flash", { availableUsd: 1.5, reservedUsd: 0 })).toBe(
      "[Antseed] deepseek-v4-flash · $1.50 USDC left",
    );
    expect(
      antseedStatusText("deepseek-v4-flash", { availableUsd: 1.5, connectionState: "disconnected" }),
    ).toBe("[Antseed] deepseek-v4-flash · $1.50 USDC left · buyer disconnected");
  });

  test("an unreadable balance says so instead of showing a fake $0.00", () => {
    expect(antseedStatusText(PEER_MODEL, undefined)).toBe(
      "[Antseed] 666e6887…@gpt-6.1-sol · balance unavailable",
    );
    expect(antseedStatusPending(PEER_MODEL)).toContain("checking balance");
  });
});

describe("antseed balance cache", () => {
  test("a successful read is reused within the TTL and refreshed after a reset", async () => {
    let calls = 0;
    const reader = createAntseedBalanceReader({
      fetchBalance: async () => {
        calls++;
        return BALANCE;
      },
      ttlMs: 60_000,
    });

    expect(await reader.get()).toEqual(BALANCE);
    expect(await reader.get()).toEqual(BALANCE);
    expect(calls).toBe(1);

    reader.invalidate();
    await reader.get();
    expect(calls).toBe(2);
  });

  test("failures are cached briefly so a daemon started a moment later shows up", async () => {
    let calls = 0;
    const reader = createAntseedBalanceReader({
      fetchBalance: async () => {
        calls++;
        return undefined;
      },
      failureTtlMs: 0,
    });

    await reader.get();
    await reader.get();
    expect(calls).toBe(2);
  });

  test("concurrent reads share one CLI invocation", async () => {
    let calls = 0;
    const reader = createAntseedBalanceReader({
      fetchBalance: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return BALANCE;
      },
    });

    const [a, b] = await Promise.all([reader.get(), reader.get()]);
    expect(a).toEqual(BALANCE);
    expect(b).toEqual(BALANCE);
    expect(calls).toBe(1);
  });

  test("a throwing fetch is treated as unavailable, never as an error", async () => {
    const reader = createAntseedBalanceReader({
      fetchBalance: () => Promise.reject(new Error("antseed: not found")),
    });
    expect(await reader.get()).toBeUndefined();
  });
});

describe("antseed status extension", () => {
  test("shows the line while antseed is active and clears it otherwise", async () => {
    const ext = createAntseedStatusExtension({ fetchBalance: async () => BALANCE });
    const { handlers, statuses, ctx } = harness(ext);

    expect(ext).toMatchObject({ name: "free-pi-antseed-status" });

    await handlers["session_start"]!({ type: "session_start" }, ctx({ provider: ANTSEED_PROVIDER_NAME, id: PEER_MODEL }));

    // Pending first, then the real number — the footer never sits blank.
    expect(statuses[0]).toContain("checking balance");
    expect(statuses.at(-1)).toBe(antseedStatusText(PEER_MODEL, BALANCE));
    expect(ANTSEED_STATUS_KEY).toBe("antseed");

    statuses.length = 0;
    await handlers["model_select"]!(
      { type: "model_select" },
      ctx({ provider: "free-pi", id: "deepseek/deepseek-v4-flash" }),
    );
    expect(statuses).toEqual([undefined]);
  });

  test("a missing CLI reads as unavailable rather than breaking the footer", async () => {
    const ext = createAntseedStatusExtension({ fetchBalance: async () => undefined });
    const { handlers, statuses, ctx } = harness(ext);

    await handlers["model_select"]!({ type: "model_select" }, ctx({ provider: ANTSEED_PROVIDER_NAME, id: "deepseek-v4-flash" }));

    expect(statuses.at(-1)).toBe("[Antseed] deepseek-v4-flash · balance unavailable");
  });

  test("a turn end refreshes the line without being awaited by the agent loop", () => {
    const ext = createAntseedStatusExtension({ fetchBalance: async () => BALANCE });
    const { handlers, ctx } = harness(ext);

    // Returning undefined (not a promise) is the point: a balance read must
    // never hold up turn_end.
    expect(
      handlers["turn_end"]!({ type: "turn_end" }, ctx({ provider: ANTSEED_PROVIDER_NAME, id: "deepseek-v4-flash" })),
    ).toBeUndefined();
  });
});
