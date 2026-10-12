#!/usr/bin/env bun
/**
 * freepi-panel — a phone-friendly web panel for the freepi agent on this box.
 *
 * freepi normally only exists inside an SSH terminal. This serves a small
 * authenticated UI that can
 *
 *   1. watch every session on this machine live, including one a terminal is
 *      writing right now (sessions are append-only JSONL, so tailing them is
 *      safe and shows exactly what the agent is doing),
 *   2. drive a session for real — prompt, steer, abort, switch model, compact —
 *      by launching `freepi --mode rpc` (the protocol documented in the SDK's
 *      docs/rpc.md) and bridging its JSONL commands/events to the browser
 *      over SSE, and
 *   3. show the Antseed balance and whether the idle-guard currently holds the
 *      box awake, so the meter and the work are visible on the same screen.
 *
 * Two writers, one session file: the RPC bridge is a separate process from a
 * terminal's TUI, so driving a session a terminal is actively writing can
 * interleave. Watching is always safe; the UI warns before driving a live one.
 * See README.md.
 *
 * Security: every /api route requires the shared token from PANEL_TOKEN_FILE
 * (constant-time compare). Login sets an HttpOnly SameSite=Lax cookie holding an
 * HMAC of that token; mutations also require a same-origin Origin header. The
 * server binds loopback and is meant to sit behind the TLS-terminating proxy.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const env = process.env;
const PORT = Number(env.PANEL_PORT ?? 8787);
const HOST = env.PANEL_HOST ?? "127.0.0.1";
const TOKEN_FILE = env.PANEL_TOKEN_FILE ?? "/etc/freepi-panel/token";
const SESSION_ROOT = env.PANEL_SESSION_ROOT ?? join(homedir(), ".free-pi", "agent", "sessions");
const IDLE_GUARD = env.PANEL_IDLE_GUARD ?? "/usr/local/bin/idle-guard.sh";
const ANTSEED = env.PANEL_ANTSEED ?? "antseed";
const PUBLIC_DIR = env.PANEL_PUBLIC_DIR ?? join(import.meta.dir, "public");
/** How to start freepi. Overridable because the install layout differs per box. */
const FREEPI_CMD = (env.PANEL_FREEPI_CMD ?? "bun run /root/workspace/freepi-plus/free-pi-cli/src/index.ts")
  .split(/\s+/)
  .filter(Boolean);
/** Comma-separated directories offered for "new session". */
const PROJECTS = (env.PANEL_PROJECTS ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const BALANCE_TTL_MS = Number(env.PANEL_BALANCE_TTL_MS ?? 60_000);
const LIVE_WINDOW_MS = 20_000;

function readToken(): string {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

let TOKEN = readToken();
if (!TOKEN) {
  console.error(
    `freepi-panel: no token at ${TOKEN_FILE}. Create one first (install.sh does this):\n` +
      `  install -d -m 700 /etc/freepi-panel && head -c 32 /dev/urandom | base64 > /etc/freepi-panel/token`,
  );
  process.exit(1);
}
const COOKIE_NAME = "fp_panel";
const cookieValue = createHmac("sha256", TOKEN).update("freepi-panel:v1").digest("hex");

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const fail = (status: number, message: string) => json({ error: message }, status);

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_MAX = 8;
const LOGIN_WINDOW_MS = 5 * 60_000;

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function isAuthed(req: Request): boolean {
  const token = parseCookies(req.headers.get("cookie"))[COOKIE_NAME];
  return typeof token === "string" && token.length > 0 && constantTimeEqual(token, cookieValue);
}

/**
 * Mutations must come from our own page. The cookie is SameSite=Lax so a
 * cross-site POST would not carry it anyway; this is the belt to that braces and
 * also stops a DNS-rebound name from driving the panel.
 */
function sameOrigin(req: Request): boolean {
  // A cross-site request always says so in modern browsers, and SameSite=Lax
  // keeps the cookie off it either way.
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.headers.get("origin");
  // No Origin at all means a non-browser client (curl, a script) that still has
  // to present the cookie; a mismatching Origin is the CSRF case we reject.
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get("host") ?? "");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// session files: append-only JSONL, read incrementally
// ---------------------------------------------------------------------------
interface Entry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    toolCallId?: string;
    provider?: string;
    model?: string;
    stopReason?: string;
    isError?: boolean;
    usage?: unknown;
  };
  [k: string]: unknown;
}

interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp?: string;
  cwd?: string;
}

interface SessionCache {
  header: SessionHeader | null;
  entries: Entry[];
  offset: number; // bytes of the file already consumed into entries
  carry: Buffer; // trailing partial line (may end mid-UTF-8)
  touched: number;
  byId: Map<string, Entry>;
}

const MAX_ENTRIES_PER_SESSION = 4000;
const caches = new Map<string, SessionCache>();

function cacheFor(path: string): SessionCache {
  let c = caches.get(path);
  if (!c) {
    c = { header: null, entries: [], offset: 0, carry: Buffer.alloc(0), touched: 0, byId: new Map() };
    caches.set(path, c);
  }
  return c;
}

/** Pull bytes appended since the last call into parsed entries. */
async function refresh(path: string): Promise<SessionCache> {
  const c = cacheFor(path);
  c.touched = Date.now();
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return c;
  }
  if (size < c.offset) {
    // truncated or replaced: never read from a stale offset
    c.entries = [];
    c.offset = 0;
    c.carry = Buffer.alloc(0);
    c.byId.clear();
    c.header = null;
  }
  if (size === c.offset) return c;

  const len = size - c.offset;
  const buf = Buffer.allocUnsafe(len);
  const fh = await open(path, "r");
  try {
    await fh.read(buf, 0, len, c.offset);
  } finally {
    await fh.close();
  }
  const all = c.carry.length ? Buffer.concat([c.carry, buf]) : buf;
  c.offset = c.offset + len;

  const lastNewline = all.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    c.carry = Buffer.from(all);
    return c;
  }
  const complete = all.subarray(0, lastNewline).toString("utf8");
  c.carry = Buffer.from(all.subarray(lastNewline + 1)); // copy: `all` may alias a large pool

  for (const line of complete.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Entry;
    try {
      parsed = JSON.parse(trimmed) as Entry;
    } catch {
      continue; // a session file is a log; one bad line must not break the view
    }
    if (parsed.type === "session" && !c.header) {
      c.header = parsed as SessionHeader;
      continue;
    }
    c.entries.push(parsed);
    if (parsed.id) {
      c.byId.set(parsed.id, parsed);
      if (c.byId.size > MAX_ENTRIES_PER_SESSION * 2) {
        for (const k of [...c.byId.keys()].slice(0, MAX_ENTRIES_PER_SESSION)) c.byId.delete(k);
      }
    }
  }
  if (c.entries.length > MAX_ENTRIES_PER_SESSION) c.entries = c.entries.slice(-MAX_ENTRIES_PER_SESSION);
  return c;
}

async function findSessionFiles(): Promise<string[]> {
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(SESSION_ROOT);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(join(SESSION_ROOT, dir));
    } catch {
      continue;
    }
    for (const name of names) if (name.endsWith(".jsonl")) out.push(join(SESSION_ROOT, dir, name));
  }
  return out;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        const block = b as { text?: unknown };
        return typeof block?.text === "string" ? block.text : "";
      })
      .join("")
      .trim();
  }
  return "";
}

/** Cheap metadata for the session list: header + first user message + last model. */
async function summarise(path: string): Promise<Record<string, unknown>> {
  const st = await stat(path);
  const fh = await open(path, "r");
  let head = "";
  let tail = "";
  try {
    const headLen = Math.min(st.size, 16 * 1024);
    const hb = Buffer.allocUnsafe(headLen);
    await fh.read(hb, 0, headLen, 0);
    head = hb.toString("utf8");
    const tailLen = Math.min(st.size, 96 * 1024);
    const tb = Buffer.allocUnsafe(tailLen);
    await fh.read(tb, 0, tailLen, st.size - tailLen);
    tail = tb.toString("utf8");
  } finally {
    await fh.close();
  }

  let header: SessionHeader | null = null;
  let title = "";
  let count = 0;
  for (const line of head.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: Entry;
    try {
      e = JSON.parse(t) as Entry;
    } catch {
      continue; // the head ends mid-line
    }
    if (e.type === "session" && !header) {
      header = e as SessionHeader;
      continue;
    }
    count++;
    if (!title && e.message?.role === "user") title = textOfContent(e.message.content).slice(0, 200);
  }

  let model = "";
  let provider = "";
  let lastActivity = header?.timestamp ?? "";
  let lastText = "";
  let lastError: string | undefined;
  for (const line of tail.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: Entry;
    try {
      e = JSON.parse(t) as Entry;
    } catch {
      continue; // the tail starts mid-line
    }
    if (e.timestamp) lastActivity = e.timestamp;
    const change = e as unknown as { model?: string; provider?: string };
    if (e.type === "model_change") {
      if (change.model) model = change.model;
      if (change.provider) provider = change.provider;
    }
    if (e.message?.role === "assistant") {
      if (e.message.model) model = e.message.model;
      if (e.message.provider) provider = e.message.provider;
      const text = textOfContent(e.message.content);
      if (text) lastText = text.slice(-400);
      lastError = e.message.stopReason === "error" ? `${e.message.provider ?? "provider"} returned an error` : undefined;
    }
  }

  const file = basename(path);
  const id = header?.id ?? /_([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1] ?? file.replace(/\.jsonl$/, "");
  return {
    id,
    path,
    slug: basename(dirname(path)),
    cwd: header?.cwd ?? "",
    title: title || "(no prompt yet)",
    model,
    provider,
    startedAt: header?.timestamp ?? "",
    lastActivity,
    messageCount: count,
    size: st.size,
    live: Date.now() - st.mtimeMs < LIVE_WINDOW_MS,
    error: lastError,
    tail: lastText,
  };
}

function safeReaddirSync(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function resolveSessionPath(id: string): string | null {
  for (const path of caches.keys()) {
    if (basename(path).includes(id)) return path;
  }
  for (const dir of safeReaddirSync(SESSION_ROOT)) {
    for (const name of safeReaddirSync(join(SESSION_ROOT, dir))) {
      if (name.endsWith(".jsonl") && name.includes(id)) return join(SESSION_ROOT, dir, name);
    }
  }
  return null;
}

function inferCwdFromSlug(dir: string): string {
  const inner = basename(dir).replace(/^--/, "").replace(/--$/, "");
  return `/${inner.replace(/-/g, "/")}`;
}

/** Trim a stored entry for transport; full text stays available via /entry. */
function compactEntry(entry: Entry, maxChars = 6000): Entry {
  const msg = entry.message;
  if (!msg || !Array.isArray(msg.content)) return entry;
  const content = msg.content.map((block) => {
    const b = block as { text?: unknown; thinking?: unknown };
    if (typeof b?.text === "string" && b.text.length > maxChars) {
      return { ...b, text: b.text.slice(0, maxChars), truncated: true, fullLength: b.text.length };
    }
    if (typeof b?.thinking === "string" && b.thinking.length > maxChars) {
      return { ...b, thinking: b.thinking.slice(0, maxChars), truncated: true };
    }
    return block;
  });
  return { ...entry, message: { ...msg, content } };
}

// ---------------------------------------------------------------------------
// RPC agents: `freepi --mode rpc` children bridged to the browser
// ---------------------------------------------------------------------------
type Emit = (event: Record<string, unknown>) => void;

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Agent {
  id: string;
  cwd: string;
  sessionPath?: string;
  proc: ReturnType<typeof spawn>;
  seq: number;
  pending: Map<string, Pending>;
  subscribers: Set<Emit>;
  log: string[];
  state: Record<string, unknown> | null;
  exited: boolean;
  exitInfo?: string;
  streaming: boolean;
  dialogs: Map<string, Record<string, unknown>>;
  startedAt: number;
}

const agents = new Map<string, Agent>();

function broadcast(agent: Agent, event: Record<string, unknown>) {
  for (const sub of agent.subscribers) sub(event);
}

function startAgent(opts: { cwd: string; sessionId?: string; newSession?: boolean }): Agent {
  const existing = [...agents.values()].find((a) => {
    if (a.exited || a.cwd !== opts.cwd) return false;
    if (opts.sessionId) return (a.sessionPath ?? "").includes(opts.sessionId);
    // A plain "start" (or a new session) reuses whatever agent already has this
    // project open: one process per cwd keeps session-file writers minimal.
    return true;
  });
  if (existing && !opts.newSession) return existing;

  const args = [...FREEPI_CMD.slice(1), "--mode", "rpc", ...(opts.sessionId ? ["--session", opts.sessionId] : [])];
  const proc = spawn(FREEPI_CMD[0] as string, args, {
    cwd: opts.cwd,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const agent: Agent = {
    id: randomBytes(6).toString("hex"),
    cwd: opts.cwd,
    proc,
    seq: 0,
    pending: new Map(),
    subscribers: new Set(),
    log: [],
    state: null,
    exited: false,
    streaming: false,
    dialogs: new Map(),
    startedAt: Date.now(),
  };
  agents.set(agent.id, agent);

  // stdout is the protocol: split on LF only, tolerate a stray CR, ignore junk.
  let carry = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    carry += chunk.toString("utf8");
    let idx: number;
    while ((idx = carry.indexOf("\n")) !== -1) {
      let line = carry.slice(0, idx);
      carry = carry.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      handleAgentLine(agent, evt);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    agent.log.push(text);
    if (agent.log.length > 400) agent.log.shift();
    broadcast(agent, { type: "panel_log", text });
  });
  proc.on("exit", (code, signal) => {
    agent.exited = true;
    agent.exitInfo = `exited (code ${code}${signal ? `, signal ${signal}` : ""})`;
    for (const [, p] of agent.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(agent.exitInfo));
    }
    agent.pending.clear();
    broadcast(agent, { type: "panel_exit", info: agent.exitInfo });
  });
  proc.on("error", (err) => {
    agent.exited = true;
    agent.exitInfo = `failed to start: ${err.message}`;
    broadcast(agent, { type: "panel_exit", info: agent.exitInfo });
  });

  return agent;
}

function handleAgentLine(agent: Agent, evt: Record<string, unknown>) {
  const type = evt.type as string | undefined;
  if (type === "response") {
    const id = evt.id as string | undefined;
    if (id && agent.pending.has(id)) {
      const p = agent.pending.get(id) as Pending;
      agent.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(evt);
    }
    if (evt.command === "get_state" && evt.data) agent.state = evt.data as Record<string, unknown>;
    if ((evt.command === "cycle_model" || evt.command === "set_model") && evt.data && (evt.data as { model?: unknown }).model) {
      agent.state = { ...(agent.state ?? {}), model: (evt.data as { model: unknown }).model };
    }
    if (evt.command === "prompt" && evt.success === true) agent.streaming = true;
    if (evt.command === "abort") agent.streaming = false;
    broadcast(agent, evt);
    return;
  }
  if (type === "extension_ui_request") {
    const method = evt.method as string;
    if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
      agent.dialogs.set(evt.id as string, evt);
    }
    broadcast(agent, evt);
    return;
  }
  if (type === "turn_start" || type === "agent_start") agent.streaming = true;
  if (type === "turn_end" || type === "agent_settled") agent.streaming = false;
  broadcast(agent, evt);
}

function sendCommand(agent: Agent, command: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  if (agent.exited) return Promise.reject(new Error(agent.exitInfo ?? "agent exited"));
  const id = `p${++agent.seq}`;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      agent.pending.delete(id);
      reject(new Error(`no response to ${String(command.type)} within ${timeoutMs}ms`));
    }, timeoutMs);
    agent.pending.set(id, { resolve: resolvePromise, reject, timer });
    const sink = agent.proc.stdin as unknown as { write: (s: string) => void; flush?: unknown } | null;
    try {
      sink?.write(`${JSON.stringify({ ...command, id })}\n`);
      // Bun's FileSink has flush(); a Node-style socket may expose a `flush`
      // property that is not callable, so check before invoking it.
      if (typeof sink?.flush === "function") (sink.flush as () => void)();
    } catch (err) {
      clearTimeout(timer);
      agent.pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function stopAgent(agent: Agent, why = "stopped by panel") {
  try {
    agent.proc.stdin?.end();
  } catch {
    // already closed
  }
  const killTimer = setTimeout(() => {
    if (!agent.exited) {
      try {
        agent.proc.kill("SIGTERM");
      } catch {
        // gone
      }
    }
  }, 1500);
  killTimer.unref?.();
  broadcast(agent, { type: "panel_exit", info: why });
  agents.delete(agent.id);
}

function agentForSession(path: string): Agent | undefined {
  return [...agents.values()].find((a) => a.sessionPath === path);
}

// ---------------------------------------------------------------------------
// box state: antseed balance + idle-guard
// ---------------------------------------------------------------------------
let balanceCache: { at: number; value: Record<string, unknown> } | null = null;
let hostCache: { at: number; value: string } | null = null;

function runOnce(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolvePromise) => {
    let out = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolvePromise(out);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return finish();
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // gone
      }
      finish();
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    child.on("exit", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function hostname(): Promise<string> {
  if (hostCache && Date.now() - hostCache.at < 5 * 60_000) return hostCache.value;
  const value = (await runOnce("hostname", [], 3000)).trim() || "this box";
  hostCache = { at: Date.now(), value };
  return value;
}

async function antseedBalance(force = false): Promise<Record<string, unknown>> {
  if (!force && balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.value;
  const raw = await runOnce(ANTSEED, ["buyer", "activity", "--json"], 15_000);
  let value: Record<string, unknown> = { ok: false, error: "no output from `antseed buyer activity --json`" };
  const start = raw.indexOf("{");
  if (start !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(start)) as Record<string, any>;
      const deposits = (parsed.deposits ?? {}) as Record<string, unknown>;
      const totals = (parsed.totals ?? {}) as Record<string, unknown>;
      const usage = (parsed.usage ?? {}) as Record<string, unknown>;
      // Base units are 6-decimal USDC, and the CLI serializes the big integers
      // as JSON *strings* ("1449688"), so accept both shapes.
      const num = (n: unknown): number | null => {
        const v = typeof n === "number" ? n : typeof n === "string" && n.trim() !== "" ? Number(n) : NaN;
        return Number.isFinite(v) ? v : null;
      };
      const usd = (n: unknown): number | null => {
        const v = num(n);
        return v === null ? null : v / 1e6;
      };
      value = {
        ok: true,
        availableUsd: usd(deposits.available),
        reservedUsd: usd(deposits.reserved ?? deposits.locked),
        spentUsd: usd(totals.spentUsdcBaseUnits),
        requests: num(usage.totalRequests ?? totals.requests),
        tokens: num(totals.tokens),
        savedUsd: (parsed.savings ?? {}).actualUsd ?? null,
      };
    } catch (err) {
      value = { ok: false, error: `could not parse antseed output: ${(err as Error).message}` };
    }
  }
  balanceCache = { at: Date.now(), value };
  return value;
}

async function boxState(): Promise<Record<string, unknown>> {
  if (!existsSync(IDLE_GUARD)) return { available: false };
  const out = await runOnce(IDLE_GUARD, ["--status"], 15_000);
  const line = (prefix: string) =>
    out
      .split("\n")
      .find((l) => l.startsWith(prefix))
      ?.slice(prefix.length)
      .trim() ?? "";
  return {
    available: true,
    state: line("state:"),
    held: line("keepalive:") === "present",
    actions: line("actions:"),
    raw: out.trim(),
  };
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
function sse(handler: (emit: Emit, onClose: (fn: () => void) => void) => void): Response {
  let close: () => void = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const disposers: Array<() => void> = [];
      const emit: Emit = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => emit({ type: "panel_heartbeat", at: Date.now() }), 15_000);
      close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        for (const d of disposers) {
          try {
            d();
          } catch {
            // best effort
          }
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      handler(emit, (fn) => disposers.push(fn));
      emit({ type: "panel_ready" });
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const ip = req.headers.get("cf-connecting-ip") ?? (req.headers.get("x-forwarded-for") ?? "local").split(",")[0]!.trim();
  const secure = (req.headers.get("x-forwarded-proto") ?? "").includes("https");

  // ---- unauthenticated: the app shell, health, login ----
  if (path === "/" || path === "/index.html") {
    try {
      const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    } catch {
      return new Response("panel UI missing", { status: 500 });
    }
  }
  if (path === "/healthz") return json({ ok: true, sessions: caches.size, agents: agents.size });
  // Browsers always ask; answering keeps the log clean instead of 404-ing.
  if (path === "/favicon.ico") return new Response(null, { status: 204, headers: { "cache-control": "max-age=86400" } });

  if (path === "/api/login" && req.method === "POST") {
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.count >= LOGIN_MAX && Date.now() < attempt.resetAt) {
      return fail(429, "too many attempts — wait a few minutes");
    }
    let body: { token?: string } = {};
    try {
      body = (await req.json()) as { token?: string };
    } catch {
      return fail(400, "expected JSON { token }");
    }
    TOKEN = readToken() || TOKEN; // the file may have rotated since boot
    if (!body.token || !constantTimeEqual(body.token.trim(), TOKEN)) {
      const entry = attempt && Date.now() < attempt.resetAt ? attempt : { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
      loginAttempts.set(ip, { count: entry.count + 1, resetAt: entry.resetAt });
      return fail(401, `that token does not match ${TOKEN_FILE}`);
    }
    loginAttempts.delete(ip);
    return json(
      { ok: true },
      200,
      { "set-cookie": `${COOKIE_NAME}=${cookieValue}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}` },
    );
  }

  // ---- everything below needs the cookie ----
  if (!isAuthed(req)) return fail(401, "not signed in");
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
    return fail(403, "cross-origin request refused");
  }

  if (path === "/api/logout" && req.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0` });
  }

  if (path === "/api/status") {
    const [balance, box, host, files] = await Promise.all([
      antseedBalance(url.searchParams.has("refresh")),
      boxState(),
      hostname(),
      findSessionFiles(),
    ]);
    return json({
      host,
      balance,
      box,
      sessionCount: files.length,
      freepiCmd: FREEPI_CMD.join(" "),
      projects: PROJECTS,
      agents: [...agents.values()].map(publicAgent),
    });
  }

  if (path === "/api/sessions") {
    const files = await findSessionFiles();
    const rows = await Promise.all(
      files.map(async (f) => {
        try {
          const row = await summarise(f);
          const agent = agentForSession(f);
          return { ...row, agentId: agent?.id ?? null, attached: Boolean(agent) };
        } catch (err) {
          return { path: f, id: basename(f).replace(/\.jsonl$/, ""), error: (err as Error).message };
        }
      }),
    );
    rows.sort((a, b) => String((b as { lastActivity?: string }).lastActivity ?? "").localeCompare(String((a as { lastActivity?: string }).lastActivity ?? "")));
    return json({ sessions: rows, projects: PROJECTS });
  }

  const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(entries|stream|entry))?$/.exec(path);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1] as string);
    const sub = sessionMatch[2] ?? "entries";
    const file = resolveSessionPath(id);
    if (!file) return fail(404, `no session matching ${id}`);

    if (sub === "entries") {
      const cache = await refresh(file);
      const since = url.searchParams.get("since");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 250), 1000);
      let entries = cache.entries;
      if (since) {
        const idx = entries.findIndex((e) => e.id === since);
        entries = idx === -1 ? entries.slice(-limit) : entries.slice(idx + 1);
      } else {
        entries = entries.slice(-limit);
      }
      return json({
        id,
        path: file,
        header: cache.header,
        entries: entries.map((e) => compactEntry(e)),
        cursor: entries.length > 0 ? (entries[entries.length - 1]?.id ?? since) : since,
        total: cache.entries.length,
        agentId: agentForSession(file)?.id ?? null,
      });
    }

    if (sub === "entry") {
      const entryId = url.searchParams.get("entryId") ?? "";
      const cache = await refresh(file);
      const entry = cache.byId.get(entryId);
      return entry ? json({ entry }) : fail(404, "no such entry");
    }

    // live tail: safe against a TUI writing the same file (read-only)
    return sse((emit, onClose) => {
      const since = url.searchParams.get("since");
      const seen = new Set<string>();
      let stopped = false;
      onClose(() => {
        stopped = true;
        clearInterval(timer);
      });
      const push = (cache: SessionCache, fromCursor: boolean) => {
        let fresh = cache.entries.filter((e) => e.id && !seen.has(e.id as string));
        if (fromCursor && since) {
          const idx = fresh.findIndex((e) => e.id === since);
          fresh = idx === -1 ? fresh.slice(-50) : fresh.slice(idx + 1);
        }
        for (const e of fresh) {
          if (e.id) seen.add(e.id);
          if (!fromCursor) continue; // first pass: no history dump, the UI fetched it
          emit({ type: "entry", sessionId: id, entry: compactEntry(e) });
        }
        if (since) {
          const idx = cache.entries.findIndex((e) => e.id === since);
          if (idx !== -1) for (const e of cache.entries.slice(0, idx + 1)) if (e.id) seen.add(e.id);
        }
      };
      const timer = setInterval(async () => {
        if (stopped) return;
        try {
          push(await refresh(file), true);
        } catch {
          // file may be mid-write; next tick retries
        }
      }, 700);
      (async () => {
        try {
          push(await refresh(file), true);
        } catch {
          // ignore
        }
      })();
    });
  }

  if (path === "/api/agents" && req.method === "GET") {
    return json({ agents: [...agents.values()].map(publicAgent) });
  }

  if (path === "/api/agents/start" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { sessionId?: string; cwd?: string; newSession?: boolean };
    let cwd = body.cwd ?? "";
    let sessionId = body.sessionId;
    if (sessionId && !cwd) {
      const file = resolveSessionPath(sessionId);
      if (!file) return fail(404, `no session matching ${sessionId}`);
      const cache = await refresh(file);
      cwd = cache.header?.cwd ?? inferCwdFromSlug(dirname(file));
      sessionId = cache.header?.id ?? sessionId;
    }
    if (!cwd && !body.newSession) return fail(400, "need sessionId or cwd");
    if (cwd && !existsSync(cwd)) return fail(400, `cwd does not exist: ${cwd}`);

    let agent: Agent;
    try {
      agent = startAgent({ cwd: cwd || process.cwd(), sessionId, newSession: body.newSession });
    } catch (err) {
      return fail(500, `could not start freepi: ${(err as Error).message}`);
    }
    if (body.newSession) {
      const res = await sendCommand(agent, { type: "new_session" }).catch((err: Error) => ({ error: err.message }));
      if ((res as { error?: string }).error) return fail(502, (res as { error: string }).error);
    }
    await syncState(agent, sessionId);
    return json({ agent: publicAgent(agent) });
  }

  const agentMatch = /^\/api\/agents\/([^/]+)\/(stream|command|ui|log|halt)$/.exec(path);
  if (agentMatch) {
    const agent = agents.get(agentMatch[1] as string);
    if (!agent) return fail(404, "no such agent (it may have exited) — start one for this session");
    const action = agentMatch[2] as string;

    if (action === "log") return json({ log: agent.log.join(""), exited: agent.exited, exitInfo: agent.exitInfo ?? null });

    if (action === "halt" && req.method === "POST") {
      stopAgent(agent);
      return json({ ok: true });
    }

    if (action === "command" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { command?: Record<string, unknown>; timeoutMs?: number };
      if (!body.command || typeof body.command.type !== "string") return fail(400, "need { command: { type, ... } }");
      if (body.command.type === "switch_session" && typeof body.command.sessionPath === "string") {
        if (!existsSync(body.command.sessionPath)) return fail(400, "sessionPath does not exist");
      }
      // A prompt while streaming must declare how it should be queued.
      if (body.command.type === "prompt" && agent.streaming && !body.command.streamingBehavior) {
        body.command.streamingBehavior = "steer";
      }
      try {
        const res = await sendCommand(agent, body.command, body.timeoutMs ?? 120_000);
        if (body.command.type === "switch_session" || body.command.type === "new_session") await syncState(agent);
        return json({ response: res, agent: publicAgent(agent) });
      } catch (err) {
        return fail(504, (err as Error).message);
      }
    }

    if (action === "ui" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { id?: string; value?: unknown; confirmed?: boolean; cancelled?: boolean };
      if (!body.id) return fail(400, "need { id }");
      agent.dialogs.delete(body.id);
      const payload =
        body.cancelled === true
          ? { type: "extension_ui_response", id: body.id, cancelled: true }
          : typeof body.confirmed === "boolean"
            ? { type: "extension_ui_response", id: body.id, confirmed: body.confirmed }
            : { type: "extension_ui_response", id: body.id, value: body.value };
      agent.proc.stdin?.write(`${JSON.stringify(payload)}\n`);
      broadcast(agent, { type: "panel_dialog_answered", id: body.id });
      return json({ ok: true });
    }

    // event stream for this agent: token deltas, tool progress, dialogs
    return sse((emit, onClose) => {
      agent.subscribers.add(emit);
      onClose(() => agent.subscribers.delete(emit));
      emit({
        type: "panel_state",
        agent: publicAgent(agent),
        state: agent.state,
        streaming: agent.streaming,
        exited: agent.exited,
      });
      emit({ type: "panel_log", text: agent.log.slice(-6).join("") });
      for (const dialog of agent.dialogs.values()) emit(dialog);
    });
  }

  // Convenience: relay a command by session id, starting an agent if needed.
  if (path === "/api/command" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { key?: string; command?: Record<string, unknown>; autoStart?: boolean };
    if (!body.key || !body.command) return fail(400, "need { key, command }");
    let agent = [...agents.values()].find((a) => a.id === body.key || (a.sessionPath ?? "").includes(body.key as string));
    if (!agent && body.autoStart) {
      const file = resolveSessionPath(body.key);
      if (!file) return fail(404, `no session matching ${body.key}`);
      const cache = await refresh(file);
      agent = startAgent({ cwd: cache.header?.cwd ?? inferCwdFromSlug(dirname(file)), sessionId: cache.header?.id });
      await syncState(agent);
    }
    if (!agent) return fail(409, "no agent for that session yet — start one first");
    const res = await sendCommand(agent, body.command, 180_000).catch((err: Error) => ({ error: err.message }));
    return json({ response: res, agent: publicAgent(agent) });
  }

  if (path === "/api/box/hold" || path === "/api/box/release") {
    if (req.method !== "POST") return fail(405, "POST only");
    if (!existsSync(IDLE_GUARD)) return fail(501, "idle-guard is not installed on this box");
    const out = await runOnce(IDLE_GUARD, [path.endsWith("hold") ? "--hold" : "--release"], 10_000);
    return json({ ok: true, output: out.trim(), box: await boxState() });
  }

  if (path === "/api/bash" && req.method === "POST") {
    // Explicit, authenticated shell on the box — the same power the agent has.
    const body = (await req.json().catch(() => ({}))) as { command?: string };
    if (!body.command) return fail(400, "need { command }");
    const out = await runOnce("/bin/bash", ["-lc", body.command], 60_000);
    return json({ output: out });
  }

  return fail(404, `no route for ${path}`);
}

function publicAgent(agent: Agent) {
  return {
    id: agent.id,
    cwd: agent.cwd,
    sessionPath: agent.sessionPath ?? null,
    exited: agent.exited,
    exitInfo: agent.exitInfo ?? null,
    streaming: agent.streaming,
    state: agent.state,
    dialogs: [...agent.dialogs.values()],
    startedAt: agent.startedAt,
  };
}

async function syncState(agent: Agent, expectedSessionId?: string) {
  const res = await sendCommand(agent, { type: "get_state" }).catch((err: Error) => ({ error: err.message }));
  const data = (res as { data?: Record<string, unknown> }).data;
  if (data) {
    agent.state = data;
    if (typeof data.sessionFile === "string") agent.sessionPath = data.sessionFile;
  } else if ((res as { error?: string }).error) {
    agent.log.push(`get_state failed: ${(res as { error: string }).error}\n`);
  }
  void expectedSessionId;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      return await handle(req);
    } catch (err) {
      console.error(`panel error on ${url.pathname}:`, err);
      return fail(500, (err as Error).message);
    }
  },
});

console.log(
  `freepi-panel listening on http://${HOST}:${server.port}\n` +
    `  sessions:   ${SESSION_ROOT}\n` +
    `  token file: ${TOKEN_FILE}\n` +
    `  freepi cmd: ${FREEPI_CMD.join(" ")}`,
);

// Forget session caches and idle agents nobody is looking at.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [path, cache] of caches) if (now - cache.touched > 30 * 60_000) caches.delete(path);
  for (const agent of [...agents.values()]) {
    if (!agent.exited && agent.subscribers.size === 0 && now - agent.startedAt > 12 * 60 * 60_000) stopAgent(agent, "idle timeout");
  }
}, 5 * 60_000);
sweeper.unref?.();
