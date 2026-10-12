// Pure argv parsing for the local commands (help / version / logout) and the
// run flags (--mode, --session), extracted from index.ts (untestable: main()
// runs on import) as a test seam.
//
// Privacy note, same invariant as run()'s decline path: none of the commands
// parsed here ever contact the free-pi server — they print or touch local
// files and exit. Only { kind: "run" } proceeds into the consent-gated flow.
import { CLI_VERSION } from "./version";

/** How the agent surface is rendered: the interactive TUI, or headless RPC. */
export type RunMode = "tui" | "rpc";

export type CliCommand =
  | { kind: "run"; mode: RunMode; session?: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "logout" }
  | { kind: "unknown"; arg: string };

export const HELP_TEXT = `
free-pi — free AI coding in your terminal; ads pay for the inference.

Usage:
  free-pi-cli                     start the coding agent (first run: consent + GitHub sign-in)
  free-pi-cli --session <id>      resume a session; the id is printed when one ends
  free-pi-cli --mode rpc          headless: JSONL commands on stdin, events on stdout
  free-pi-cli logout              remove the stored sign-in token; the next run signs in again
  free-pi-cli --version           print the CLI version
  free-pi-cli --help              show this help

Options:
  --session <id>   resume a specific session instead of starting a new one
  --mode <tui|rpc> tui (default) draws the interactive terminal UI; rpc speaks the
                   pi RPC protocol on stdio for embedding in another application

Environment:
  FREEPI_BASE_URL        override the backend base URL (default https://api.freepi.ai)
  FREEPI_NO_AUTO_UPDATE  disable in-place self-update for this run
`.trim();

export function versionLine(): string {
  return `free-pi-cli ${CLI_VERSION}`;
}

/**
 * argv is process.argv.slice(2). Anything unrecognized — or a trailing arg after
 * a valid local command — is { kind: "unknown" } so index.ts can show help and
 * exit nonzero, rather than silently ignoring input the way the arg-less CLI
 * used to (a typo'd `free-pi-cli loguot` must not quietly start a full agent
 * session and burn ad-funded tokens).
 *
 * Run flags are deliberately strict about their values: `--mode <anything but
 * tui|rpc>` is unknown rather than being coerced, and `--session` requires a
 * value, because both cases otherwise start a fresh session and burn tokens on
 * a command the user did not mean to run.
 */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const args = [...argv];
  const first = args.shift();
  if (first === undefined) return { kind: "run", mode: "tui" };

  // Local commands: everything after them is an error (unchanged behavior).
  const local =
    first === "--help" || first === "-h" || first === "help"
      ? ("help" as const)
      : first === "--version" || first === "-v"
        ? ("version" as const)
        : first === "logout"
          ? ("logout" as const)
          : undefined;
  if (local) {
    return args.length > 0 ? { kind: "unknown", arg: args[0] as string } : { kind: local };
  }

  let mode: RunMode = "tui";
  let session: string | undefined;
  const queue = [first, ...args];
  while (queue.length > 0) {
    const flag = queue.shift() as string;
    if (flag === "--mode") {
      const value = queue.shift();
      if (value !== "tui" && value !== "rpc") {
        return { kind: "unknown", arg: value ?? "--mode" };
      }
      mode = value;
    } else if (flag === "--session" || flag === "-s") {
      const value = queue.shift();
      if (!value || value.startsWith("-")) return { kind: "unknown", arg: flag };
      session = value;
    } else {
      return { kind: "unknown", arg: flag };
    }
  }

  return session === undefined ? { kind: "run", mode } : { kind: "run", mode, session };
}
