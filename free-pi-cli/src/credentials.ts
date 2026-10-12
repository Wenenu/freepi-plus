import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { getAccountCredentialsPath, getFreePiAgentDir } from "./paths";

interface StoredCredentials {
  token: string;
  /** GitHub account id (from /me user_id). Set by the CLI after login; never written by the user. */
  accountId: string;
  /** Human-facing label the user gave the account. */
  label: string;
}

function agentDirFor(callerDir?: string): string {
  // Callers pass a local test dir; nothing else overrides at this layer.
  return callerDir ?? getFreePiAgentDir();
}

/** Path for the legacy single-token file, used only for migration/login paths. */
export function getLegacyCredentialsPath(agentDir: string = getFreePiAgentDir()): string {
  return `${agentDir}/credentials.json`;
}

/**
 * Load the JWT for a specific account id. Returns null when the file is missing,
 * malformed, or the token is empty.
 */
export async function loadJwtFor(
  accountId: string,
  agentDir?: string,
  credentialsPathOverride?: string,
): Promise<string | null> {
  const directory = agentDir ?? agentDirFor();
  const path = credentialsPathOverride ?? getAccountCredentialsPath(accountId, directory);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (typeof parsed.token === "string" && parsed.token.length > 0) {
      return parsed.token;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Load the full account record (token + accountId + label) for an account id.
 * Returns null when the file is missing or malformed, but never throws.
 */
export async function loadAccount(
  accountId: string,
  agentDir?: string,
  credentialsPathOverride?: string,
): Promise<StoredCredentials | null> {
  const directory = agentDir ?? agentDirFor();
  const path = credentialsPathOverride ?? getAccountCredentialsPath(accountId, directory);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (typeof parsed.token === "string" && parsed.token.length > 0) {
      return {
        token: parsed.token,
        accountId: parsed.accountId || accountId,
        label: parsed.label || accountId,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist a freshly issued JWT for a specific account id, with 0600 permissions. */
export async function saveJwtFor(
  accountId: string,
  token: string,
  accountIdOnDisk: string,
  label: string,
  agentDir?: string,
): Promise<void> {
  const directory = agentDir ?? agentDirFor();
  const credentialsPath = getAccountCredentialsPath(accountId, directory);
  await mkdir(dirname(credentialsPath), { recursive: true });
  await writeFile(credentialsPath, JSON.stringify({ token, accountId: accountIdOnDisk, label } satisfies StoredCredentials), {
    mode: 0o600,
  });
  // Belt-and-suspenders: writeFile's `mode` only applies to newly created
  // files on some platforms/umasks. Force it so re-runs stay 0600 too.
  try {
    await chmod(credentialsPath, 0o600);
  } catch {
    // Windows permissions
  }
}

/** Synchronous version of saveJwtFor. */
export function saveJwtForSync(
  accountId: string,
  token: string,
  accountIdOnDisk: string,
  label: string,
  agentDir?: string,
): void {
  const directory = agentDir ?? agentDirFor();
  const credentialsPath = getAccountCredentialsPath(accountId, directory);
  const { mkdirSync, writeFileSync, chmodSync } = require("node:fs");
  mkdirSync(dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, JSON.stringify({ token, accountId: accountIdOnDisk, label } satisfies StoredCredentials), {
    mode: 0o600,
  });
  try {
    chmodSync(credentialsPath, 0o600);
  } catch {
    // Windows permissions
  }
}

/** Remove the stored JWT for an account id. Idempotent. */
export async function clearJwtFor(
  accountId: string,
  agentDir?: string,
  credentialsPathOverride?: string,
): Promise<void> {
  const directory = agentDir ?? agentDirFor();
  const path = credentialsPathOverride ?? getAccountCredentialsPath(accountId, directory);
  await rm(path, { force: true });
}
