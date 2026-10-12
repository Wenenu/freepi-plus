// Built via `pi.registerProvider(name, config)` per
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md
// Types imported (type-only, erased at runtime — see note below) from the
// published package's real ProviderConfig/ProviderModelConfig
// (@earendil-works/pi-coding-agent@0.84.2, dist/core/extensions/types.d.ts).
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { ANTSEED_DEFAULT_BASE_URL, ANTSEED_PROVIDER_NAME } from "./antseed";
import { ANTSEED_DEFAULT_MODELS } from "./antseed-models";
import { CLI_VERSION } from "./version";

export const PROVIDER_NAME = "free-pi";
export const MODEL_ID = "deepseek/deepseek-v4-flash";

// Built-in tool names as of pi-coding-agent 0.84.2 (usage.md: "Built-in tools:
// read, bash, edit, write, grep, find, ls"). Pi ships with no subagents, no
// background bash, and no MCP by default (usage.md, "Design Principles") — the
// only way any of those would exist is if we loaded a pi-package or extension
// that adds them, which free-pi-cli deliberately never does (see pi-launch.ts).
export const SAFE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/**
 * Pure builder for the free-pi provider config passed to `pi.registerProvider`.
 * Kept separate from pi-launch.ts so it's testable without touching the SDK.
 * The `ProviderConfig` import above is type-only, so this module (and its
 * test) never needs the pi package resolved at runtime — only for typecheck.
 */
/**
 * pi's openai-completions api is built on the openai SDK, which appends
 * `/chat/completions` to its baseURL — so the provider baseUrl must end in
 * `/v1` to reach the proxy's `/v1/chat/completions` route. Verified live
 * 2026-08-14: without this, every completion 404s.
 */
export function completionsBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * #28 R19 (client half, KTD-3): `sessionId` is the pi logical session id
 * selected once at launch by pi-launch.ts. Threaded through as a static header
 * (ProviderConfig.headers, confirmed on the installed SDK's ProviderConfig
 * type) rather than a JWT claim: the JWT is a 90-day credential shared
 * across every process a user launches, so it cannot itself identify one
 * running process. This also finally puts the already-plumbed-but-dormant
 * x-session-id field (completions.ts already reads it for trace grouping)
 * to work for R19 enforcement too.
 */
/** A selectable model from the server catalog (/client-version `models`). `id`
 * is what the CLI sends as the request model; `name` is the picker label. */
export interface CatalogModel {
  id: string;
  name: string;
}

export function buildProviderConfig(
  baseUrl: string,
  jwt: string,
  sessionId: string,
  // #140: the catalog of selectable models (id = request model the server
  // resolves against model_catalog; name = picker label). The server forces the
  // real upstream per request, so these are display/routing ids, not upstream
  // model names.
  models: CatalogModel[],
): ProviderConfig {
  return {
    name: "free-pi",
    baseUrl: completionsBaseUrl(baseUrl),
    apiKey: jwt,
    api: "openai-completions",
    // #37: x-client-version rides alongside x-session-id on every completion
    // so the server's forced-update gate (apps/server/src/routes/completions.ts)
    // can enforce minCliVersion.
    headers: { "x-session-id": sessionId, "x-client-version": CLI_VERSION },
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: false,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 8192,
    })),
  };
}

// A plain re-export (`export { X } from "./mod"`) does NOT put X in this
// module's own scope — the default argument below referenced an undefined
// `ANTSEED_DEFAULT_MODELS` and threw a ReferenceError the moment the provider
// extension loaded (which silently left the antseed provider unregistered and
// made every /provider antseed switch a no-op). Import it for local use and
// re-export the same binding so importers keep working.
export { ANTSEED_DEFAULT_MODELS };

export function buildAntseedProviderConfig(
  baseUrl: string = antseedBaseUrl(),
  models: CatalogModel[] = ANTSEED_DEFAULT_MODELS,
): ProviderConfig {
  return {
    name: ANTSEED_PROVIDER_NAME,
    baseUrl: completionsBaseUrl(baseUrl),
    apiKey: ANTSEED_LOCAL_API_KEY,
    api: "openai-completions",
    models: models.map((m) => antseedModelConfig(m.id, m.name)),
  };
}

/**
 * The buyer proxy ignores this value (it authenticates by the on-chain buyer
 * identity key), but pi requires a provider-level API key to consider the
 * provider "configured" — that is what makes `pi.setModel()` accept an antseed
 * model. A literal (not $ENV) keeps `configuredRequestAuthStatus` true.
 */
export const ANTSEED_LOCAL_API_KEY = "antseed-local";

/** One Antseed model definition, in the shape `registerProvider` wants. */
export function antseedModelConfig(id: string, name: string = id): ProviderModelConfig {
  return {
    id,
    name,
    reasoning: id.includes("reasoner") || id.includes("r1"),
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 8192,
  };
}

/**
 * A `peerId@model` target (see commands.ts) is not in the advertised catalog,
 * so we synthesize it: the peer id is folded into the picker label and
 * truncated, because a raw 40-hex peer id is unreadable in a 1-line footer.
 */
export function customAntseedModel(id: string): CatalogModel {
  const at = id.indexOf("@");
  if (at <= 0) return { id, name: id };
  const peer = id.slice(0, at);
  const model = id.slice(at + 1);
  return { id, name: `${model} [${peer.slice(0, 8)}]` };
}

/** The buyer proxy's address. `ANTSEED_BASE_URL` overrides it (tests, remote buyers). */
export function antseedBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.ANTSEED_BASE_URL?.trim();
  return raw && raw.length > 0 ? raw : ANTSEED_DEFAULT_BASE_URL;
}

