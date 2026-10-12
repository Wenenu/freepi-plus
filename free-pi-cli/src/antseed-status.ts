// The Antseed status line: one always-visible footer row answering "which model
// am I actually talking to, and how much inference can I still pay for?"
//
// pi renders extension statuses (ctx.ui.setStatus) on their own line at the
// bottom of the built-in footer, below the pwd/model row — see
// modes/interactive/components/footer.js. So this is a real footer component
// without owning/replacing pi's footer (which the header extension deliberately
// leaves alone).
//
// The balance itself comes from the antseed CLI, which is a process spawn plus
// an on-chain read — far too slow to run per keystroke and unnecessary to run
// per turn. Hence: refreshed on model changes and on turn ends, cached for a
// minute (15s after a failure, so a daemon started moments later shows up).
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { ANTSEED_PROVIDER_NAME, fetchAntseedBalance, type AntseedBalance } from "./antseed";

/** Key pi uses to de-duplicate extension status lines. */
export const ANTSEED_STATUS_KEY = "antseed";

const BALANCE_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;

/** `$0.45`. Two decimals: USDC inference balances are pocket change scale. */
export function formatUsdc(value: number | undefined): string {
  return value === undefined ? "?" : `$${value.toFixed(2)}`;
}

/**
 * `666e6887…@gpt-6.1-sol` from a full `peerId@model` target: a 40-hex peer id
 * would push everything that matters off the edge of a one-line footer.
 */
export function shortModelId(id: string, maxLength = 40): string {
  const at = id.indexOf("@");
  let label = id;
  if (at > 8) label = `${id.slice(0, 8)}…${id.slice(at)}`;
  if (label.length > maxLength) label = `${label.slice(0, maxLength - 1)}…`;
  return label;
}

/** Shown while the (cached, asynchronous) balance read is in flight. */
export function antseedStatusPending(modelId: string): string {
  return `[Antseed] ${shortModelId(modelId)} · checking balance…`;
}

/**
 * The one-line status text. `reservedUsd` is money committed to open payment
 * channels — still the buyer's, but not spendable until the channel closes, so
 * it is shown separately rather than folded into a misleading total.
 */
export function antseedStatusText(modelId: string, balance: AntseedBalance | undefined): string {
  const label = `[Antseed] ${shortModelId(modelId)}`;
  if (!balance) return `${label} · balance unavailable`;
  const parts = [`${formatUsdc(balance.availableUsd)} USDC left`];
  if ((balance.reservedUsd ?? 0) > 0) parts.push(`${formatUsdc(balance.reservedUsd)} reserved`);
  if (balance.connectionState && balance.connectionState !== "connected") {
    parts.push(`buyer ${balance.connectionState}`);
  }
  return `${label} · ${parts.join(" · ")}`;
}

export interface AntseedBalanceReader {
  get(): Promise<AntseedBalance | undefined>;
  /** Drops the cached value (called on session shutdown). */
  invalidate(): void;
}

export interface AntseedBalanceReaderOptions {
  /** Injected in tests. Defaults to the antseed CLI (`fetchAntseedBalance`). */
  fetchBalance?: () => Promise<AntseedBalance | undefined>;
  /** How long a successful read stays fresh. */
  ttlMs?: number;
  /** How long a failed read is remembered (kept short: the daemon may just have started). */
  failureTtlMs?: number;
}

/** TTL cache + in-flight de-duplication around the balance read. */
export function createAntseedBalanceReader(opts: AntseedBalanceReaderOptions = {}): AntseedBalanceReader {
  const fetchBalance = opts.fetchBalance ?? (() => fetchAntseedBalance());
  let cached: { at: number; value: AntseedBalance | undefined } | undefined;
  let inFlight: Promise<AntseedBalance | undefined> | undefined;

  return {
    invalidate(): void {
      cached = undefined;
    },
    async get(): Promise<AntseedBalance | undefined> {
      if (cached) {
        const ttl = cached.value ? (opts.ttlMs ?? BALANCE_TTL_MS) : (opts.failureTtlMs ?? FAILURE_TTL_MS);
        if (Date.now() - cached.at < ttl) return cached.value;
      }
      if (inFlight) return inFlight;
      inFlight = (async () => {
        let value: AntseedBalance | undefined;
        try {
          value = await fetchBalance();
        } catch {
          value = undefined;
        }
        cached = { at: Date.now(), value };
        inFlight = undefined;
        return value;
      })();
      return inFlight;
    },
  };
}

export interface CreateAntseedStatusExtensionOptions {
  /** Injected in tests; defaults to the antseed CLI. */
  fetchBalance?: () => Promise<AntseedBalance | undefined>;
}

/**
 * free-pi's Antseed status line. Registers UI-lifecycle hooks only
 * (session_start / model_select / turn_end / session_shutdown) — it never
 * touches model context or the session.
 */
export function createAntseedStatusExtension(
  opts: CreateAntseedStatusExtensionOptions = {},
): InlineExtension {
  const reader = createAntseedBalanceReader({ fetchBalance: opts.fetchBalance });

  return {
    name: "free-pi-antseed-status",
    factory(pi: ExtensionAPI) {
      const refresh = async (ctx: ExtensionContext): Promise<void> => {
        if (typeof ctx.ui.setStatus !== "function") return;

        const model = ctx.model;
        if (model?.provider !== ANTSEED_PROVIDER_NAME) {
          ctx.ui.setStatus(ANTSEED_STATUS_KEY, undefined);
          return;
        }

        ctx.ui.setStatus(ANTSEED_STATUS_KEY, antseedStatusPending(model.id));
        const balance = await reader.get();
        // The model may have changed while the CLI was running.
        const current = ctx.model;
        if (current?.provider !== ANTSEED_PROVIDER_NAME) return;
        ctx.ui.setStatus(ANTSEED_STATUS_KEY, antseedStatusText(current.id, balance));
      };

      pi.on("session_start", (_event, ctx) => refresh(ctx));
      pi.on("model_select", (_event, ctx) => refresh(ctx));
      // Deliberately not awaited: a balance read must never hold up the agent
      // loop. The cached value resolves immediately on all but the first turn.
      pi.on("turn_end", (_event, ctx) => {
        // Detached, so a failed UI write surfaces nowhere — swallow it rather
        // than emit an unhandled rejection from a decorative footer refresh.
        void refresh(ctx).catch(() => {});
      });
      pi.on("session_shutdown", () => {
        reader.invalidate();
      });
    },
  };
}
