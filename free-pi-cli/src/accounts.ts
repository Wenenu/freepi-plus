import { readdirSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getFreePiAgentDir } from "./paths";

/** Per-account credential file. One GitHub account = one directory containing a credentials.json. */
export interface StoredAccountCredentials {
  token: string;
  /** GitHub account id (from /me user_id). Set by the CLI after login; never written by the user. */
  accountId: string;
  /** Human-facing label the user gave the account (e.g. "personal"). */
  label: string;
  /** Last known free allowance snapshot from GET /me. undefined until the account was polled. */
  usage?: {
    remainingUsdToday: number;
    capUsdToday: number;
    tier: string;
    creditUsd: number;
  };
}

/** Directory that holds every account's credential files. */
export const ACCOUNTS_DIR_NAME = "accounts";

/** Directory that holds every account's credential files. */
export function accountsDir(agentDir: string = getFreePiAgentDir()): string {
  return join(agentDir, ACCOUNTS_DIR_NAME);
}

export interface AccountInfo {
  id: string;
  label: string;
  /** Absolute path to the account's credentials.json. */
  credentialsPath: string;
  usage: StoredAccountCredentials["usage"];
  hasToken: boolean;
  /** true when the stored JWT could not be read (corrupt/401) — the CLI should treat it as invalid. */
  invalid: boolean;
}

/** Path to the "active" switch file that run.ts reads to know which account is in use. */
export const ACTIVE_ACCOUNT_FILE = ".active-account";

/**
 * Automatically migrate legacy single-token credentials.json into accounts/default/credentials.json
 * if no accounts directory exists yet.
 */
export function migrateLegacyCredentialsIfNeeded(agentDir: string = getFreePiAgentDir()): boolean {
  const legacyPath = join(agentDir, "credentials.json");
  if (!existsSync(legacyPath)) return false;

  const targetDir = join(accountsDir(agentDir), "default");
  const targetCredentials = join(targetDir, "credentials.json");
  if (existsSync(targetCredentials)) return false;

  try {
    const raw = readFileSync(legacyPath, "utf8");
    const parsed = JSON.parse(raw) as { token?: string };
    if (!parsed.token || typeof parsed.token !== "string") return false;

    mkdirSync(targetDir, { recursive: true });
    const stored: StoredAccountCredentials = {
      token: parsed.token,
      accountId: "default",
      label: "default",
    };
    writeFileSync(targetCredentials, JSON.stringify(stored), { mode: 0o600 });
    try {
      chmodSync(targetCredentials, 0o600);
    } catch {
      // Windows file permissions fallback
    }
    setActiveAccountId("default", agentDir);
    return true;
  } catch {
    return false;
  }
}

/** Read-only view of the directory contents (no side effects). */
export function listAccounts(agentDir: string = getFreePiAgentDir()): AccountInfo[] {
  const dir = accountsDir(agentDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => !entry.startsWith("."))
    // readdir order is filesystem-defined (ext4 returns hash order, NTFS usually
    // lexical), and /accounts offers 1-based switching — so the list must be
    // sorted here or "switch to account 2" picks a different account on Linux
    // than the list the user just read.
    .sort()
    .map((id) => {
      const info = loadAccountInfo(join(dir, id));
      return info;
    })
    .filter((info): info is AccountInfo => info !== null);
}

/** Full per-account detail for the /accounts diagnostic command. */
export function loadAccountInfo(accountDir: string): AccountInfo | null {
  const credentialsPath = join(accountDir, "credentials.json");
  if (!existsSync(credentialsPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(credentialsPath, "utf8");
  } catch {
    return null;
  }
  let parsed: StoredAccountCredentials;
  try {
    parsed = JSON.parse(raw) as StoredAccountCredentials;
  } catch {
    return {
      id: pathBasename(accountDir),
      label: pathBasename(accountDir),
      credentialsPath,
      usage: undefined,
      hasToken: false,
      invalid: true,
    };
  }
  return {
    id: parsed.accountId || pathBasename(accountDir),
    label: parsed.label || parsed.accountId || pathBasename(accountDir),
    credentialsPath,
    usage: parsed.usage,
    hasToken: typeof parsed.token === "string" && parsed.token.length > 0,
    invalid: false,
  };
}

function pathBasename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

/** Returns the id of the currently active account, or null if none is set. */
export function readActiveAccountId(agentDir: string = getFreePiAgentDir()): string | null {
  const path = join(agentDir, ACTIVE_ACCOUNT_FILE);
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** Atomically write the active account id. Defaults to "default" so a first run is unambiguous. */
export function setActiveAccountId(
  accountId: string,
  agentDir: string = getFreePiAgentDir(),
): void {
  const path = join(agentDir, ACTIVE_ACCOUNT_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, accountId, { mode: 0o600 });
}

/** Remove the active-account marker entirely (logged out or no accounts). */
export function clearActiveAccountId(agentDir: string = getFreePiAgentDir()): void {
  const path = join(agentDir, ACTIVE_ACCOUNT_FILE);
  try {
    rmSync(path, { force: true });
  } catch {
    // no-op
  }
}

/**
 * Resolve the account id the CLI should use for this run. Priority:
 *   1. FREEPI_ACTIVE_ACCOUNT environment override (explicit, for scripts/tests).
 *   2. The on-disk active marker (persisted choice, validated on disk).
 *   3. Migration of legacy credentials if present.
 *   4. The "default" directory if it exists.
 *   5. The first account in directory order.
 */
export function resolveActiveAccountId(
  agentDir: string = getFreePiAgentDir(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.FREEPI_ACTIVE_ACCOUNT) return env.FREEPI_ACTIVE_ACCOUNT;

  const active = readActiveAccountId(agentDir);
  if (active) {
    const credPath = join(accountsDir(agentDir), active, "credentials.json");
    if (existsSync(credPath)) {
      return active;
    }
  }

  // Check and run legacy migration if needed
  migrateLegacyCredentialsIfNeeded(agentDir);

  // Fallback to "default" so pre-existing single-account setups still work.
  const defaultPath = join(accountsDir(agentDir), "default", "credentials.json");
  if (existsSync(defaultPath)) {
    setActiveAccountId("default", agentDir);
    return "default";
  }

  const accounts = listAccounts(agentDir);
  if (accounts.length > 0) {
    const first = accounts[0]!.id;
    setActiveAccountId(first, agentDir);
    return first;
  }
  return null;
}

/** Pick a valid, usable account id from the store for the auto-swap logic. */
export function pickUsableAccountId(
  agentDir: string = getFreePiAgentDir(),
): string | null {
  const accounts = listAccounts(agentDir);
  for (const account of accounts) {
    if (account.invalid) continue;
    if (!account.hasToken) continue;
    // An account is out of allowance if polled and remainingUsdToday is <= 0.
    if (account.usage !== undefined && account.usage.remainingUsdToday <= 0) continue;
    return account.id;
  }
  return null;
}

/** Switch active account to one matching an id, label, or 1-based index. */
export function switchAccount(
  target: string,
  agentDir: string = getFreePiAgentDir(),
): AccountInfo | null {
  const accounts = listAccounts(agentDir);
  if (accounts.length === 0) return null;

  const trimmed = target.trim();
  const index = parseInt(trimmed, 10);
  if (!Number.isNaN(index) && index >= 1 && index <= accounts.length) {
    const matched = accounts[index - 1]!;
    setActiveAccountId(matched.id, agentDir);
    return matched;
  }

  const lower = trimmed.toLowerCase();
  const matched = accounts.find(
    (a) => a.id.toLowerCase() === lower || a.label.toLowerCase() === lower,
  );
  if (matched) {
    setActiveAccountId(matched.id, agentDir);
    return matched;
  }
  return null;
}

/** Save or update usage for an account. */
export function updateAccountUsage(
  accountId: string,
  usage: NonNullable<StoredAccountCredentials["usage"]>,
  agentDir: string = getFreePiAgentDir(),
): void {
  const credentialsPath = join(accountsDir(agentDir), accountId, "credentials.json");
  if (!existsSync(credentialsPath)) return;
  try {
    const raw = readFileSync(credentialsPath, "utf8");
    const parsed = JSON.parse(raw) as StoredAccountCredentials;
    parsed.usage = usage;
    writeFileSync(credentialsPath, JSON.stringify(parsed), { mode: 0o600 });
  } catch {
    // best-effort
  }
}
