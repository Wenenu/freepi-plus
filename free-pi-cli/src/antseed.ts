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
