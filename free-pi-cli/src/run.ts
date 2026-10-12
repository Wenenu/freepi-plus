import { checkToken, pollForToken, startDeviceFlow, submitConsent, UnauthorizedError } from "./auth-flow";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CONSENT_VERSION } from "./consent";
import { showIntro } from "./onboarding";
import type { LaunchOptions } from "./pi-launch";
import type { SelfUpdateOutcome } from "./self-update";
import type { ClientVersionCheck } from "./update-check";
import { CLI_VERSION } from "./version";
import { maybeWhatsNew } from "./whats-new";
import {
  listAccounts,
  loadAccountInfo,
  resolveActiveAccountId,
  setActiveAccountId,
  clearActiveAccountId,
  pickUsableAccountId,
  migrateLegacyCredentialsIfNeeded,
} from "./accounts";
import {
  loadJwtFor,
  saveJwtFor,
  clearJwtFor,
  loadAccount,
} from "./credentials";
import { runCompact } from "./commands";
import type { NotifyContext } from "./commands";

export interface RunDeps {
  baseUrl: string;
  agentDir: string;
  /** Path to the legacy single-token file, kept for seamless migration. */
  credentialsPath: string;
  promptConsent: () => Promise<boolean>;
  openBrowser: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  launchPi: (opts: LaunchOptions) => Promise<string | void>;
  log: (message: string) => void;
  checkClientVersion: (baseUrl: string, cliVersion: string) => Promise<ClientVersionCheck>;
  maybeSelfUpdate: (action: "notice" | "block", latest: string | undefined) => Promise<SelfUpdateOutcome>;
  /** Plumbed so tests can inject a checkToken failure without network. */
  checkToken?: (baseUrl: string, jwt: string) => Promise<void>;
  /**
   * When true, a missing active account falls back to the legacy single-token
   * flow (used only by tests that specifically verify legacy behavior).
   */
  allowLegacyFirstRun?: boolean;
}

/** Load the JWT stored at the legacy single-token path. */
async function loadJwtLegacy(credentialsPath: string): Promise<string | null> {
  try {
    const raw = await import("node:fs/promises").then((m) => m.readFile(credentialsPath, "utf8"));
    const parsed = JSON.parse(raw) as { token?: string };
    if (typeof parsed.token === "string" && parsed.token.length > 0) return parsed.token;
  } catch {
    // missing or malformed
  }
  return null;
}

/** Remove the legacy single-token file. Idempotent. */
async function clearJwtLegacy(credentialsPath: string): Promise<void> {
  try {
    await import("node:fs/promises").then((m) => m.rm(credentialsPath, { force: true }));
  } catch {
    // no-op
  }
}

/** Store a legacy single-token JWT. */
async function saveJwtLegacy(credentialsPath: string, token: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(credentialsPath), { recursive: true }).catch(() => {});
  await writeFile(credentialsPath, JSON.stringify({ token }), { mode: 0o600 });
}

function parseSessionArg(argv: readonly string[]): { session?: string; error?: string } {
  const flagIndex = argv.indexOf("--session");
  if (flagIndex === -1) return {};

  const value = argv[flagIndex + 1];
  if (!value || value.startsWith("--")) {
    return { error: "Missing value for --session" };
  }

  try {
    SessionManager.inMemory(process.cwd(), { id: value });
  } catch (err) {
    return { error: `Invalid --session value: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { session: value };
}

export async function run(deps: RunDeps, argv: readonly string[] = process.argv): Promise<number> {
  const sessionArg = parseSessionArg(argv);
  if (sessionArg.error) {
    deps.log(sessionArg.error);
    return 1;
  }

  const checkTokenFn = deps.checkToken ?? checkToken;

  // 1. Determine active account (migrating legacy if needed).
  let activeId = resolveActiveAccountId(deps.agentDir);
  let jwt: string | null = null;
  let jwtSource: "account" | "legacy" = "account";

  if (activeId) {
    const account = await loadAccount(activeId, deps.agentDir);
    if (!account) {
      jwt = await loadJwtFor(activeId, deps.agentDir);
      if (!jwt) {
        deps.log(`Account "${activeId}" has no usable token — remove it from /accounts and sign in again.`);
        return 1;
      }
    } else {
      jwt = account.token;
    }
    if (!jwt) {
      deps.log(`Account "${activeId}" token is missing or unreadable.`);
      return 1;
    }
  } else if (deps.allowLegacyFirstRun) {
    jwt = await loadJwtLegacy(deps.credentialsPath);
    jwtSource = "legacy";
  }

  // If no account exists yet, run device flow login.
  if (!jwt) {
    const consentOk = await deps.promptConsent();
    if (!consentOk) {
      deps.log("Declined. Exiting without contacting the free-pi server.");
      return 1;
    }
    showIntro(deps.log);

    const device = await startDeviceFlow(deps.baseUrl);
    deps.log(`\nOpen ${device.verification_uri} and enter code: ${device.user_code}\n`);
    deps.openBrowser(device.verification_uri);

    await submitConsent(deps.baseUrl, device.session_id, CONSENT_VERSION);

    const token = await pollForToken(
      deps.baseUrl,
      device.session_id,
      device.interval,
      deps.sleep,
    );

    if (deps.allowLegacyFirstRun) {
      await saveJwtLegacy(deps.credentialsPath, token);
      jwt = token;
      jwtSource = "legacy";
    } else {
      let label = "default";
      let accountId = "default";
      try {
        const res = await fetch(`${deps.baseUrl}/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const me = (await res.json()) as { handle?: string; user_id?: string };
          if (me.handle) {
            label = me.handle;
            accountId = me.handle;
          }
        }
      } catch {
        // best-effort label discovery
      }
      await saveJwtFor(accountId, token, accountId, label, deps.agentDir);
      setActiveAccountId(accountId, deps.agentDir);
      activeId = accountId;
      jwt = token;
      jwtSource = "account";
    }
  }

  // 2. Token validation: 401 means revoked.
  try {
    await checkTokenFn(deps.baseUrl, jwt);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      if (jwtSource === "legacy") {
        await clearJwtLegacy(deps.credentialsPath);
        deps.log("The stored sign-in token was revoked. Run device login again.");
        return 1;
      }
      deps.log(`The account "${activeId}" is no longer authorized.`);
      const usable = pickUsableAccountId(deps.agentDir);
      if (usable && usable !== activeId) {
        setActiveAccountId(usable, deps.agentDir);
        deps.log(`Switched to active account "${usable}".`);
        return runWithAccount(deps, usable, sessionArg.session);
      }
      return 1;
    }
  }

  // 3. Usage check & auto-switch if active account is exhausted.
  if (activeId && !deps.allowLegacyFirstRun) {
    const me = await fetchMeForAccount(deps, activeId);
    if (me && me.remainingUsdToday <= 0) {
      deps.log(`free-pi allowance for account "${activeId}" is exhausted.`);
      const next = pickUsableAccountId(deps.agentDir);
      if (next && next !== activeId) {
        setActiveAccountId(next, deps.agentDir);
        deps.log(`Switched active account to "${next}". The session continues with that account.`);
        const nextAccount = await loadAccount(next, deps.agentDir);
        if (nextAccount) {
          deps.log(`Active account label: ${nextAccount.label}`);
        }
        return runWithAccount(deps, next, sessionArg.session);
      }
      deps.log("No other account has a usable free allowance. Buy more usage or sign in with a different GitHub account (/accounts).");
    }
  }

  // 4. Version check & self-update.
  const versionCheck = await deps.checkClientVersion(deps.baseUrl, CLI_VERSION);
  let updateLatest: string | undefined;
  if (versionCheck.action !== "ok") {
    const outcome = await deps.maybeSelfUpdate(versionCheck.action, versionCheck.latest);
    if (outcome === "updated-exit") return 0;
    if (outcome === "blocked") {
      deps.log("free-pi-cli is below the required minimum version; update with: npx free-pi-cli@latest");
      return 1;
    }
    if (outcome === "notice") {
      updateLatest = versionCheck.latest;
    }
  }

  const whatsNew = maybeWhatsNew(CLI_VERSION, deps.agentDir);
  if (whatsNew) deps.log(whatsNew);

  if (versionCheck.notice) deps.log(versionCheck.notice);

  // 5. Context ceiling compaction if signalled.
  if (versionCheck.context) {
    const compactCtx: NotifyContext = {
      ui: { notify: (message, type) => deps.log(`\n/context-limit: ${message} [${type}]`) },
    };
    deps.log("\nfree-pi context limit hit — running /compact to reclaim space.");
    runCompact(compactCtx);
    deps.log("\nfree-pi context reclaimed. Starting a new session…");
  }

  const finalSessionId = await deps.launchPi({
    baseUrl: deps.baseUrl,
    jwt,
    agentDir: deps.agentDir,
    session: sessionArg.session,
    model: versionCheck.model,
    models: versionCheck.models,
    updateLatest,
  });

  deps.log(
    finalSessionId
      ? `\nfree-pi session ended. Start it again anytime:  npx free-pi-cli --session ${finalSessionId}`
      : "\nfree-pi session ended. Start it again anytime:  npx free-pi-cli",
  );
  deps.log("(or install once for a shorter command:  npm i -g free-pi-cli  →  free-pi-cli)\n");
  return 0;
}

/**
 * Re-run the flow with the given account id.
 */
async function runWithAccount(deps: RunDeps, accountId: string, session?: string): Promise<number> {
  const jwt = await loadJwtFor(accountId, deps.agentDir);
  if (!jwt) {
    deps.log(`Account "${accountId}" token is missing or unreadable.`);
    return 1;
  }

  const checkTokenFn = deps.checkToken ?? checkToken;
  try {
    await checkTokenFn(deps.baseUrl, jwt);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      deps.log(`The account "${accountId}" is no longer authorized.`);
      return 1;
    }
  }

  const me = await fetchMeForAccount(deps, accountId);
  if (me && me.remainingUsdToday <= 0) {
    deps.log(`Account "${accountId}" is also exhausted.`);
  }

  return runCore(deps, accountId, jwt, session);
}

async function runCore(deps: RunDeps, accountId: string, jwt: string, session?: string): Promise<number> {
  const versionCheck = await deps.checkClientVersion(deps.baseUrl, CLI_VERSION);
  let updateLatest: string | undefined;
  if (versionCheck.action !== "ok") {
    const outcome = await deps.maybeSelfUpdate(versionCheck.action, versionCheck.latest);
    if (outcome === "updated-exit") return 0;
    if (outcome === "blocked") {
      deps.log("free-pi-cli is below the required minimum version; update with: npx free-pi-cli@latest");
      return 1;
    }
    if (outcome === "notice") {
      updateLatest = versionCheck.latest;
    }
  }

  const whatsNew = maybeWhatsNew(CLI_VERSION, deps.agentDir);
  if (whatsNew) deps.log(whatsNew);

  if (versionCheck.notice) deps.log(versionCheck.notice);

  if (versionCheck.context) {
    const compactCtx: NotifyContext = {
      ui: { notify: (message, type) => deps.log(`\n/context-limit: ${message} [${type}]`) },
    };
    deps.log("\nfree-pi context limit hit — running /compact to reclaim space.");
    runCompact(compactCtx);
    deps.log("\nfree-pi context reclaimed. Starting a new session…");
  }

  const finalSessionId = await deps.launchPi({
    baseUrl: deps.baseUrl,
    jwt,
    agentDir: deps.agentDir,
    session,
    model: versionCheck.model,
    models: versionCheck.models,
    updateLatest,
  });

  deps.log(
    finalSessionId
      ? `\nfree-pi session ended. Start it again anytime:  npx free-pi-cli --session ${finalSessionId}`
      : "\nfree-pi session ended. Start it again anytime:  npx free-pi-cli",
  );
  deps.log("(or install once for a shorter command:  npm i -g free-pi-cli  →  free-pi-cli)\n");
  return 0;
}

/**
 * Fetch the given account's current free allowance from GET /me.
 */
async function fetchMeForAccount(
  deps: RunDeps,
  accountId: string,
): Promise<{ remainingUsdToday: number } | undefined> {
  try {
    const jwt = await loadJwtFor(accountId, deps.agentDir);
    if (!jwt) return undefined;
    const res = await fetch(`${deps.baseUrl}/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return undefined;
    const raw = await res.json();
    const me = raw as { remaining_usd_today?: number };
    if (typeof me.remaining_usd_today === "number") {
      return { remainingUsdToday: me.remaining_usd_today };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
