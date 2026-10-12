import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  InteractiveMode,
  runRpcMode,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { createAdsExtension } from "@freepi/pi-ads";
import { readFileSync } from "node:fs";
import { accountsDir, loadAccountInfo, resolveActiveAccountId } from "./accounts";
import { join, resolve } from "node:path";
import {
  buildProviderConfig,
  buildAntseedProviderConfig,
  MODEL_ID,
  PROVIDER_NAME,
  SAFE_TOOLS,
  type CatalogModel,
  ANTSEED_DEFAULT_MODELS,
} from "./provider";
import { createUsageToolExtension, USAGE_TOOL_NAME } from "./usage-tool";
import { createBuyToolExtension, BUY_TOOL_NAME } from "./buy-tool";
import { createDocsToolExtension, DOCS_TOOL_NAME } from "./docs-tool";
import { createErrorNoticeExtension } from "./error-notice";
import { createToolGuardExtension } from "./tool-guard";
import { createFreePiCommandsExtension } from "./commands";
import { createHeaderExtension } from "./header";
import { resolveFreePiScope } from "./provider-lock";
import { patchResumeLine } from "./resume-line";
import { extractTextToolCalls, looksLikeToolMarkup } from "./text-tool-parser";
import { ANTSEED_DEPOSIT_TOOL_NAME, ANTSEED_PROVIDER_NAME } from "./antseed";
import { createAntseedDepositToolExtension } from "./antseed-deposit-tool";
import { createAntseedStatusExtension } from "./antseed-status";
import { applyModelSwitch } from "./model-switch";
import { createSwarmExtension } from "./swarm/extension";
import { SWARM_TOOL_NAME } from "./swarm/tool";
import { createKeepaliveExtension } from "./keepalive";
import { createRotateExtension } from "./rotate";

export interface LaunchOptions {
  baseUrl: string;
  jwt: string;
  agentDir: string;
  session?: string;
  /** Server-reported active model to display (falls back to MODEL_ID). */
  model?: string;
  /** #140: the selectable model catalog from /client-version. When present the
   * picker offers all of them; empty/absent falls back to the single `model`. */
  models?: CatalogModel[];
  /** A newer free-pi-cli version, when /client-version reported one and the
   * self-update fell back to notifying. Renders the header's update banner —
   * free-pi's replacement for pi's own (suppressed) `pi update` banner. */
  updateLatest?: string;
  /** "tui" (default) draws the interactive terminal UI; "rpc" runs headless and
   * speaks the pi RPC protocol on stdin/stdout, for embedding free-pi in
   * another application (see ops/freepi-panel and the SDK's docs/rpc.md). */
  mode?: "tui" | "rpc";
}

/** The models to register + scope the picker to: the server catalog when it
 * sent one, else the single active model (back-compat with a plain response). */
function catalogModelsFor(opts: LaunchOptions): CatalogModel[] {
  if (opts.models && opts.models.length > 0) return opts.models;
  const id = opts.model || MODEL_ID;
  return [{ id, name: id }];
}

// #28 R20/R20a: the exact, closed set of tool names the shipped distro ever
// legitimately runs — SAFE_TOOLS' built-ins plus the two registered custom
// tools (free_pi_usage, U5; free_pi_buy_credits, #226). Used two ways, belt
// and braces (KTD-7 found `defaultTools` alone does not block an
// extension-registered tool):
//   1. Passed as `tools` to createAgentSessionFromServices — the SDK's own
//      strict allowlist (docs/settings.md: same mechanism as the CLI's
//      `--tools` flag, "only the listed tool names are enabled").
//   2. Passed to the tool-guard extension, which blocks + reports anything
//      outside this set that still somehow reaches a tool_call event.
export const ALLOWED_TOOL_NAMES: readonly string[] = [
  ...SAFE_TOOLS,
  USAGE_TOOL_NAME,
  BUY_TOOL_NAME,
  DOCS_TOOL_NAME,
  ANTSEED_DEPOSIT_TOOL_NAME,
  SWARM_TOOL_NAME,
];

export interface RuntimeBuildOptions {
  settingsManager: SettingsManager;
  resourceLoaderOptions: { extensionFactories: InlineExtension[] };
  /** Names of every extension this distro will load — the property SB1's structural test asserts on. */
  extensionNames: string[];
  tools: readonly string[];
}

/**
 * Pure construction of the pi runtime free-pi-cli ships: which extensions
 * load, which tools are enabled, and the settings pinning `packages: []`
 * (no pi-package registry, so no MCP adapter or subagent package can be
 * pulled in). Extracted from launchPi() as a test seam (#28 SB1) —
 * launchPi() itself drives the real interactive TUI and is only exercised
 * when the bin actually runs, never in `bun test`.
 */
/** KTD6: the display model name for the header — server catalog name, then
 * the active model id, then the built-in default. Exported as a test seam. */
export function resolveModelName(opts: LaunchOptions): string {
  return opts.models?.[0]?.name || opts.model || MODEL_ID;
}

export function buildRuntimeOptions(opts: LaunchOptions, sessionId: string): RuntimeBuildOptions {
  const models = catalogModelsFor(opts);

  const getCurrentToken = (): string => {
    try {
      const active = resolveActiveAccountId(opts.agentDir);
      if (active) {
        const info = loadAccountInfo(join(accountsDir(opts.agentDir), active));
        if (info?.hasToken) {
          const raw = readFileSync(info.credentialsPath, "utf8");
          const parsed = JSON.parse(raw) as { token?: string };
          if (parsed.token) return parsed.token;
        }
      }
    } catch {
      // fallback
    }
    return opts.jwt;
  };

  // How many times a turn may be nudged after ending on tool-call markup.
  const MAX_TOOL_MARKUP_NUDGES = 2;

  const providerExtension: InlineExtension = {
    name: "free-pi-provider",
    factory: (pi: ExtensionAPI) => {
      let toolMarkupNudges = 0;
      pi.registerProvider(PROVIDER_NAME, buildProviderConfig(opts.baseUrl, opts.jwt, sessionId, models));
      pi.registerProvider(ANTSEED_PROVIDER_NAME, buildAntseedProviderConfig());

      pi.on("before_provider_headers", (event, ctx) => {
        // Only attach FreePI bearer auth when the request is headed to the
        // free-pi provider. The event itself carries no provider id (see
        // BeforeProviderHeadersEvent — headers only), so the active model is
        // what identifies the target; `event.provider` was always undefined
        // here, which silently disabled the per-request token refresh (so a
        // /switch-account only took effect after a restart).
        if (ctx.model?.provider !== PROVIDER_NAME) return;
        const token = getCurrentToken();
        event.headers["authorization"] = `Bearer ${token}`;
        event.headers["Authorization"] = `Bearer ${token}`;
      });
      pi.on("message_end", async (event, ctx) => {
        const message = event.message;
        if (message.role !== "assistant") return;

        // Auto-fallback to Antseed when FreePI quota / daily usage is exhausted
        if (message.stopReason === "error") {
          const errorMessage = message.errorMessage ?? "";
          if (
            (message.provider === PROVIDER_NAME || ctx.model?.provider === PROVIDER_NAME) &&
            (errorMessage.includes("429") ||
              errorMessage.includes("daily_cap") ||
              errorMessage.includes("quota") ||
              errorMessage.includes("limit_exceeded"))
          ) {
            const antseedModel = ANTSEED_DEFAULT_MODELS[0]!.id;
            // Goes through the same checked switch the /antseed commands use:
            // writing ctx.model directly never worked (the SDK exposes it as a
            // readonly getter), so this fallback used to announce a switch and
            // then let the next turn fail against free-pi all over again.
            const switched = await applyModelSwitch(ANTSEED_PROVIDER_NAME, antseedModel, ctx, pi);
            if (switched.ok) {
              ctx.ui.notify(
                `FreePI quota exhausted. Automatically switched inference to Antseed P2P (${antseedModel}).`,
                "warning",
              );
              pi.sendUserMessage("Continue with the task using Antseed", { deliverAs: "followUp" });
            } else {
              ctx.ui.notify(
                `FreePI quota exhausted, and the Antseed fallback could not start${switched.reason ? ` (${switched.reason})` : ""}.\nFund Antseed (antseed buyer deposit) and start it with: antseed buyer start`,
                "error",
              );
            }
            return;
          }
        }

        if (message.provider !== PROVIDER_NAME && ctx.model?.provider !== PROVIDER_NAME) return;

        if (message.stopReason === "error") {
          const errorMessage = message.errorMessage ?? "";
          if (errorMessage.includes("context_length_exceeded")) return;
          if (
            errorMessage.includes('"code":"context_ceiling"') ||
            errorMessage.includes('"code": "context_ceiling"') ||
            errorMessage.includes("context_ceiling")
          ) {
            return {
              message: {
                ...message,
                errorMessage: `context_length_exceeded: ${errorMessage}`,
              },
            };
          }
          return;
        }

        // Recover tool calls emitted as raw text tokens (e.g. DeepSeek DSML or XML tags)
        if (!Array.isArray(message.content)) return;
        const hasStructuredToolCalls = message.content.some((c: any) => c.type === "toolCall");
        if (!hasStructuredToolCalls) {
          const newContent: any[] = [];
          const allToolCalls: any[] = [];

          for (const block of message.content) {
            if (block.type === "text" && typeof block.text === "string") {
              const parsed = extractTextToolCalls(block.text);
              if (parsed.hasToolCalls) {
                if (parsed.cleanText.length > 0) {
                  newContent.push({ type: "text", text: parsed.cleanText });
                }
                allToolCalls.push(...parsed.toolCalls);
              } else {
                newContent.push(block);
              }
            } else {
              newContent.push(block);
            }
          }

          if (allToolCalls.length > 0) {
            newContent.push(...allToolCalls);
            return {
              message: {
                ...message,
                content: newContent,
                stopReason: "toolUse",
              },
            };
          }
        }
      });
      pi.on("agent_end", (event, ctx) => {
        const lastMsg = event.messages[event.messages.length - 1];
        if (!lastMsg || lastMsg.role !== "assistant") return;
        if (lastMsg.provider !== PROVIDER_NAME && ctx.model?.provider !== PROVIDER_NAME) return;

        if (lastMsg.stopReason === "length") {
          pi.sendUserMessage("Continue with the task that got interrupted", { deliverAs: "followUp" });
          return;
        }

        // A turn that ended with tool-call markup still in its text did not do
        // the work the model meant to do: it printed a call (DeepSeek's DSML
        // wrapper, an <invoke> block) instead of making one, and the session
        // would otherwise simply stop with the markup on screen. Say so and let
        // it re-issue the call properly. Bounded: two nudges, then leave it
        // alone rather than looping against a model that will not comply.
        const text = Array.isArray(lastMsg.content)
          ? lastMsg.content
              .filter((block: any) => block.type === "text" && typeof block.text === "string")
              .map((block: any) => block.text as string)
              .join("\n")
          : "";
        if (!looksLikeToolMarkup(text)) return;
        if (toolMarkupNudges >= MAX_TOOL_MARKUP_NUDGES) return;
        toolMarkupNudges += 1;
        pi.sendUserMessage(
          "Your last reply contained a tool call as raw text, which this session cannot execute. " +
            "Re-issue it as a real tool call through the tool-calling API (one call at a time), and do not print tool markup as text. Then continue the task.",
          { deliverAs: "followUp" },
        );
      });
      pi.on("session_compact", (event, ctx) => {
        // willRetry: true means pi is auto-retrying the interrupted turn — don't interfere
        if (event.willRetry) return;
        if (ctx.model?.provider !== PROVIDER_NAME) return;

        pi.sendUserMessage("Continue with the task that got interrupted", { deliverAs: "followUp" });
      });
    },
  };

  // KTD7: the only channel /support has to the currently-shown banner ad's
  // click URL — set by the ads extension's onBannerAd, read by the commands
  // extension's getAdvertiserUrl. Deliberately not a shared object/class:
  // one field, one file, both extensions stay independently testable.
  let advertiserUrl: string | undefined;

  // U7: banner/inline ads + usage meter, sandboxed to UI-only hooks (KTD9).
  // See packages/pi-ads/src/sandbox.test.ts for the enforced proof.
  const adsExtension: InlineExtension = createAdsExtension({
    baseUrl: opts.baseUrl,
    getToken: getCurrentToken,
    sessionId,
    onBannerAd: (u) => {
      advertiserUrl = u;
    },
  });

  // U5 (#17): read-only "what's my usage" tool. Outside packages/pi-ads on
  // purpose (KTD5) — see usage-tool.ts's header comment.
  const usageToolExtension: InlineExtension = createUsageToolExtension({
    baseUrl: opts.baseUrl,
    getToken: getCurrentToken,
  });

  // #226: opens the server's buy-credits page. Outside packages/pi-ads on
  // the same grounds as the usage tool (KTD5) — see buy-tool.ts's header
  // comment.
  const buyToolExtension: InlineExtension = createBuyToolExtension({
    baseUrl: opts.baseUrl,
    getToken: getCurrentToken,
  });

  // U2 (2026-09-03): read-only "about free-pi" docs tool. Outside
  // packages/pi-ads on the same grounds as the usage/buy tools (KTD4) —
  // see docs-tool.ts's header comment.
  const docsToolExtension: InlineExtension = createDocsToolExtension();

  // 2026-09-01: one readable, server-owned line when a turn is rejected
  // (read from turn_end's error envelope). See error-notice.ts.
  const errorNoticeExtension: InlineExtension = createErrorNoticeExtension();

  // #28 R20a: defense-in-depth block + report for any tool outside
  // ALLOWED_TOOL_NAMES that somehow reaches a tool_call event.
  const toolGuardExtension: InlineExtension = createToolGuardExtension({
    baseUrl: opts.baseUrl,
    getToken: getCurrentToken,
    allowedTools: ALLOWED_TOOL_NAMES,
  });

  // 0.2.6: free-pi's slash commands — /close-other-session, /whats-new, /update.
  // A dedicated extension rather than folding into usage-tool (which stays
  // read-only).
  const commandsExtension: InlineExtension = createFreePiCommandsExtension({
    baseUrl: opts.baseUrl,
    getToken: getCurrentToken,
    getAdvertiserUrl: () => advertiserUrl,
    models,
    antseedModels: ANTSEED_DEFAULT_MODELS,
  });

  // U1/U2 (2026-09-03): free-pi's own startup header, replacing pi's
  // built-in one (hidden via quietStartup below). KTD1, KTD6.
  const headerExtension: InlineExtension = createHeaderExtension({
    modelName: resolveModelName(opts),
    updateLatest: opts.updateLatest,
  });

  // Closed, TWELVE-item list — SB1's structural test fails if a future edit adds
  // a thirteenth extension or drops one of these. Settings deliberately omit
  // `packages` (no pi-packages installed, so no MCP adapter or subagent package
  // can be pulled in) and pin `defaultTools` to the built-in tool set (never
  // includes a subagent/background-bash/MCP tool per pi's own docs — see
  // provider.ts). Pi ships with none of those by default, so there is nothing
  // else to turn off — free-pi-cli's job is to never opt back into them. The
  // swarm (2026-10-13) is coordination *between* separate sessions, not an
  // in-session subagent: it adds no way for one session to run two completions
  // at once, which is what #28 R20 actually protects.
  const antseedDepositToolExtension: InlineExtension = createAntseedDepositToolExtension();

  // 2026-10: the Antseed footer line — which antseed model is active and how
  // much USDC is left to pay for it. UI-lifecycle hooks only (no context, no
  // session writes); see antseed-status.ts.
  const antseedStatusExtension: InlineExtension = createAntseedStatusExtension();

  // 2026-10-13: /coordinate + the free_pi_swarm tool — several free-pi sessions
  // working one target (bug bounties): a board, exclusive scope claims, a
  // message bus between sessions, and a switch that gates deploying a worker.
  // A deployed worker is a SEPARATE CLI process (`--mode rpc`) with its own
  // session and its own lease, so this session still never has two completions
  // open at once (SB2's guarantee is unchanged); see src/swarm/*.
  const swarmExtension: InlineExtension = createSwarmExtension();

  // 2026-10-13: unattended runs. `free-pi-keepalive` nudges an idle session to
  // continue; `free-pi-rotate` writes a handoff summary every 3 hours and
  // continues the task in a new session (same provider and model) so a long run
  // never dies against a full context. Both are switchable in-session
  // (/keepalive, /rotate) and by env (FREEPI_KEEPALIVE, FREEPI_ROTATE).
  const keepaliveExtension: InlineExtension = createKeepaliveExtension();
  const rotateExtension: InlineExtension = createRotateExtension({ agentDir: opts.agentDir });

  const extensionFactories = [
    providerExtension,
    adsExtension,
    usageToolExtension,
    buyToolExtension,
    docsToolExtension,
    errorNoticeExtension,
    toolGuardExtension,
    commandsExtension,
    headerExtension,
    antseedDepositToolExtension,
    antseedStatusExtension,
    swarmExtension,
    keepaliveExtension,
    rotateExtension,
  ];

  const settingsManager = SettingsManager.inMemory({
    defaultProvider: PROVIDER_NAME,
    // The picker starts on the first catalog model (the server lists the
    // default first); the user switches with /model.
    defaultModel: models[0]!.id,
    defaultTools: [...SAFE_TOOLS],
    packages: [],
    // KTD1: hides pi's own startup header/skills/extensions dump so the
    // free-pi-header extension's setHeader is the only header shown (R5).
    quietStartup: true,
  });

  return {
    settingsManager,
    resourceLoaderOptions: { extensionFactories },
    extensionNames: extensionFactories.map((e) => (e as { name: string }).name),
    tools: ALLOWED_TOOL_NAMES,
  };
}

/**
 * Launch the real pi TUI wired to the free-pi provider. This is the seam
 * `run.ts` calls through `RunDeps.launchPi` so tests can stub it out — the
 * real pi SDK integration below is exercised only when the bin is actually
 * run, never in `bun test` (starting the real TUI needs a real terminal).
 */
function getSessionDir(cwd: string, agentDir: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

export interface SessionManagerApi {
  create: typeof SessionManager.create;
  open: typeof SessionManager.open;
  list: typeof SessionManager.list;
}

/** Resolves the requested logical session using one explicit session directory. */
export async function createSessionManager(
  cwd: string,
  sessionDir: string,
  sessionId: string | undefined,
  api: SessionManagerApi = SessionManager,
): Promise<SessionManager> {
  if (sessionId) {
    const infos = await api.list(cwd, sessionDir);
    const info = infos.find((session) => session.id === sessionId);
    if (!info) {
      throw new Error(`No session found matching '${sessionId}' in this directory`);
    }
    return api.open(info.path, sessionDir);
  }
  return api.create(cwd, sessionDir);
}

/**
 * free-pi-cli users installed `free-pi-cli` (via npx), never `pi` directly —
 * pi's own interactive mode otherwise shows a "New version available, run
 * `pi update`" banner (checkForNewPiVersion in the SDK, gated only by this
 * env var) that names a command our users don't have. free-pi-cli already
 * has its own correctly-branded update check (update-check.ts / run.ts,
 * "run `npx free-pi-cli@latest`"), so pi's own banner is pure noise here —
 * suppress it. Does not affect pi's separate model-catalog refresh (gated by
 * PI_OFFLINE instead), which stays on.
 */
process.env.PI_SKIP_VERSION_CHECK = "1";

// Same brand-leak problem at the other end of the session: pi's exit path
// prints "To resume this session: pi --session <id>" straight to stdout and
// then exits the process. See resume-line.ts.
patchResumeLine(process.stdout);

export async function launchPi(opts: LaunchOptions): Promise<string> {
  const cwd = process.cwd();
  const sessionDir = getSessionDir(cwd, opts.agentDir);
  const sm = await createSessionManager(cwd, sessionDir, opts.session);

  // The pi logical session id is the lease key shared by the provider and ads.
  const sessionId = sm.getSessionId();
  const scopeIds = catalogModelsFor(opts).map((m) => m.id);
  const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, sessionId);

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: rtCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: rtCwd,
      agentDir: opts.agentDir,
      settingsManager,
      resourceLoaderOptions,
    });
    // Lock the model picker to free-pi catalog models plus Antseed fallback models
    const antseedScoped = ANTSEED_DEFAULT_MODELS.map((m) => ({ provider: ANTSEED_PROVIDER_NAME, id: m.id }));
    const scopedModels = resolveFreePiScope(services.modelRuntime, PROVIDER_NAME, scopeIds, process.env, antseedScoped);
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: [...tools],
        scopedModels,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: opts.agentDir,
    sessionManager: sm,
  });

  // Headless mode: the identical runtime (same provider, same scoped models,
  // same extensions) driven over RPC instead of drawn as a TUI. Everything the
  // TUI can do — prompt, steer, abort, compact, switch model, switch session —
  // is reachable as a JSON command. runRpcMode never returns: it owns the
  // process until stdin closes.
  if (opts.mode === "rpc") {
    await runRpcMode(runtime);
    return sm.getSessionId();
  }

  const mode = new InteractiveMode(runtime, {
    initialImages: [],
    initialMessages: [],
  });

  await mode.run();
  return sm.getSessionId();
}
