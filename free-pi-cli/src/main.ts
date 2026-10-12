import { realpathSync } from "node:fs";
import { join } from "node:path";
import { openBrowser } from "./browser";
import { HELP_TEXT, parseCliArgs, versionLine } from "./cli-args";
import { readAutoUpdate } from "./cli-config";
import { resolveBaseUrl } from "./env";
import { runLogout } from "./logout";
import { getConfigPath, getFreePiAgentDir, getAccountCredentialsPath, getLegacyCredentialsPath } from "./paths";
import { launchPi } from "./pi-launch";
import { promptConsentInteractive } from "./prompt";
import { createRealSpawn } from "./real-spawn";
import { run } from "./run";
import { maybeSelfUpdate } from "./self-update";
import { checkClientVersion } from "./update-check";
import {
  loadJwtFor,
  clearJwtFor,
} from "./credentials";
import {
  resolveActiveAccountId,
  setActiveAccountId,
} from "./accounts";

/** Resolves symlinks (npm's global bin shim) so the path-boundary check in self-update.ts is meaningful. */
function resolveCliRealpath(): string {
  try {
    return realpathSync(process.argv[1] ?? "");
  } catch {
    // Fail safe: an empty string never matches (or prefixes) a real `npm root -g` path.
    return "";
  }
}

async function main(): Promise<void> {
  // Ignore Ctrl+C so the agent is never killed mid-task by an accidental keypress.
  // SIGTERM and SIGHUP (registered by pi's print-mode internals) are still honoured.
  process.on("SIGINT", () => {});

  // Local commands dispatch before run(): none of these contact the server,
  // so the consent/privacy invariants of the run() flow are never in play.
  const command = parseCliArgs(process.argv.slice(2));
  if (command.kind === "version") {
    console.log(versionLine());
    process.exit(0);
  }
  if (command.kind === "help") {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (command.kind === "unknown") {
    console.error(`free-pi-cli: unknown argument "${command.arg}"\n\n${HELP_TEXT}`);
    process.exit(2);
  }

  if (command.kind === "logout") {
    // The account manager delegates logout to the legacy credentials path: the
    // active account is resolved by a login, then its token is cleared.
    const agentDir = getFreePiAgentDir();
    const activeId = resolveActiveAccountId(agentDir);
    // If no account yet, the legacy single-token path is used for backward
    // compatibility with pre-upgrade installations.
    const credentialsPath = activeId
      ? getAccountCredentialsPath(activeId, agentDir)
      : getLegacyCredentialsPath(agentDir);

    const logoutCode = await runLogout({
      credentialsPath,
      loadJwt: (path) => loadJwtForInline(path),
      clearJwt: (path) => clearJwtInline(path),
      log: (message) => console.log(message),
    });
    process.exit(logoutCode);
  }

  const agentDir = getFreePiAgentDir();
  const code = await run({
    baseUrl: resolveBaseUrl(),
    agentDir,
    credentialsPath: getLegacyCredentialsPath(agentDir),
    promptConsent: promptConsentInteractive,
    openBrowser,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    launchPi,
    log: (message) => console.log(message),
    checkClientVersion,
    maybeSelfUpdate: (action, latest) =>
      maybeSelfUpdate(action, latest, {
        env: process.env,
        autoUpdateEnabled: () => readAutoUpdate(getConfigPath()),
        spawn: createRealSpawn(),
        cliRealpath: resolveCliRealpath(),
        log: (message) => console.log(message),
      }),
  });
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

/** Load the JWT from the legacy single-token store (pre-account-manager format). */
async function loadJwtForInline(path: string): Promise<string | null> {
  try {
    const raw = await import("node:fs/promises").then((m) => m.readFile(path, "utf8"));
    const parsed = JSON.parse(raw) as { token?: string };
    if (typeof parsed.token === "string" && parsed.token.length > 0) return parsed.token;
  } catch {
    // missing or malformed file
  }
  return null;
}

/** Clear the legacy single-token file. */
async function clearJwtInline(path: string): Promise<void> {
  try {
    await import("node:fs/promises").then((m) => m.rm(path, { force: true }));
  } catch {
    // no-op
  }
}
