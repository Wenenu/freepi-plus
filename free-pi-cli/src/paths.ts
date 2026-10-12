import { homedir } from "node:os";
import { join } from "node:path";

// Fully separate from pi's own `~/.pi/agent` so an existing pi install (and
// its credentials/settings/sessions) is never touched by free-pi-cli.
const FREE_PI_DIR_NAME = ".free-pi";

export function getFreePiAgentDir(): string {
  return join(homedir(), FREE_PI_DIR_NAME, "agent");
}

/** Identifier for a known local GitHub account, e.g. "personal" or "work". */
export type AccountId = string;

/** Directory that holds every account's credential files. */
export function accountsDir(agentDir: string = getFreePiAgentDir()): string {
  return join(agentDir, "accounts");
}

/** Per-account credentials file path. */
export function getAccountCredentialsPath(
  accountId: AccountId,
  agentDir: string = getFreePiAgentDir(),
): string {
  return join(accountsDir(agentDir), accountId, "credentials.json");
}

/** 0.2.6: the last CLI version whose "what's new" the user has already seen. */
export function getLastSeenVersionPath(agentDir: string = getFreePiAgentDir()): string {
  return join(agentDir, "last-seen-version");
}

/** #37 U1: the self-update opt-out config file, `~/.free-pi/config.json`. Read-only — never created. */
export function getConfigPath(): string {
  return join(homedir(), FREE_PI_DIR_NAME, "config.json");
}

/** Legacy single-token file path, used only so pre-upgrade logout still works. */
export function getLegacyCredentialsPath(agentDir: string = getFreePiAgentDir()): string {
  return join(agentDir, "credentials.json");
}
