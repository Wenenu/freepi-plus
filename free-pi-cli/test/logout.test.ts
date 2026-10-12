import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearJwtFor, loadJwtFor, saveJwtFor } from "../src/credentials";
import { runLogout, type LogoutDeps } from "../src/logout";
import { setActiveAccountId } from "../src/accounts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "free-pi-cli-logout-"));
}

/** Real credential fns against a temp dir plus a log recorder. The deps mirror
 * runLogout's LogoutDeps seam: a callable path-based loadJwt / clearJwt pair
 * and a log sink. */
function realDeps(
  agentDir: string,
  credentialsPath: string,
): LogoutDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    credentialsPath,
    loadJwt: (path) => loadJwtFor("", agentDir, path),
    clearJwt: (path) => clearJwtFor("", agentDir, path),
    log: (m) => logs.push(m),
    logs,
  };
}

describe("runLogout — purely local, always exits 0", () => {
  test("stored token -> file removed, 'Logged out' names the path, next loadJwt is null", async () => {
    const agentDir = tempDir();
    const credentialsPath = join(agentDir, "credenti.json");
    await saveJwt(credentialsPath, "jwt-abc");
    const deps = realDeps(agentDir, credentialsPath);

    const code = await runLogout({ ...deps, credentialsPath });

    expect(code).toBe(0);
    expect(existsSync(credentialsPath)).toBe(false);
    expect(await loadJwtFor("", agentDir, credentialsPath)).toBeNull();
    expect(deps.logs.join("\n")).toContain("Logged out");
    expect(deps.logs.join("\n")).toContain(credentialsPath);
  });

  /** Local single-token helper so the logout tests can exercise runLogout against
   * an arbitrary temp path without depending on the per-account store shape.
   */
  async function saveJwt(path: string, token: string): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
    await writeFile(path, JSON.stringify({ token }), { mode: 0o600 });
  }

  test("no stored token -> still exits 0 and says already logged out (idempotent)", async () => {
    const agentDir = tempDir();
    const credentialsPath = join(agentDir, "credenti.json");
    const deps = realDeps(agentDir, credentialsPath);

    const code = await runLogout(deps);

    expect(code).toBe(0);
    expect(deps.logs.join("\n")).toContain("Already logged out");
  });

  test("corrupt credentials file -> removed anyway (loadJwt reads it as null, clearJwt is unconditional)", async () => {
    const agentDir = tempDir();
    const credentialsPath = join(agentDir, "credenti.json");
    await writeFileSync(credentialsPath, "not json at all");

    const deps = realDeps(agentDir, credentialsPath);
    const code = await runLogout({ ...deps, credentialsPath });

    expect(code).toBe(0);
    expect(existsSync(credentialsPath)).toBe(false);
  });

  test("logout twice in a row -> second run is a clean no-op, not an error", async () => {
    const agentDir = tempDir();
    const credentialsPath = join(agentDir, "credenti.json");
    await saveJwt(credentialsPath, "jwt-abc");

    const firstDeps = realDeps(agentDir, credentialsPath);
    expect(await runLogout({ ...firstDeps, credentialsPath })).toBe(0);
    const secondDeps = realDeps(agentDir, credentialsPath);
    expect(await runLogout({ ...secondDeps, credentialsPath })).toBe(0);
    expect(secondDeps.logs.join("\n")).toContain("Already logged out");
  });

  test("logs out the resolved active account rather than only a bare path", async () => {
    const agentDir = tempDir();
    const credentialsPath = join(agentDir, "acct-1", "credentials.json");
    await saveJwtFor("acct-1", "jwt-abc", "acct-1", "acct-1", agentDir);
    setActiveAccountId("acct-1", agentDir);
    const deps = realDeps(agentDir, credentialsPath);

    const code = await runLogout({
      ...deps,
      credentialsPath,
    });

    expect(code).toBe(0);
    expect(existsSync(credentialsPath)).toBe(false);
    expect(await loadJwtFor("acct-1", agentDir, credentialsPath)).toBeNull();
  });
});
