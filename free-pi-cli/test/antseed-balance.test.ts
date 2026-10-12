// Reading the buyer's balance out of the antseed CLI. The CLI prints a
// human-facing progress line before its JSON, exits non-zero when the daemon
// isn't running, and may not be installed at all — none of which may break the
// footer, so every failure mode here has to resolve to undefined.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchAntseedBalance } from "../src/antseed";

/** Writes a stand-in for the `antseed` binary and returns the command line. */
function fakeCli(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "antseed-cli-"));
  const file = join(dir, "fake-antseed.js");
  writeFileSync(file, source);
  return `node "${file.split("\\").join("/")}"`;
}

const STATUS_JSON = {
  connectionState: "connected",
  proxyPort: 8377,
  depositsAvailable: "0.45",
  depositsReserved: "2.0",
  activeChannels: 2,
  walletAddress: "0x25108E51c7ecA58976320117C969cd021D869644",
};

const BALANCE_JSON = {
  address: "0x25108E51c7ecA58976320117C969cd021D869644",
  walletUSDC: "0.0",
  depositsAvailable: "0.45",
  depositsReserved: "2.0",
};

describe("fetchAntseedBalance", () => {
  test("reads the balance out of `buyer status --json`, tolerating the spinner line", async () => {
    const command = fakeCli(
      `console.log("- Fetching balance...");\nconsole.log(${JSON.stringify(JSON.stringify(STATUS_JSON))});`,
    );

    const balance = await fetchAntseedBalance({ command, timeoutMs: 20_000 });

    expect(balance).toEqual({
      address: STATUS_JSON.walletAddress,
      availableUsd: 0.45,
      reservedUsd: 2,
      connectionState: "connected",
      activeChannels: 2,
    });
  });

  test("falls back to `buyer balance --json` when status yields nothing", async () => {
    const command = fakeCli(
      [
        `if (process.argv.includes("status")) { process.exit(3); }`,
        `console.log(${JSON.stringify(JSON.stringify(BALANCE_JSON))});`,
      ].join("\n"),
    );

    const balance = await fetchAntseedBalance({ command, timeoutMs: 20_000 });

    expect(balance).toEqual({
      address: BALANCE_JSON.address,
      availableUsd: 0.45,
      reservedUsd: 2,
      walletUsd: 0,
    });
  });

  test("a CLI that prints nothing, or nonsense, reads as unavailable", async () => {
    const silent = fakeCli("// prints nothing");
    expect(await fetchAntseedBalance({ command: silent, timeoutMs: 20_000 })).toBeUndefined();

    const nonsense = fakeCli("console.log('antseed: command not found')");
    expect(await fetchAntseedBalance({ command: nonsense, timeoutMs: 20_000 })).toBeUndefined();
  });

  test("a hung CLI is killed and reads as unavailable instead of blocking the footer", async () => {
    const command = fakeCli("setTimeout(() => {}, 60_000)");
    const started = Date.now();

    expect(await fetchAntseedBalance({ command, timeoutMs: 300 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
