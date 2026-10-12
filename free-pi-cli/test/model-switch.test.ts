// The switch itself: `/antseed model <peerId>@<model>` (and every other path
// that changes provider/model) must (a) give pi a complete model object even
// for an id that was never advertised, and (b) report the truth when the
// runtime refuses the switch. Both halves were broken before: the antseed
// provider threw while registering, and `pi.setModel()`'s boolean — the only
// signal that the provider has no configured auth — was discarded.
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { ANTSEED_PROVIDER_NAME } from "../src/antseed";
import { ANTSEED_DEFAULT_MODELS } from "../src/provider";
import { switchFailureText } from "../src/commands";
import {
  antseedCatalog,
  applyModelSwitch,
  rememberAntseedModel,
  rememberedAntseedModels,
  type PiModel,
} from "../src/model-switch";

const PEER_MODEL = "666e688780b9fdee5d2fe8ccafa666bb084c4666@gpt-6.1-sol";

/** A pi stand-in that records registrations and remembers the models it was given. */
function fakePi(setModelResult: boolean | (() => Promise<boolean>) = true) {
  const registrations: Array<{ name: string; config: ProviderConfig }> = [];
  const switched: PiModel[] = [];
  const models = new Map<string, PiModel>();

  const pi = {
    registerProvider(name: string, config: ProviderConfig) {
      registrations.push({ name, config });
      for (const model of config.models ?? []) {
        models.set(`${name}/${model.id}`, {
          ...model,
          provider: name,
          api: config.api,
          baseUrl: config.baseUrl,
        } as unknown as PiModel);
      }
    },
    async setModel(model: PiModel) {
      if (typeof setModelResult === "function") return setModelResult();
      if (!setModelResult) return false;
      switched.push(model);
      return true;
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    registrations,
    switched,
    registry: { find: (provider: string, id: string) => models.get(`${provider}/${id}`) },
  };
}

describe("applyModelSwitch", () => {
  test("registers an unseen peer@model target, then switches to the complete model object", async () => {
    const { pi, registrations, switched, registry } = fakePi();
    const ctx = { model: { provider: "free-pi", id: "deepseek/deepseek-v4-flash" }, modelRegistry: registry };

    const result = await applyModelSwitch(ANTSEED_PROVIDER_NAME, PEER_MODEL, ctx, pi);

    expect(result).toEqual({ ok: true });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.name).toBe(ANTSEED_PROVIDER_NAME);
    const registered = registrations[0]!.config.models ?? [];
    expect(registered.some((m) => m.id === PEER_MODEL)).toBe(true);
    // The advertised catalog is preserved, not replaced by the single target.
    expect(registered.length).toBeGreaterThanOrEqual(ANTSEED_DEFAULT_MODELS.length + 1);

    expect(switched).toHaveLength(1);
    expect(switched[0]!.provider).toBe(ANTSEED_PROVIDER_NAME);
    expect(switched[0]!.id).toBe(PEER_MODEL);
    // A bare {provider, id} has no api/baseUrl — the request would fail at
    // stream time with "No API provider registered for api: undefined".
    expect(switched[0]!.api).toBe("openai-completions");
    expect(String(switched[0]!.baseUrl)).toEndWith("/v1");
  });

  test("reuses an already-known model without re-registering the provider", async () => {
    const { pi, registrations, switched, registry } = fakePi();
    const known = ANTSEED_DEFAULT_MODELS[0]!;
    registry.find = ((provider: string, id: string) =>
      provider === ANTSEED_PROVIDER_NAME && id === known.id
        ? ({ provider, id, api: "openai-completions", baseUrl: "http://127.0.0.1:8377/v1" } as unknown as PiModel)
        : undefined) as never;
    const ctx = { model: { provider: "free-pi", id: "x" }, modelRegistry: registry };

    const result = await applyModelSwitch(ANTSEED_PROVIDER_NAME, known.id, ctx, pi);

    expect(result.ok).toBe(true);
    expect(registrations).toHaveLength(0);
    expect(switched[0]!.id).toBe(known.id);
  });

  test("a false from pi.setModel is a failure, not a silent no-op", async () => {
    const { pi, registry, switched } = fakePi(false);
    const ctx = { model: { provider: "free-pi", id: "deepseek/deepseek-v4-flash" }, modelRegistry: registry };

    const result = await applyModelSwitch(ANTSEED_PROVIDER_NAME, PEER_MODEL, ctx, pi);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("credentials");
    expect(switched).toHaveLength(0);
    // The old provider/model is untouched — the caller can say so.
    expect(ctx.model.provider).toBe("free-pi");
  });

  test("a throwing pi.setModel is reported, never propagated", async () => {
    const { pi, registry } = fakePi(() => Promise.reject(new Error("No API key for antseed/peer")));
    const ctx = { model: { provider: "free-pi", id: "x" }, modelRegistry: registry };

    const result = await applyModelSwitch(ANTSEED_PROVIDER_NAME, PEER_MODEL, ctx, pi);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("No API key");
  });

  test("without an ExtensionAPI it writes ctx.model directly (unit-test / older-SDK path)", async () => {
    const ctx = { model: { provider: "free-pi", id: "deepseek/deepseek-v4-flash" }, ui: { notify: () => {} } };

    const result = await applyModelSwitch(ANTSEED_PROVIDER_NAME, PEER_MODEL, ctx);

    expect(result).toEqual({ ok: true });
    expect(ctx.model).toEqual({ provider: ANTSEED_PROVIDER_NAME, id: PEER_MODEL });
  });

  test("remembered peer targets are kept for the rest of the session", () => {
    const model = rememberAntseedModel(PEER_MODEL);
    expect(model.name).toBe("gpt-6.1-sol [666e6887]");
    expect(rememberedAntseedModels().map((m) => m.id)).toContain(PEER_MODEL);
    expect(antseedCatalog().map((m) => m.id)).toContain(PEER_MODEL);
    // Advertising the catalog twice must not duplicate the remembered entries.
    const ids = antseedCatalog().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("switchFailureText names the missing daemon for antseed, and nothing for free-pi", () => {
    const antseed = switchFailureText(ANTSEED_PROVIDER_NAME, PEER_MODEL, "no credentials are configured for provider \"antseed\"");
    expect(antseed).toContain(PEER_MODEL);
    expect(antseed).toContain("antseed buyer start");

    const freePi = switchFailureText("free-pi", "deepseek/deepseek-v4-flash");
    expect(freePi).not.toContain("antseed buyer start");
    expect(freePi).toContain("Couldn't switch to [free-pi]");
  });
});
