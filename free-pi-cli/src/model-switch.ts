// Switching the active provider/model, shared by the slash commands
// (commands.ts) and the free-pi provider extension's quota fallback
// (pi-launch.ts).
//
// Why this is its own module: `pi.setModel()` is the only supported way to
// change the active model, and it is a *checked* call — it resolves a model by
// the caller-supplied provider string, and returns false when that provider has
// no configured credentials (agent-session.js). Firing it and reporting success
// anyway is exactly what made `/antseed model <peer@model>` print
// "Switched provider to [antseed]" and then keep answering with free-pi's model.
// Both callers now share one implementation that:
//   1. registers an antseed model id pi doesn't know yet (a direct
//      `peerId@model` target) so the runtime has a complete model object —
//      the openai SDK needs `api`/`baseUrl`, which a bare `{provider, id}`
//      does not carry; and
//   2. reports the real outcome of setModel so callers can tell the user the
//      truth instead of a success message.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANTSEED_PROVIDER_NAME } from "./antseed";
import {
  ANTSEED_DEFAULT_MODELS,
  buildAntseedProviderConfig,
  customAntseedModel,
  type CatalogModel,
} from "./provider";

/** The model object shape `pi.setModel()` accepts. */
export type PiModel = Parameters<ExtensionAPI["setModel"]>[0];

/**
 * The slice of an ExtensionContext this module needs (structurally typed, so a
 * real ExtensionContext and the command tests' lightweight stand-ins both fit).
 * No `ui`: deciding what to tell the user is the caller's job.
 */
export interface ModelSwitchContext {
  model?: { provider?: string; id?: string } | undefined;
  modelRegistry?: { find(provider: string, modelId: string): PiModel | undefined } | undefined;
}

export interface ModelSwitchResult {
  ok: boolean;
  /** Present when ok is false — a short, user-facing reason. */
  reason?: string;
}

// Antseed targets the user asked for that the advertised catalog doesn't list
// (a direct `peerId@model`). Remembered per process: `registerProvider`'s
// `models` replaces the provider's whole list, so every re-registration hands
// pi the advertised catalog plus everything remembered here — otherwise
// switching to peer B would silently drop peer A from the runtime catalog.
const extraAntseedModels = new Map<string, CatalogModel>();

/** Records a `peerId@model` target so future registrations keep it. */
export function rememberAntseedModel(id: string): CatalogModel {
  const model = customAntseedModel(id);
  extraAntseedModels.set(model.id, model);
  return model;
}

/** The `peerId@model` targets remembered this session (for the /model picker). */
export function rememberedAntseedModels(): CatalogModel[] {
  return [...extraAntseedModels.values()];
}

/** The antseed catalog to register: the advertised 583 plus remembered targets. */
export function antseedCatalog(): CatalogModel[] {
  const catalog = [...ANTSEED_DEFAULT_MODELS];
  const seen = new Set(catalog.map((m) => m.id));
  for (const model of extraAntseedModels.values()) {
    if (seen.has(model.id)) continue;
    catalog.push(model);
    seen.add(model.id);
  }
  return catalog;
}

/**
 * Re-registers the antseed provider with its full catalog plus `modelId`, so
 * the next `pi.setModel()` finds a real model (with `api` and `baseUrl`) for an
 * id that was never advertised. Safe to call repeatedly.
 */
export function registerAntseedModel(pi: ExtensionAPI, modelId: string): void {
  rememberAntseedModel(modelId);
  pi.registerProvider(ANTSEED_PROVIDER_NAME, buildAntseedProviderConfig(undefined, antseedCatalog()));
}

/**
 * Switches the active provider/model. Never throws; the caller decides how to
 * report { ok: false }.
 *
 * Without an ExtensionAPI (unit tests, older SDK surfaces) this falls back to
 * writing `ctx.model` directly, which is how the command tests drive it.
 */
export async function applyModelSwitch(
  provider: string,
  modelId: string,
  ctx: ModelSwitchContext,
  pi?: ExtensionAPI,
): Promise<ModelSwitchResult> {
  if (!pi || typeof pi.setModel !== "function") {
    try {
      (ctx as { model?: unknown }).model = { provider, id: modelId };
      return { ok: true };
    } catch {
      return { ok: false, reason: "this runtime exposes no way to change the model" };
    }
  }

  const registry = ctx.modelRegistry;
  let model = registry?.find(provider, modelId);

  if (!model && provider === ANTSEED_PROVIDER_NAME) {
    try {
      registerAntseedModel(pi, modelId);
      model = registry?.find(provider, modelId);
    } catch {
      // Registration is best-effort: a rejected config must not stop the switch
      // attempt (setModel's result below is what decides success).
    }
  }

  // Last resort: hand pi the id as-is and let setModel's own validation decide.
  const target = model ?? ({ provider, id: modelId } as PiModel);

  try {
    const accepted = await pi.setModel(target);
    if (accepted) return { ok: true };
    return { ok: false, reason: `no credentials are configured for provider "${provider}"` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
