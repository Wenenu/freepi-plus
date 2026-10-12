import { spawn } from "node:child_process";

export const ANTSEED_PROVIDER_NAME = "antseed";
export const ANTSEED_DEFAULT_BASE_URL = "http://127.0.0.1:8377";
export const ANTSEED_DEPOSIT_TOOL_NAME = "antseed_deposit_usdc";

export interface AntseedDepositResult {
  address: string;
  network: string;
  rawOutput: string;
}

/**
 * Runs `antseed buyer deposit --no-watch` to fetch the USDC deposit address and instructions.
 * Works both with global `antseed` and via `npx @antseed/cli`.
 */
export async function getAntseedDepositAddress(): Promise<AntseedDepositResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("antseed", ["buyer", "deposit", "--no-watch"], {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", () => {
      const npxProc = spawn("npx", ["-y", "@antseed/cli", "buyer", "deposit", "--no-watch"], {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let npxStdout = "";
      let npxStderr = "";
      npxProc.stdout.on("data", (c) => {
        npxStdout += c.toString();
      });
      npxProc.stderr.on("data", (c) => {
        npxStderr += c.toString();
      });
      npxProc.on("close", (code) => {
        if (code === 0) {
          resolve(parseDepositOutput(npxStdout));
        } else {
          reject(new Error(`Failed to retrieve Antseed deposit address: ${npxStderr || npxStdout}`));
        }
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(parseDepositOutput(stdout));
      } else {
        const npxProc = spawn("npx", ["-y", "@antseed/cli", "buyer", "deposit", "--no-watch"], {
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let npxStdout = "";
        let npxStderr = "";
        npxProc.stdout.on("data", (c) => {
          npxStdout += c.toString();
        });
        npxProc.stderr.on("data", (c) => {
          npxStderr += c.toString();
        });
        npxProc.on("close", (npxCode) => {
          if (npxCode === 0) {
            resolve(parseDepositOutput(npxStdout));
          } else {
            reject(new Error(`Failed to retrieve Antseed deposit address: ${stderr || npxStderr || stdout}`));
          }
        });
      }
    });
  });
}

function parseDepositOutput(output: string): AntseedDepositResult {
  const match = output.match(/Address:\s*(0x[a-fA-F0-9]{40})/);
  const address = match ? match[1]! : "Unknown";
  return {
    address,
    network: "Base",
    rawOutput: output.trim(),
  };
}

// ---- buyer balance ---------------------------------------------------------

/**
 * The buyer's on-chain deposit account, as reported by the antseed CLI.
 * `availableUsd` is spendable right now; `reservedUsd` is already committed to
 * open payment channels (still the buyer's money — it comes back when a channel
 * closes) — so "how much do I have left" is available + reserved.
 */
export interface AntseedBalance {
  /** Buyer wallet address (Base L2), when the CLI reports one. */
  address?: string;
  availableUsd?: number;
  reservedUsd?: number;
  /** Hot-wallet USDC, not the inference balance — shown only for context. */
  walletUsd?: number;
  /** The running buyer daemon's connection state, e.g. "connected". */
  connectionState?: string;
  activeChannels?: number;
}

export interface AntseedBalanceOptions {
  /** Per-invocation timeout. Defaults to 5s. */
  timeoutMs?: number;
  /** CLI command override (tests). Defaults to `antseed`, then `npx @antseed/cli`. */
  command?: string;
}

/**
 * `antseed buyer status --json` reads the daemon's live state and includes the
 * deposits balance; `antseed buyer balance --json` is the dedicated (daemonless)
 * balance read. The second command is used when the first yields no balance,
 * or when the CLI refuses to run at all.
 *
 * `ANTSEED_CLI_COMMAND` overrides the CLI itself (a non-PATH install), which
 * also keeps balance reads hermetic in tests.
 */
const ANTSEED_CLI_COMMANDS: readonly string[] = ["antseed", "npx -y @antseed/cli"];

/**
 * Reads the buyer's USDC balance. Never throws — a missing CLI, a stopped
 * daemon, an offline chain read, or malformed output all resolve to undefined
 * so the caller (the status line) can render "unavailable" instead of dying.
 */
export async function fetchAntseedBalance(opts: AntseedBalanceOptions = {}): Promise<AntseedBalance | undefined> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const commands = opts.command
    ? [opts.command]
    : process.env.ANTSEED_CLI_COMMAND
      ? [process.env.ANTSEED_CLI_COMMAND]
      : ANTSEED_CLI_COMMANDS;
  for (const command of commands) {
    const status = await runJsonCommand(`${command} buyer status --json`, timeoutMs);
    const fromStatus = balanceFromStatus(status);
    if (fromStatus) return fromStatus;
    const balance = await runJsonCommand(`${command} buyer balance --json`, timeoutMs);
    const fromBalance = balanceFromBalance(balance);
    if (fromBalance) return fromBalance;
  }
  return undefined;
}

function balanceFromStatus(raw: Record<string, unknown> | undefined): AntseedBalance | undefined {
  if (!raw) return undefined;
  const availableUsd = numberField(raw.depositsAvailable);
  if (availableUsd === undefined) return undefined;
  return {
    address: stringField(raw.walletAddress),
    availableUsd,
    reservedUsd: numberField(raw.depositsReserved),
    connectionState: stringField(raw.connectionState),
    activeChannels: numberField(raw.activeChannels),
  };
}

function balanceFromBalance(raw: Record<string, unknown> | undefined): AntseedBalance | undefined {
  if (!raw) return undefined;
  const availableUsd = numberField(raw.depositsAvailable);
  if (availableUsd === undefined) return undefined;
  return {
    address: stringField(raw.address),
    availableUsd,
    reservedUsd: numberField(raw.depositsReserved),
    walletUsd: numberField(raw.walletUSDC),
  };
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Runs one antseed CLI invocation and parses its JSON object output, if any. */
function runJsonCommand(command: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const done = (value: Record<string, unknown> | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child: ReturnType<typeof spawn> | undefined;
    const timer = setTimeout(() => {
      child?.kill();
      done(undefined);
    }, timeoutMs);
    // A pending balance read must never hold the process open.
    (timer as unknown as { unref?: () => void }).unref?.();

    try {
      child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      done(undefined);
      return;
    }

    // The CLI may print a spinner/notice line before the JSON payload, so
    // parse from the first brace rather than the whole stdout.
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => done(undefined));
    child.on("close", () => done(parseJsonObject(stdout)));
  });
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks whether the Antseed buyer proxy endpoint is accessible.
 */
export async function isAntseedReachable(baseUrl: string = ANTSEED_DEFAULT_BASE_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(1500),
    }).catch(async () => {
      return await fetch(`${baseUrl.replace(/\/+$/, "")}/`, {
        signal: AbortSignal.timeout(1500),
      });
    });
    return res.status < 500;
  } catch {
    return false;
  }
}
