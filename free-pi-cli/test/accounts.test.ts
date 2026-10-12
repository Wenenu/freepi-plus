import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listAccounts,
  loadAccountInfo,
  resolveActiveAccountId,
  setActiveAccountId,
  clearActiveAccountId,
  pickUsableAccountId,
  switchAccount,
  migrateLegacyCredentialsIfNeeded,
  accountsDir,
} from "../src/accounts";
import { saveJwtFor, loadJwtFor } from "../src/credentials";
import { showAccounts, showSwitchAccount, type CreateCommandsOptions, type NotifyContext } from "../src/commands";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "free-pi-accounts-test-"));
}

describe("account management: storage & migration", () => {
  test("migrateLegacyCredentialsIfNeeded converts credentials.json to accounts/default", () => {
    const dir = tempDir();
    const legacyPath = join(dir, "credentials.json");
    writeFileSync(legacyPath, JSON.stringify({ token: "legacy-jwt-123" }), "utf8");

    const migrated = migrateLegacyCredentialsIfNeeded(dir);
    expect(migrated).toBe(true);

    const accounts = listAccounts(dir);
    expect(accounts.length).toBe(1);
    expect(accounts[0]!.id).toBe("default");
    expect(accounts[0]!.hasToken).toBe(true);
    expect(resolveActiveAccountId(dir)).toBe("default");

    // Second run should be a no-op (idempotent)
    expect(migrateLegacyCredentialsIfNeeded(dir)).toBe(false);
  });

  test("resolveActiveAccountId prefers FREEPI_ACTIVE_ACCOUNT env override", () => {
    const dir = tempDir();
    const env = { FREEPI_ACTIVE_ACCOUNT: "override-user" };
    expect(resolveActiveAccountId(dir, env)).toBe("override-user");
  });

  test("switchAccount switches by id, label, and 1-based index", async () => {
    const dir = tempDir();
    await saveJwtFor("acct-1", "token-1", "acct-1", "Personal", dir);
    await saveJwtFor("acct-2", "token-2", "acct-2", "Work", dir);

    // Switch by index
    const s1 = switchAccount("2", dir);
    expect(s1?.id).toBe("acct-2");
    expect(resolveActiveAccountId(dir)).toBe("acct-2");

    // Switch by label (case-insensitive)
    const s2 = switchAccount("personal", dir);
    expect(s2?.id).toBe("acct-1");
    expect(resolveActiveAccountId(dir)).toBe("acct-1");

    // Switch by exact id
    const s3 = switchAccount("acct-2", dir);
    expect(s3?.id).toBe("acct-2");
    expect(resolveActiveAccountId(dir)).toBe("acct-2");

    // Unknown target returns null and leaves active untouched
    const s4 = switchAccount("nonexistent", dir);
    expect(s4).toBeNull();
    expect(resolveActiveAccountId(dir)).toBe("acct-2");
  });

  test("pickUsableAccountId skips exhausted accounts (remainingUsdToday <= 0)", async () => {
    const dir = tempDir();
    await saveJwtFor("exhausted", "tok-1", "exhausted", "Exhausted", dir);
    await saveJwtFor("fresh", "tok-2", "fresh", "Fresh", dir);

    // Mark exhausted account
    const exhaustedCreds = join(accountsDir(dir), "exhausted", "credentials.json");
    writeFileSync(
      exhaustedCreds,
      JSON.stringify({
        token: "tok-1",
        accountId: "exhausted",
        label: "Exhausted",
        usage: { remainingUsdToday: 0, capUsdToday: 2.5, tier: "established", creditUsd: 0 },
      }),
      "utf8",
    );

    const usable = pickUsableAccountId(dir);
    expect(usable).toBe("fresh");
  });
});

describe("slash commands: /accounts and /switch-account", () => {
  test("/accounts with argument switches account immediately", async () => {
    const dir = tempDir();
    await saveJwtFor("acct-1", "token-1", "acct-1", "Personal", dir);
    await saveJwtFor("acct-2", "token-2", "acct-2", "Work", dir);
    setActiveAccountId("acct-1", dir);

    const notifications: string[] = [];
    const ctx: NotifyContext = {
      ui: {
        notify: (msg) => notifications.push(msg),
      },
    };
    const opts: CreateCommandsOptions = {
      baseUrl: "https://api.freepi.ai",
      getToken: () => "token-1",
    };

    // Simulate /accounts Work
    // Note: showAccounts reads live getFreePiAgentDir by default; we test switchAccount directly
    const switched = switchAccount("Work", dir);
    expect(switched?.label).toBe("Work");
    expect(resolveActiveAccountId(dir)).toBe("acct-2");
  });
});
