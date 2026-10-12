// The `free_pi_swarm` tool: how the *coordinating session* runs a swarm — the
// switch, the roster, the board, scope claims and the bus, plus deploying and
// stopping workers.
//
// This is the "only when it is needed" half of the feature. Nothing spawns a
// worker on its own: the coordinating model decides that a piece of work is
// independent enough to hand to its own session, and calls this tool. Every
// deploy is a separate ad-funded free-pi session, which is why the tool's
// description and guidelines push the model to check `status` first and to
// prefer doing the work itself over deploying a crew to look busy.
import { Type, type Static } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MAIL_KINDS,
  type MailKind,
  type Task,
  addTask,
  assertName,
  claimScope,
  claimTask,
  countUnread,
  drainMail,
  finishTask,
  getAgent,
  getTask,
  listAgents,
  listClaims,
  listTasks,
  loadSwarmConfig,
  nowIso,
  putTask,
  releaseScope,
  roleBrief,
  saveSwarmConfig,
  scopeKey,
  sendMail,
  SwarmError,
  swarmDir,
} from "./store";
import { spawnWorker, stopWorker } from "./workers";

export const SWARM_TOOL_NAME = "free_pi_swarm";

const Action = Type.Union(
  [
    Type.Literal("status"),
    Type.Literal("enable"),
    Type.Literal("disable"),
    Type.Literal("plan"),
    Type.Literal("spawn"),
    Type.Literal("stop"),
    Type.Literal("task"),
    Type.Literal("claim"),
    Type.Literal("release"),
    Type.Literal("send"),
    Type.Literal("inbox"),
    Type.Literal("report"),
  ],
  {
    description:
      "status: roster + board + claims + unread mail. enable/disable: the deployment switch. " +
      "plan: put several tasks on the board at once. spawn: deploy a worker session. stop: end one or all workers. " +
      "task: add/claim/done/fail/block/reopen/list. claim/release: exclusive rights to a scope. " +
      "send: message a teammate (or everyone). inbox: read your own mail. report: broadcast a finding.",
  },
);

const PARAMS = Type.Object({
  action: Action,
  role: Type.Optional(
    Type.Union([Type.Literal("recon"), Type.Literal("hunter"), Type.Literal("verifier"), Type.Literal("scribe")], {
      description: "For spawn/plan: which job the worker does.",
    }),
  ),
  name: Type.Optional(Type.String({ description: "For spawn/stop: the worker's name (defaults to role-<n>)." })),
  cwd: Type.Optional(Type.String({ description: "For spawn: the worker's working directory. Defaults to this session's." })),
  taskId: Type.Optional(Type.String({ description: "For spawn: the task the worker starts on." })),
  extra: Type.Optional(Type.String({ description: "For spawn: one extra instruction appended to the worker's brief." })),
  all: Type.Optional(Type.Boolean({ description: "For stop: stop every deployed worker." })),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Optional(Type.String()),
        title: Type.String(),
        detail: Type.Optional(Type.String()),
        scope: Type.Optional(Type.String()),
        role: Type.Optional(Type.String()),
      }),
      { description: "For plan: the tasks to put on the board." },
    ),
  ),
  op: Type.Optional(
    Type.Union(
      [
        Type.Literal("add"),
        Type.Literal("list"),
        Type.Literal("claim"),
        Type.Literal("done"),
        Type.Literal("fail"),
        Type.Literal("block"),
        Type.Literal("reopen"),
      ],
      { description: "For task: what to do with it." },
    ),
  ),
  id: Type.Optional(Type.String({ description: "The task id, for task/claim." })),
  title: Type.Optional(Type.String({ description: "For task add: the task's one-line title." })),
  detail: Type.Optional(Type.String({ description: "For task add: what the task actually involves." })),
  scope: Type.Optional(
    Type.String({ description: "A host, URL path prefix, repo+dir or binary — narrow enough for one session to exhaust." }),
  ),
  ttlMinutes: Type.Optional(Type.Number({ description: "For claim: how long the scope claim lasts (default 30)." })),
  body: Type.Optional(Type.String({ description: "Message text, or a finding's description." })),
  to: Type.Optional(Type.String({ description: "For send: the recipient's name." })),
  // A plain string rather than a union of literals: the tool schema stays
  // readable to the model, and the kind is validated against MAIL_KINDS in the
  // handler, where an unknown value can produce a useful error message.
  kind: Type.Optional(
    Type.String({ description: `For send/report: ${MAIL_KINDS.join("|")} (default note).` }),
  ),
  subject: Type.Optional(Type.String({ description: "For send: a one-line subject." })),
  evidence: Type.Optional(Type.String({ description: "For task done: the exact reproduction." })),
  result: Type.Optional(Type.String({ description: "For task fail/block: what you ruled out, or what is blocking." })),
});

export type SwarmToolParams = Static<typeof PARAMS>;

export interface SwarmToolDetails {
  ok: boolean;
  action: string;
  summary: string;
  info?: Record<string, unknown>;
}

/** Identity + environment the tool works with; injected so tests need no session. */
export interface SwarmToolDeps {
  env?: NodeJS.ProcessEnv;
  /** The coordinating session's own roster name. */
  self: () => string;
  cwd: () => string;
}

function bullets(lines: string[]): string {
  return lines.join("\n");
}

/**
 * The spend line. A deployed worker runs this same tool (its session loads this
 * extension), and it needs the board, the bus and its claims — but deciding who
 * gets deployed is the coordinating session's call, and each deployment spends a
 * separate allowance. This is the one action family a worker is refused.
 *
 * Who is a worker is answered by the roster (`source: "deployed"`), not by the
 * FREEPI_SWARM_AGENT variable: that variable is also how a session names itself,
 * so a hand-named session must keep the full tool.
 */
function assertMayDeploy(me: string, action: string, env: NodeJS.ProcessEnv): void {
  const record = getAgent(me, env);
  if (record?.source !== "deployed") return;
  throw new SwarmError(
    `free_pi_swarm "${action}" belongs to the coordinating session: a deployed worker (${me}) works its task, reports on the bus ("report"/"send") and keeps the board up to date. Ask the coordinator to deploy instead.`,
    3,
  );
}

/** Validate the message kind from the model, which is free-form text. */
function mailKind(value: string | undefined): MailKind {
  const kind = value ?? "note";
  if (!(MAIL_KINDS as readonly string[]).includes(kind)) {
    throw new SwarmError(`unknown message kind "${kind}" (${MAIL_KINDS.join(", ")})`);
  }
  return kind as MailKind;
}

function boardLine(task: Task): string {
  return `${task.id} [${task.status}]${task.owner ? ` by ${task.owner}` : ""}${task.scope ? ` scope=${task.scope}` : ""} — ${task.title}`;
}

function nextId(role: string, env: NodeJS.ProcessEnv): string {
  const taken = new Set(listAgents(env).map((a) => a.name));
  for (let i = 1; i < 50; i++) {
    const candidate = `${role}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${role}-${Date.now().toString(36)}`;
}

/**
 * One place implements every action, returning text for the model and details
 * for the transcript — so the CLI, the tests and the tool all drive the same
 * code path.
 */
export async function runSwarmAction(
  params: SwarmToolParams,
  deps: SwarmToolDeps,
): Promise<{ text: string; details: SwarmToolDetails }> {
  const env = deps.env ?? process.env;
  const me = deps.self();
  const cfg = loadSwarmConfig(env);

  switch (params.action) {
    case "enable":
    case "disable": {
      assertMayDeploy(me, params.action, env);
      const enabled = params.action === "enable";
      const next = saveSwarmConfig({ enabled }, env);
      return {
        text: enabled
          ? `The swarm switch is ON (max ${next.maxWorkers} workers). Deploy a worker with action:"spawn". Each worker is a separate free-pi session, so the limit is a spend limit.`
          : "The swarm switch is OFF. Nothing new will be deployed; already-running workers keep going until you stop them.",
        details: { ok: true, action: params.action, summary: `switch ${enabled ? "on" : "off"}`, info: next as unknown as Record<string, unknown> },
      };
    }

    case "status": {
      const agents = listAgents(env);
      const tasks = listTasks(env);
      const claims = listClaims(env);
      const crew = agents.filter((a) => a.source === "deployed" && a.status !== "exited");
      const lines = [
        `swarm: ${cfg.enabled ? "ON" : "OFF"} (max ${cfg.maxWorkers} workers, default role ${cfg.defaultRole}, lease ${Math.round(cfg.leaseSeconds / 60)}m) — state ${swarmDir(env)}`,
        `crew (${crew.length}/${cfg.maxWorkers}): ${crew.length === 0 ? "none deployed" : crew.map((a) => `${a.name}(${a.role}, ${a.status}${a.taskId ? `, ${a.taskId}` : ""})`).join(", ")}`,
        `board: ${tasks.length === 0 ? "empty" : tasks.map(boardLine).join(" | ")}`,
        `scopes held: ${claims.length === 0 ? "none — every target is open to whoever claims it first" : claims.map((c) => `${c.owner} → ${c.scope} (until ${c.expiresAt})`).join(", ")}`,
        `unread mail: ${agents.filter((a) => countUnread(a.name, env) > 0).map((a) => `${a.name} ${countUnread(a.name, env)}`).join(", ") || "none"}`,
        `sessions on the roster: ${agents.map((a) => a.name).join(", ") || "only you"}`,
      ];
      const open = tasks.filter((t) => t.status === "open");
      if (open.length > 0) lines.push(`hint: ${open.length} open task(s) — claim one yourself or spawn a worker for it (${open.map((t) => t.id).join(", ")})`);
      return { text: bullets(lines), details: { ok: true, action: "status", summary: `${crew.length} crew, ${tasks.length} tasks`, info: { crew: crew.length, tasks: tasks.length, claims: claims.length } } };
    }

    case "plan": {
      const specs = params.tasks ?? [];
      if (specs.length === 0) throw new SwarmError("plan needs tasks: [{ title, scope?, role?, detail? }]");
      const created: Task[] = [];
      for (const spec of specs) {
        created.push(
          addTask(
            {
              id: spec.id,
              title: spec.title,
              detail: spec.detail ?? "",
              role: spec.role ?? params.role ?? null,
              scope: spec.scope ?? null,
              by: me,
            },
            env,
          ),
        );
      }
      return {
        text: bullets([
          `put ${created.length} task(s) on the board:`,
          ...created.map((t) => boardLine(t)),
          'Deploy a worker for a task with action:"spawn", or claim it yourself with action:"task", op:"claim".',
        ]),
        details: { ok: true, action: "plan", summary: `${created.length} tasks added`, info: { ids: created.map((t) => t.id) } },
      };
    }

    case "spawn": {
      assertMayDeploy(me, "spawn", env);
      const role = params.role ?? cfg.defaultRole;
      const name = params.name?.trim() || nextId(role, env);
      const task = params.taskId ? getTask(params.taskId, env) : null;
      if (params.taskId && !task) throw new SwarmError(`no task ${params.taskId} on the board`);
      const result = spawnWorker(
        {
          name,
          role,
          cwd: params.cwd?.trim() || deps.cwd(),
          taskId: params.taskId ?? null,
          extra: params.extra,
        },
        env,
      );
      return {
        text: bullets([
          `deployed ${result.name} (${role}) in its own session — pid ${result.pid ?? "?"}, slot ${result.slot}.`,
          task ? `It is starting on task ${task.id}: ${task.title}` : "It will read the board and claim the most valuable open task.",
          `Its log: ${result.logPath}. It reports to you on the bus; its messages arrive in this session as [free-pi-swarm] lines.`,
          `Role brief: ${roleBrief(role).split("\n")[0] ?? role}. Your own session still runs one completion at a time — the parallelism is these separate sessions.`,
        ]),
        details: { ok: true, action: "spawn", summary: `${result.name} deployed`, info: { ...result } },
      };
    }

    case "stop": {
      if (params.all) {
        const names = listAgents(env)
          .filter((a) => a.source === "deployed" && a.status !== "exited")
          .map((a) => a.name);
        for (const n of names) stopWorker(n, "stopped by the coordinator", env);
        return {
          text: names.length === 0 ? "no workers were running." : `asked ${names.length} worker(s) to stop: ${names.join(", ")}. Their scopes and tasks go back on the board as they exit.`,
          details: { ok: true, action: "stop", summary: `stopping ${names.length}`, info: { names } },
        };
      }
      if (!params.name) throw new SwarmError("stop needs a name, or all:true");
      stopWorker(assertName("agent name", params.name), "stopped by the coordinator", env);
      return {
        text: `${params.name} was asked to stop (graceful: it finishes the current turn boundary and releases its scope claims and tasks).`,
        details: { ok: true, action: "stop", summary: `stopping ${params.name}` },
      };
    }

    case "task": {
      const op = params.op ?? "list";
      if (op === "list") {
        const tasks = listTasks(env);
        return {
          text: tasks.length === 0 ? "the board is empty." : bullets(tasks.map(boardLine)),
          details: { ok: true, action: "task", summary: `${tasks.length} tasks`, info: { tasks: tasks.length } },
        };
      }
      if (op === "add") {
        if (!params.title) throw new SwarmError("task add needs a title");
        const task = addTask(
          {
            id: params.id,
            title: params.title,
            detail: params.detail ?? "",
            role: params.role ?? null,
            scope: params.scope ?? null,
            by: me,
          },
          env,
        );
        return { text: `added ${boardLine(task)}`, details: { ok: true, action: "task", summary: `added ${task.id}`, info: { id: task.id } } };
      }
      if (!params.id) throw new SwarmError(`task ${op} needs an id`);
      if (op === "claim") {
        const task = claimTask(params.id, me, cfg.leaseSeconds, false, env);
        return {
          text: `you own ${task.id} until ${task.leaseUntil}. ${task.scope ? `The scope ${task.scope} is yours: claim it too so nobody else touches it.` : ""}`,
          details: { ok: true, action: "task", summary: `claimed ${task.id}`, info: { id: task.id } },
        };
      }
      if (op === "reopen") {
        const task = getTask(params.id, env);
        if (!task) throw new SwarmError(`no task ${params.id}`);
        putTask({ ...task, status: "open", owner: null, leaseUntil: null, history: [...task.history, { ts: nowIso(), by: me, what: "reopened" }] }, env);
        return { text: `${params.id} is open again`, details: { ok: true, action: "task", summary: `reopened ${params.id}` } };
      }
      const status = op === "done" ? "done" : op === "fail" ? "failed" : "blocked";
      const task = finishTask(params.id, me, status, { evidence: params.evidence, result: params.result }, env);
      return {
        text:
          status === "done"
            ? `${task.id} is done${task.evidence ? ` — evidence recorded` : " (no evidence recorded: add it with task done --evidence)"}.`
            : `${task.id} is ${task.status}${task.result ? `: ${task.result}` : ""}. ${status === "blocked" ? "A human decision is needed; the task stays on the board." : ""}`,
        details: { ok: true, action: "task", summary: `${task.id} ${task.status}`, info: { id: task.id, status: task.status } },
      };
    }

    case "claim": {
      if (!params.scope) throw new SwarmError("claim needs a scope (a host, URL, repo or path)");
      const ttl = Number.isFinite(params.ttlMinutes) && (params.ttlMinutes as number) > 0 ? (params.ttlMinutes as number) : Math.round(cfg.leaseSeconds / 60);
      const claim = claimScope({ scope: params.scope, owner: me, leaseSeconds: ttl * 60, taskId: params.taskId ?? params.id ?? null }, env);
      return {
        text: `you hold '${claim.scope}' until ${claim.expiresAt} (key ${scopeKey(claim.scope)}). Nobody else in the swarm will work it. Release it when you are done so it goes back to the pool.`,
        details: { ok: true, action: "claim", summary: `claimed ${claim.scope}`, info: { ...claim } },
      };
    }

    case "release": {
      if (!params.scope) throw new SwarmError("release needs a scope");
      const released = releaseScope(params.scope, me, false, env);
      return {
        text: released ? `released '${params.scope}' — it is back on the board for anyone.` : `nothing was holding '${params.scope}'.`,
        details: { ok: true, action: "release", summary: released ? `released ${params.scope}` : "nothing to release" },
      };
    }

    case "send": {
      const body = params.body?.trim();
      if (!body) throw new SwarmError("send needs a body");
      const kind = mailKind(params.kind);
      if (params.all) {
        const others = listAgents(env).filter((a) => a.name !== me && a.status !== "exited").map((a) => a.name);
        if (others.length === 0) return { text: "nobody else is on the roster yet.", details: { ok: true, action: "send", summary: "no recipients" } };
        const sent = others.map((to) => sendMail({ from: me, to, body, kind, subject: params.subject, taskId: params.taskId ?? params.id ?? null }, env));
        return {
          text: `told ${others.length} teammate(s): ${others.join(", ")}`,
          details: { ok: true, action: "send", summary: `broadcast to ${others.length}`, info: { ids: sent.map((m) => m.id) } },
        };
      }
      const to = params.to?.trim();
      if (!to) throw new SwarmError("send needs a recipient (to, or all:true)");
      const mail = sendMail({ from: me, to, body, kind, subject: params.subject, taskId: params.taskId ?? params.id ?? null }, env);
      const known = listAgents(env).some((a) => a.name === mail.to);
      return {
        text: `sent to ${mail.to}${known ? "" : " (not on the roster yet — it will be waiting in their inbox)"}${mail.kind === "question" ? " — a question needs an answer on the bus" : ""}.`,
        details: { ok: true, action: "send", summary: `sent to ${mail.to}`, info: { id: mail.id } },
      };
    }

    case "inbox": {
      const messages = drainMail(me, env);
      if (messages.length === 0) return { text: "no new messages.", details: { ok: true, action: "inbox", summary: "0 messages" } };
      return {
        text: bullets(
          messages.map((m) => `[${m.ts} from ${m.from}${m.kind !== "note" ? `, ${m.kind}` : ""}${m.subject ? `: ${m.subject}` : ""}${m.taskId ? ` (task ${m.taskId})` : ""}] ${m.body}`),
        ),
        details: { ok: true, action: "inbox", summary: `${messages.length} message(s)`, info: { from: messages.map((m) => m.from) } },
      };
    }

    case "report": {
      const body = params.body?.trim();
      if (!body) throw new SwarmError("report needs a body: what did you find, and how do we reproduce it?");
      const others = listAgents(env).filter((a) => a.name !== me && a.status !== "exited").map((a) => a.name);
      const text = params.scope ? `[${params.scope}] ${body}` : body;
      for (const to of others) {
        sendMail({ from: me, to, body: text, kind: "finding", subject: params.subject ?? "finding", taskId: params.taskId ?? params.id ?? null }, env);
      }
      return {
        text: `broadcast the finding to ${others.length} teammate(s)${others.length ? ` (${others.join(", ")})` : ""}. Claim the scope if you have not already, record it with a task, and expect a verifier to reproduce it before it is written up.`,
        details: { ok: true, action: "report", summary: `finding broadcast to ${others.length}` },
      };
    }

    default: {
      const exhaustive: never = params.action;
      throw new SwarmError(`unknown action ${String(exhaustive)}`);
    }
  }
}

/**
 * The tool definition. A pure object (no pi API needed) so the whole handler is
 * unit-testable; the extension registers it.
 */
export function createSwarmTool(deps: SwarmToolDeps) {
  return {
    name: SWARM_TOOL_NAME,
    label: "Swarm",
    description: [
      "Run a bug-bounty crew: coordinate several free-pi sessions working one target, and deploy a worker when a job is independent enough to deserve its own session.",
      "Actions: status, enable, disable, plan, spawn, stop, task (add/list/claim/done/fail/block/reopen), claim, release, send, inbox, report.",
      "Each spawned worker is a SEPARATE free-pi session in its own process with its own free allowance — so deploy deliberately, not speculatively, and check status first.",
      "Scopes (a host, URL path prefix, repo+dir or binary) are claimed exclusively so two sessions never test the same target; the board shows who is doing what.",
    ].join(" "),
    promptSnippet: "Coordinate a swarm of free-pi sessions on a bug-bounty target (board, scope claims, deploy/stop workers, messages)",
    promptGuidelines: [
      "Use free_pi_swarm to coordinate a bug-bounty effort: put scopes on the board, claim the one you work, and deploy a worker only when a task is independent enough to deserve its own session.",
      "Never deploy a worker without a task on the board, and never work a scope another session holds — check free_pi_swarm status first.",
      "Every deployed worker is a separate free-pi session spending its own allowance; prefer doing the work yourself over deploying a crew.",
      "Findings belong on the bus (free_pi_swarm report) as they are found, and a finding is verified by a different session before it is written up.",
    ],
    parameters: PARAMS,
    async execute(_toolCallId: string, params: SwarmToolParams, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: ExtensionContext) {
      const { text, details } = await runSwarmAction(params, deps);
      return { content: [{ type: "text" as const, text }], details };
    },
  };
}
