// A stand-in for the free-pi binary, so the swarm's *process* layer — spawn,
// brief, mail push, stop, cleanup — can be verified end to end without a
// sign-in, without the network and without spending anyone's allowance.
//
// It plays two roles, chosen by argv, because `FREEPI_SWARM_CMD` replaces the
// binary everywhere it is started:
//
//   * `… swarm worker …`  → the deployed worker's supervisor. This delegates to
//                           the real implementation (src/swarm/workers.ts) so
//                           the code under test is the shipped code; only the
//                           inner `--mode rpc` child is faked.
//   * anything else       → a fake `--mode rpc` session: it speaks just enough
//                           of the pi RPC protocol for the supervisor, and then
//                           acts out the role it was given — claiming its task,
//                           claiming its scope, reporting a finding on the bus
//                           and closing the task, all through the real
//                           `free-pi-cli swarm …` CLI, exactly as the brief
//                           instructs a real agent to.
//
// What it writes (for scripts/verify-swarm.sh to assert on), in $STUB_DIR:
//   <agent>.log  every prompt/steer it was handed, and every CLI call it made
//                with the exit code. The prompt log is how the script proves the
//                brief arrived and that mail was *pushed*, not polled for.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "index.ts");
const argv = process.argv.slice(2);

// ---- role 1: the supervisor -------------------------------------------------
if (argv[0] === "swarm") {
  const { runSwarmCli } = await import("../src/swarm/cli");
  process.exit(await runSwarmCli(argv.slice(1)));
}

// ---- role 2: a fake `--mode rpc` session ------------------------------------
const stubDir = process.env.STUB_DIR ?? join(HERE, "..", ".stub");
mkdirSync(stubDir, { recursive: true });
const agent = process.env.FREEPI_SWARM_AGENT ?? "unknown";
const logPath = join(stubDir, `${agent}.log`);
const log = (line: string): void => {
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch {
    // a stub log line must never be the reason a check fails
  }
};

const write = (value: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

let seq = 0;

/** Run this CLI's own swarm command, the way a worker's bash tool would. */
function swarm(...args: string[]): number {
  const res = spawnSync(process.execPath, [CLI, "swarm", ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, FREEPI_SWARM_AGENT: agent },
  });
  const status = res.status ?? 1;
  log(`$ swarm ${args.join(" ")} -> ${status}`);
  if (status !== 0) log(`  stderr: ${(res.stderr ?? "").trim().slice(0, 400)}`);
  return status;
}

let didBrief = false;

/** The turns a real worker would take, in the order its brief asks for. */
function actOnBrief(): void {
  log("brief accepted");
  // A worker must not be able to grow the crew behind the coordinator's back.
  // It is refused (exit 3) and told to report on the bus instead.
  swarm("spawn", "--name", "sibling", "--role", "hunter");
  swarm("task", "claim", "BB-1");
  swarm("claim", "api.example.com/v2", "--ttl", "30");
  swarm("send", "--to", "coordinator", "--kind", "finding", "IDOR on /v2/orders?tenant=2 returns tenant 1 rows");
  swarm("task", "done", "BB-1", "--evidence", "GET /v2/orders?tenant=2 returns tenant 1 rows");
}

function onPrompt(text: string, kind: string): void {
  log(`>> ${kind}: ${text.replace(/\r?\n/g, " | ").slice(0, 600)}`);
  if (text.includes("[free-pi-swarm]")) {
    log(`mail handled: ${kind}`);
    return;
  }
  if (text.includes(`You are ${agent}`)) {
    if (didBrief) {
      log("duplicate brief ignored");
      return;
    }
    didBrief = true;
    actOnBrief();
    return;
  }
  log(`unrecognized turn (${kind}), ignoring`);
}

let carry = "";
process.stdin.on("data", (chunk: Buffer) => {
  carry += chunk.toString("utf8");
  let index: number;
  while ((index = carry.indexOf("\n")) !== -1) {
    const line = carry.slice(0, index).replace(/\r$/, "");
    carry = carry.slice(index + 1);
    if (!line.trim()) continue;
    let command: Record<string, unknown>;
    try {
      command = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log(`unparseable command: ${line.slice(0, 200)}`);
      continue;
    }
    const type = String(command.type ?? "");
    const id = String(command.id ?? `s${++seq}`);
    if (type === "get_state") {
      write({
        type: "response",
        id,
        command: type,
        success: true,
        data: { sessionId: `stub-${agent}`, sessionFile: join(stubDir, `${agent}.jsonl`) },
      });
      continue;
    }
    if (type === "set_session_name") {
      log(`session name: ${String(command.name ?? "")}`);
      write({ type: "response", id, command: type, success: true });
      continue;
    }
    if (type === "prompt" || type === "steer") {
      write({ type: "response", id, command: type, success: true });
      write({ type: "turn_start" });
      onPrompt(String(command.message ?? ""), type);
      write({ type: "turn_end", reason: "complete" });
      continue;
    }
    // abort and anything else this stub does not model: acknowledge, do nothing.
    log(`unhandled command: ${type}`);
    write({ type: "response", id, command: type, success: true });
  }
});

process.stdin.on("end", () => {
  log("stdin closed — session over");
  process.exit(0);
});
