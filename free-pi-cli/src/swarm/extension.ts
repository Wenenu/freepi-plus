// The built-in swarm: `/coordinate` starts a bug-bounty crew, `/swarm` is the
// control surface, and `free_pi_swarm` is the tool the coordinating model uses to
// deploy and steer that crew.
//
// This extension never runs a subagent *inside* the session — free-pi's inference
// is ad-funded and one session holds one lease, so the session keeps its
// single-concurrent-completion guarantee (test/no-subagents.test.ts SB2 still
// proves exactly that). What `/coordinate` does is turn this session into the
// coordinator of *other* sessions, each deployed as `free-pi-cli --mode rpc` in
// its own process with its own lease and its own allowance.
//
// Two things make the coordination real from inside a session:
//
//   * mail addressed to this session is pushed into it as a user message, so a
//     teammate's finding arrives without anyone polling;
//   * `free_pi_swarm` is how the model deploys the next worker — only when the
//     work is independent, never as a reflex.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { coordinatorBrief } from "./roles";
import {
  type AgentRecord,
  assertName,
  countUnread,
  drainMail,
  getAgent,
  leaveSwarm,
  listAgents,
  listClaims,
  listTasks,
  loadSwarmConfig,
  registerSession,
  saveSwarmConfig,
  selfAgentName,
  swarmDir,
  SwarmError,
} from "./store";
import { createSwarmTool } from "./tool";
import { crewSummary, spawnWorker, stopWorker } from "./workers";

export const SWARM_EXTENSION_NAME = "free-pi-swarm";
const STATUS_KEY = "free-pi-swarm";
const DEFAULT_POLL_MS = 3_000;

export interface CreateSwarmExtensionOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected in tests so a suite can drive the extension with no processes. */
  spawn?: typeof spawnWorker;
  stop?: typeof stopWorker;
  pollMs?: number;
}

/** A session is addressable by name; the coordinating one takes "coordinator". */
export function pickSessionName(env: NodeJS.ProcessEnv, sessionId: string): string {
  const forced = env.FREEPI_SWARM_AGENT?.trim();
  if (forced) return assertName("agent name", forced);
  const mine = getAgent("coordinator", env);
  if (!mine || mine.sessionId === sessionId || mine.status === "exited") return "coordinator";
  for (let i = 2; i < 20; i++) {
    const candidate = `coordinator-${i}`;
    const existing = getAgent(candidate, env);
    if (!existing || existing.sessionId === sessionId || existing.status === "exited") return candidate;
  }
  return `coordinator-${Date.now().toString(36)}`;
}

function formatStatusBlock(env: NodeJS.ProcessEnv, me: string): string {
  const cfg = loadSwarmConfig(env);
  const agents = listAgents(env);
  const crew = agents.filter((a) => a.source === "deployed" && a.status !== "exited");
  const tasks = listTasks(env);
  const claims = listClaims(env);
  const lines = [
    `swarm: ${cfg.enabled ? "ON" : "OFF"} (max ${cfg.maxWorkers} workers, lease ${Math.round(cfg.leaseSeconds / 60)}m)`,
    `you are: ${me}${countUnread(me, env) ? ` — ${countUnread(me, env)} unread message(s)` : ""}`,
    `state: ${swarmDir(env)}`,
  ];
  if (crew.length) {
    lines.push("crew:");
    for (const agent of crew) {
      lines.push(`  ${agent.name} (${agent.role}) ${agent.status}${agent.taskId ? ` · ${agent.taskId}` : ""}${agent.sessionId ? ` · session ${agent.sessionId.slice(0, 8)}` : ""}`);
    }
  } else lines.push("crew: none deployed");
  const others = agents.filter((a) => a.source === "session" && a.name !== me && a.status !== "exited");
  if (others.length) lines.push(`other sessions: ${others.map((a) => a.name).join(", ")}`);
  if (tasks.length) {
    lines.push("board:");
    for (const task of tasks) {
      lines.push(`  ${task.id} [${task.status}]${task.owner ? ` ${task.owner}` : ""}${task.scope ? ` (${task.scope})` : ""} — ${task.title}`);
    }
  } else lines.push("board: empty");
  lines.push(
    claims.length
      ? `scopes held: ${claims.map((c) => `${c.owner} → ${c.scope}`).join(", ")}`
      : "scopes held: none — claim one before testing anything",
  );
  return lines.join("\n");
}

export function createSwarmExtension(opts: CreateSwarmExtensionOptions = {}): InlineExtension {
  const env = opts.env ?? process.env;
  const doSpawn = opts.spawn ?? spawnWorker;
  const doStop = opts.stop ?? stopWorker;
  const pollMs = opts.pollMs ?? Number(env.FREEPI_SWARM_MAIL_POLL_MS ?? DEFAULT_POLL_MS);

  return {
    name: SWARM_EXTENSION_NAME,
    factory(pi: ExtensionAPI) {
      let selfName = selfAgentName(env);
      let cwd = process.cwd();
      let sessionId: string | null = null;
      let sessionFile: string | null = null;
      let watcher: ReturnType<typeof setInterval> | undefined;
      const deps = { env, self: () => selfName, cwd: () => cwd };

      pi.registerTool(createSwarmTool(deps));

      const pushMail = (ctx: ExtensionContext | ExtensionCommandContext): void => {
        const messages = drainMail(selfName, env);
        if (messages.length === 0) return;
        const text = [
          "[free-pi-swarm] messages from your teammates:",
          ...messages.map(
            (m) => `[from ${m.from}${m.kind !== "note" ? `, ${m.kind}` : ""}${m.subject ? `: ${m.subject}` : ""}${m.taskId ? ` (task ${m.taskId})` : ""}] ${m.body}`,
          ),
          '(Reply with the free_pi_swarm tool\'s "send" action, or `free-pi-cli swarm send --to <name> "…"` from bash.)',
        ].join("\n");
        // Queued after the current turn: a teammate's message must never cut the
        // user's own turn in half.
        pi.sendUserMessage(text, { deliverAs: "followUp" });
        ctx.ui.setStatus(STATUS_KEY, crewSummary(env));
      };

      const startWatcher = (ctx: ExtensionContext | ExtensionCommandContext): void => {
        if (watcher) return;
        // A deployed worker's supervisor already pushes its mail into its turns
        // (it is the half that can restore a message if delivery fails). Two
        // readers of one inbox would race to drain it.
        if (env.FREEPI_SWARM_AGENT) return;
        watcher = setInterval(() => {
          try {
            pushMail(ctx);
          } catch {
            // a watcher tick must never take the session down
          }
        }, Number.isFinite(pollMs) && pollMs > 0 ? pollMs : DEFAULT_POLL_MS);
        (watcher as unknown as { unref?: () => void }).unref?.();
      };

      /**
       * The roster entry carries the session id when the runtime exposes one, so
       * a teammate (or a human reading `swarm roster`) can correlate an agent
       * with the free-pi session behind it — including when a command is what
       * put this session on the roster, before `session_start` had a chance to.
       */
      const registerSelf = (ctx: ExtensionContext | ExtensionCommandContext): AgentRecord => {
        try {
          const id = ctx.sessionManager?.getSessionId?.() ?? null;
          if (id) sessionId = id;
          const file = ctx.sessionManager?.getSessionFile?.() ?? null;
          if (file) sessionFile = file;
        } catch {
          // an older runtime may not expose these; the entry just stays anonymous
        }
        const record = registerSession({ name: selfName, role: "coordinator", cwd, sessionId, sessionFile }, env);
        ctx.ui.setStatus(STATUS_KEY, crewSummary(env));
        return record;
      };

      // ---- /coordinate ------------------------------------------------------
      pi.registerCommand("coordinate", {
        description:
          "Start a bug-bounty crew: turn the swarm switch on, put yourself on the roster, and let you (the agent) plan the target, claim a scope and deploy workers only where the work is genuinely independent. Use `--crew` to deploy a recon worker immediately.",
        handler: async (args, ctx) => {
          cwd = ctx.cwd ?? cwd;
          const raw = (args ?? "").trim();
          const withCrew = /(^|\s)--?crew(\s|$)/i.test(raw);
          const goal = raw.replace(/(^|\s)--?crew(\s|$)/i, " ").trim();

          const before = loadSwarmConfig(env);
          saveSwarmConfig({ enabled: true }, env);
          const cfg = loadSwarmConfig(env);
          registerSelf(ctx);
          startWatcher(ctx);

          const notes: string[] = [];
          notes.push(
            before.enabled
              ? `Coordinating. The swarm switch was already on (max ${cfg.maxWorkers} workers).`
              : `Coordinating. I turned the swarm switch ON (max ${cfg.maxWorkers} workers) — each worker is a separate free-pi session with its own free allowance, so the limit is what keeps this affordable.`,
          );
          notes.push(`You are "${selfName}" on the roster. State lives in ${swarmDir(env)}.`);

          if (withCrew) {
            try {
              const task = listTasks(env).find((t) => t.status === "open");
              const worker = doSpawn(
                {
                  name: "recon-1",
                  role: "recon",
                  cwd,
                  taskId: task?.id ?? null,
                  extra: goal || undefined,
                },
                env,
              );
              notes.push(
                `Deployed ${worker.name} (recon) in its own session${task ? ` on ${task.id}` : ""} — slot ${worker.slot}, log ${worker.logPath}.`,
              );
            } catch (err) {
              notes.push(`Could not deploy a recon worker: ${(err as Error).message}`);
            }
          } else {
            notes.push(
              'No crew deployed yet — that is deliberate: you decide what is worth its own session. Recon the target, put scopes on the board, then deploy with free_pi_swarm action:"spawn".',
            );
          }
          ctx.ui.notify(notes.join("\n"), "info");

          // This is the part that makes it work: the coordinating agent gets the
          // operating brief as a message, so it starts planning immediately.
          pi.sendUserMessage(coordinatorBrief(goal, cwd), { deliverAs: "followUp" });
        },
      });

      // ---- /swarm -----------------------------------------------------------
      pi.registerCommand("swarm", {
        description: "Swarm control: status (default), on, off, crew, stop [name|all], board, inbox.",
        handler: async (args, ctx) => {
          const [sub, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
          try {
            switch ((sub ?? "status").toLowerCase()) {
              case "on": {
                saveSwarmConfig({ enabled: true }, env);
                registerSelf(ctx);
                startWatcher(ctx);
                ctx.ui.notify(`Swarm switch ON (max ${loadSwarmConfig(env).maxWorkers} workers).`, "info");
                return;
              }
              case "off": {
                saveSwarmConfig({ enabled: false }, env);
                ctx.ui.setStatus(STATUS_KEY, crewSummary(env));
                ctx.ui.notify("Swarm switch OFF — nothing new will be deployed. Running workers keep going until you stop them (/swarm stop all).", "info");
                return;
              }
              case "status": {
                ctx.ui.notify(formatStatusBlock(env, selfName), "info");
                return;
              }
              case "board": {
                const tasks = listTasks(env);
                ctx.ui.notify(tasks.length ? tasks.map((t) => `${t.id} [${t.status}] ${t.owner ?? "-"} — ${t.title}`).join("\n") : "The board is empty.", "info");
                return;
              }
              case "crew": {
                const role = rest[0] ?? "hunter";
                const taskId = rest[1] ?? listTasks(env).find((t) => t.status === "open")?.id ?? null;
                const worker = doSpawn({ name: `${role}-${Date.now().toString(36).slice(-4)}`, role, cwd: ctx.cwd ?? cwd, taskId }, env);
                ctx.ui.notify(`Deployed ${worker.name} (${role})${taskId ? ` on ${taskId}` : " (it will pick from the board)"} — log ${worker.logPath}.`, "info");
                ctx.ui.setStatus(STATUS_KEY, crewSummary(env));
                return;
              }
              case "stop": {
                const target = rest[0];
                if (!target || target === "all") {
                  const names = listAgents(env)
                    .filter((a) => a.source === "deployed" && a.status !== "exited")
                    .map((a) => a.name);
                  for (const name of names) doStop(name, "stopped from /swarm", env);
                  ctx.ui.notify(names.length ? `Stopping ${names.length}: ${names.join(", ")}` : "No workers were running.", "info");
                } else {
                  doStop(assertName("agent name", target), "stopped from /swarm", env);
                  ctx.ui.notify(`${target} was asked to stop; it releases its scopes and tasks as it exits.`, "info");
                }
                ctx.ui.setStatus(STATUS_KEY, crewSummary(env));
                return;
              }
              case "inbox": {
                const messages = drainMail(selfName, env);
                ctx.ui.notify(
                  messages.length
                    ? messages.map((m) => `from ${m.from} (${m.kind}): ${m.body}`).join("\n")
                    : "No new messages.",
                  "info",
                );
                return;
              }
              default:
                ctx.ui.notify(`Unknown subcommand "${sub}". Try: status, on, off, crew [role], stop [name|all], board, inbox.`, "error");
            }
          } catch (err) {
            const e = err as SwarmError;
            ctx.ui.notify(`/swarm ${sub ?? ""}: ${e.message}`, "error");
          }
        },
      });

      // ---- session lifecycle ------------------------------------------------
      pi.on("session_start", async (_event, ctx) => {
        cwd = ctx.cwd ?? cwd;
        try {
          sessionId = ctx.sessionManager?.getSessionId?.() ?? null;
          sessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
        } catch {
          // an older runtime may not expose these; the roster entry just stays anonymous
        }
        selfName = pickSessionName(env, sessionId ?? String(process.pid));
        deps.self = () => selfName;

        const cfg = loadSwarmConfig(env);
        // Only a session that opted in (or one that already has mail waiting) is
        // put on the roster and polled — a plain free-pi session stays untouched.
        const unread = countUnread(selfName, env);
        if (cfg.enabled || unread > 0 || env.FREEPI_SWARM_AGENT) {
          registerSelf(ctx);
          startWatcher(ctx);
          if (unread > 0) ctx.ui.notify(`${unread} swarm message(s) waiting — read them with /swarm inbox.`, "info");
        }
        ctx.ui.setStatus(STATUS_KEY, crewSummary(env));
      });

      pi.on("session_shutdown", () => {
        if (watcher) {
          clearInterval(watcher);
          watcher = undefined;
        }
        try {
          const record = getAgent(selfName, env);
          if (record && record.status !== "exited" && !env.FREEPI_SWARM_AGENT) {
            // The session is gone: free what it was holding so no teammate is
            // blocked behind it. Its deployed workers are separate processes and
            // keep their own claims.
            leaveSwarm(selfName, env);
          }
        } catch {
          // shutdown must never throw
        }
      });
    },
  };
}

