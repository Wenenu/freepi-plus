#!/usr/bin/env bash
# verify.sh — prove the swarm works, without deploying a real subagent.
#
# SWARM_FREEPI_CMD points at a stub that speaks just enough of the pi RPC
# protocol (docs/rpc.md) to stand in for `freepi --mode rpc`: it acknowledges
# commands, records every prompt it is given, and — when a message starts with
# `!swarm ` — actually runs the swarm CLI from inside "the agent", exactly like
# a real agent would from bash. No model, no network, no allowance is spent.
#
# Everything runs against a throwaway state dir in $TMPDIR; the real
# ~/.free-pi/swarm is never touched, and no systemd unit is required.
#
#   bash ops/agent-swarm/verify.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SWARM_TS="$HERE/swarm.ts"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarm-verify.XXXXXX")"
S="$WORK/state"
STUBDIR="$WORK/agent"
TOKEN="$WORK/token"
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
# Under Git Bash a POSIX path in an *argument* is converted for the native
# process, but one inside an environment variable or a JSON body is not — so
# everything that crosses those routes is converted explicitly. No-ops on Linux.
native() { cygpath -m "$1" 2>/dev/null || printf '%s' "$1"; }
WORK_N="$(native "$WORK")"
SWARM_TS_N="$(native "$SWARM_TS")"
BUN_N="$(native "$(command -v bun)")"
export SWARM_SELFTEST_DIR="$(native "$STUBDIR")"
mkdir -p "$S" "$STUBDIR"

pass=0; fail=0
ok()  { echo "  PASS  $*"; pass=$((pass+1)); }
bad() { echo "  FAIL  $*"; fail=$((fail+1)); }

# The swarm CLI, always against the throwaway state dir.
sw() { SWARM_STATE_DIR="$S" bun run "$SWARM_TS" "$@"; }
# As a particular session.
swas() { local who="$1"; shift; SWARM_SESSION="$who" SWARM_STATE_DIR="$S" bun run "$SWARM_TS" "$@"; }
# Run and capture both output and exit code: `rc=$(...)`-style capture.
run() { OUT="$("$@" 2>&1)"; RC=$?; }
jget() { python3 "$WORK/jget.py" "$1" "$2"; }
unread() { ls "$S/mail/$1/new" 2>/dev/null | grep -c '\.json$' || true; }

cat >"$WORK/jget.py" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
v = eval(sys.argv[2], {}, {"d": d})
if v is None:
    print("")
elif isinstance(v, (dict, list)):
    print(json.dumps(v))
elif isinstance(v, bool):
    print("true" if v else "false")
else:
    print(v)
PY

# ---------------------------------------------------------------------------
# the stub "freepi --mode rpc"
# ---------------------------------------------------------------------------
# Written in JS on purpose: the supervisor spawns this as its freepi child, and
# on Windows bun cannot spawn a python3 that only exists as a store alias — the
# stub must be startable exactly the way the real binary is.
cat >"$WORK/stub-freepi.js" <<'JS'
// Stands in for `freepi --mode rpc`: JSONL commands in, JSONL events out.
import { appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const name = process.env.SWARM_SESSION ?? "unknown";
const selftest = process.env.SWARM_SELFTEST_DIR ?? process.cwd();
const cli = process.env.SWARM_SELFTEST_CLI ?? "";
const sessionId = randomUUID();

function record(suffix, text) {
  try {
    mkdirSync(selftest, { recursive: true });
    appendFileSync(join(selftest, `${name}.${suffix}`), `${text}\n`);
  } catch {
    /* best effort */
  }
}
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

record("start", `started role=${process.env.SWARM_ROLE ?? ""} cwd=${process.cwd()}`);

function handle(cmd) {
  const kind = cmd.type;
  if (kind === "prompt" || kind === "steer" || kind === "follow_up") {
    const text = cmd.message ?? "";
    record("prompts", `[${kind}] ${text}`);
    const marker = text.indexOf("!swarm ");
    if (marker !== -1) {
      // Behave like an agent running the coordination CLI from bash: the pushed
      // mail is prefixed with who it came from, exactly as a real one is.
      const argv = [
        ...cli.split(/\s+/).filter(Boolean),
        ...text
          .slice(marker + 7)
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => t.replace(/^"|"$/g, "")),
      ];
      const res = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: process.env });
      record("cmdout", `rc=${res.status} out=${(res.stdout ?? "").trim()} err=${(res.stderr ?? "").trim()}`);
    }
    emit({ type: "turn_start" });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ack" }] } });
    emit({ type: "turn_end" });
    emit({ type: "agent_settled" });
    emit({ type: "response", command: kind, success: true, id: cmd.id });
    return;
  }
  if (kind === "get_state") {
    emit({
      type: "response",
      command: "get_state",
      success: true,
      id: cmd.id,
      data: {
        sessionId,
        sessionFile: join(selftest, `${name}-session.jsonl`),
        model: { id: "stub/model" },
        isStreaming: false,
        messageCount: 0,
      },
    });
    return;
  }
  if (kind === "set_session_name") record("sessionname", String(cmd.name ?? ""));
  emit({ type: "response", command: kind, success: true, id: cmd.id });
}

let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString("utf8");
  let index;
  while ((index = carry.indexOf("\n")) !== -1) {
    let line = carry.slice(0, index);
    carry = carry.slice(index + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* one bad line must not kill the agent */
    }
  }
});
process.stdin.on("end", () => {
  record("start", "stdin closed (graceful stop)");
  process.exit(0);
});
JS

echo "==== 0. environment ===="
echo "  state dir: $S"
echo "  stub:      $WORK_N/stub-freepi.js"
export SWARM_STATE_DIR="$(native "$S")"
export SWARM_TOKEN_FILE="$TOKEN"
export SWARM_FREEPI_CMD="$BUN_N $WORK_N/stub-freepi.js"
export SWARM_SELFTEST_CLI="$BUN_N run $SWARM_TS_N"
export SWARM_MAIL_POLL_MS=400
export SWARM_PORT="$PORT"
echo "  a real freepi is never started: SWARM_FREEPI_CMD=$SWARM_FREEPI_CMD"

echo
echo "==== 1. the switch gates deployment ===="
run sw status --json; echo "$OUT" >"$WORK/status.json"
[ "$(jget "$WORK/status.json" "d['config']['enabled']")" = "false" ] \
  && ok "defaults to OFF (a fresh install deploys nothing)" || bad "default was not OFF: $(cat "$WORK/status.json")"
run sw spawn --name refused
[ "$RC" = "3" ] && ok "spawn with the switch off exits 3" || bad "spawn with the switch off exited $RC (expected 3)"
echo "$OUT" | grep -q "switch is OFF" && ok "and says why: $(echo "$OUT" | tail -1)" || bad "unhelpful refusal: $OUT"
[ ! -f "$S/agents/refused.json" ] && ok "nothing was registered for the refused spawn" || bad "a refused spawn left a roster entry"
[ -z "$(ls "$S/slots" 2>/dev/null)" ] && ok "and took no worker slot" || bad "a refused spawn consumed a slot"

run sw on
[ "$RC" = "0" ] && ok "swarm on" || bad "swarm on exited $RC: $OUT"
SWARM_STATE_DIR="$S" python3 - <<'PY'
import json, os
path = os.path.join(os.environ["SWARM_STATE_DIR"], "config.json")
cfg = json.load(open(path))
cfg["maxWorkers"] = 2          # small cap, so the capacity path is exercised
json.dump(cfg, open(path, "w"), indent=2)
print(f"  config now: {json.dumps(cfg)}")
PY
run sw status --json; echo "$OUT" >"$WORK/status.json"
[ "$(jget "$WORK/status.json" "d['config']['enabled']")" = "true" ] && ok "switch is ON" || bad "switch did not turn on"
[ "$(jget "$WORK/status.json" "d['config']['maxWorkers']")" = "2" ] && ok "maxWorkers=2" || bad "maxWorkers not read from config"

echo
echo "==== 2. deploying a subagent: its own process, its own session ===="
run sw spawn --name alpha --role recon --cwd "$WORK" --json
echo "$OUT" >"$WORK/spawn-alpha.json"
[ "$RC" = "0" ] && ok "deployed alpha ($(jget "$WORK/spawn-alpha.json" "d['pid']"))" || bad "spawn failed: $OUT"
[ "$(jget "$WORK/spawn-alpha.json" "d['slot']")" = "0" ] && ok "alpha took slot 0" || bad "alpha's slot was not 0"

# wait for the supervisor to finish handshaking with the agent
for _ in $(seq 1 40); do
  run sw roster --json; echo "$OUT" >"$WORK/roster.json"
  [ "$(jget "$WORK/roster.json" "len([a for a in d['agents'] if a['name']=='alpha' and a['sessionId']])")" = "1" ] && break
  sleep 0.5
done
[ "$(jget "$WORK/roster.json" "len([a for a in d['agents'] if a['name']=='alpha' and a['sessionId']])")" = "1" ] \
  && ok "alpha is on the roster with its own session id" || bad "alpha never reported a session id: $(cat "$WORK/roster.json")"
[ "$(jget "$WORK/roster.json" "len([a for a in d['agents'] if a['name']=='alpha' and a['status']!='exited'])")" = "1" ] \
  && ok "alpha is live" || bad "alpha is not live"

run sw spawn --name beta --role hunter --cwd "$WORK"
[ "$RC" = "0" ] && ok "deployed beta" || bad "second spawn failed ($RC): $OUT"
run sw spawn --name gamma --role verifier --cwd "$WORK"
[ "$RC" = "4" ] && ok "a third worker is refused (cap 2) — exit 4" || bad "the cap did not hold: exit $RC $OUT"
echo "$OUT" | grep -q "at capacity" && ok "and says why: at capacity" || bad "unclear capacity refusal: $OUT"

run sw spawn --name alpha --role recon --cwd "$WORK"
[ "$RC" = "4" ] && ok "re-using a live name is refused" || bad "name collision allowed (exit $RC)"
run sw spawn --name /etc/passwd --role recon --cwd "$WORK"
[ "$RC" = "1" ] && ok "a name that would be a path is rejected" || bad "path-ish name accepted (exit $RC)"

sleep 2
[ -f "$STUBDIR/alpha.prompts" ] && ok "alpha's agent received a brief" || bad "no brief reached alpha"
grep -q "You are alpha, a recon agent" "$STUBDIR/alpha.prompts" && ok "the brief names the agent and its role" || bad "brief lacks identity: $(head -c 200 "$STUBDIR/alpha.prompts")"
grep -q "swarm task claim" "$STUBDIR/alpha.prompts" && ok "the brief teaches the bus" || bad "brief does not mention the bus"
grep -q "Never test or edit a scope someone else holds" "$STUBDIR/alpha.prompts" && ok "the brief carries the rules of engagement" || bad "brief has no rules"
grep -q "Passive first" "$STUBDIR/alpha.prompts" && ok "the role file's own text is included (recon)" || bad "role brief not loaded"
grep -q "swarm:recon:alpha" "$STUBDIR/alpha.sessionname" && ok "the session is renamed swarm:recon:alpha (visible in freepi-panel)" || bad "session name not set"

echo
echo "==== 3. the bus: sessions talk with no daemon at all ===="
# scout and scribe are ordinary sessions (a terminal, a script) that merely put
# themselves on the roster — NOT deployed workers. That distinction matters: a
# deployed worker gets its mail pushed into it by its supervisor, so a
# push-free puller is the only way to test the daemon-free half of the bus.
run sw register --name scout --role recon
[ "$RC" = "0" ] && ok "a session puts itself on the roster: $(echo "$OUT" | tail -1)" || bad "register failed: $OUT"
run sw register --name scribe --role scribe
[ "$RC" = "0" ] && ok "and another one" || bad "register failed: $OUT"
run swas scout send --to scribe "staging host is in scope too"
[ "$RC" = "0" ] && ok "scout sends scribe a message" || bad "send failed: $OUT"
[ "$(unread scribe)" = "1" ] && ok "it lands in scribe's inbox as one unread file" || bad "scribe's inbox holds $(unread scribe)"
run swas scribe inbox --json; echo "$OUT" >"$WORK/inbox.json"
[ "$(jget "$WORK/inbox.json" "d['count']")" = "1" ] && ok "scribe reads one message" || bad "scribe read $(jget "$WORK/inbox.json" "d['count']")"
[ "$(jget "$WORK/inbox.json" "d['messages'][0]['from']")" = "scout" ] && ok "attributed to scout" || bad "wrong sender"
[ "$(jget "$WORK/inbox.json" "d['messages'][0]['body']")" = "staging host is in scope too" ] \
  && ok "body intact" || bad "body mangled: $(jget "$WORK/inbox.json" "d['messages'][0]['body']")"
[ "$(unread scribe)" = "0" ] && ok "reading it marked it read (moved, not deleted)" || bad "still unread after reading"
[ -f "$S/mail/scribe/read/$(jget "$WORK/inbox.json" "d['messages'][0]['id']").json" ] && ok "the message is archived under read/" || bad "message not archived"
run swas scribe send --to scout "repro'd the redirect bug"
run swas scribe inbox --keep --json; echo "$OUT" >"$WORK/inbox2.json"
[ "$(jget "$WORK/inbox2.json" "d['count']")" = "0" ] && ok "--keep/--peek does not re-read old mail" || bad "--keep returned old mail"
run swas scout inbox --json; echo "$OUT" >"$WORK/inbox3.json"
[ "$(jget "$WORK/inbox3.json" "d['messages'][0]['body']")" = "repro'd the redirect bug" ] && ok "and scribe's reply reached scout" || bad "reply lost"
run swas scout send --all "standup: I have the login redirect, who wants the IDOR"
echo "$OUT" | grep -q "scribe" && ok "send --all reaches the other sessions (workers and hand-driven alike)" || bad "broadcast did not reach scribe: $OUT"
run swas scout send --to nobody-yet "anyone home?"
[ "$RC" = "0" ] && echo "$OUT" | grep -q "not on the roster yet" \
  && ok "mail to an unregistered name queues and says so" || bad "unregistered recipient mishandled: $OUT"
run swas scout send --to "bad name!" "hi"
[ "$RC" = "1" ] && ok "an invalid recipient is refused" || bad "invalid recipient accepted (exit $RC)"
run swas scout send --to scribe
[ "$RC" = "1" ] && ok "an empty message is refused" || bad "empty message accepted (exit $RC)"

# scout's broadcast also reached the two running workers, whose supervisors
# drain and push those inboxes shortly after — nothing is lost either way.
sleep 1

echo
echo "==== 4. delivery into a running worker (the push path) ===="
# The stub acts as the agent: when the pushed message contains `!swarm ...` it
# runs the coordination CLI from inside the worker, so this exercises the whole
# circle — bus → worker's turn → worker's bash → bus → another session.
run swas scout send --to alpha 'report in: !swarm send --to scribe "found it: /v2/orders leaks other tenants"'
[ "$RC" = "0" ] && ok "a message is queued for the running alpha" || bad "queue failed: $OUT"
circle=0
for _ in $(seq 1 40); do
  if grep -q 'rc=0' "$STUBDIR/alpha.cmdout" 2>/dev/null; then circle=1; break; fi
  sleep 0.5
done
[ "$circle" = "1" ] && ok "alpha (a live worker) was pushed the message and acted on it from its own bash" \
  || bad "the circle never completed: $(cat "$STUBDIR/alpha.cmdout" 2>/dev/null | tail -2)"
grep -q 'report in' "$STUBDIR/alpha.prompts" && ok "alpha's agent saw the pushed message" || bad "body did not reach alpha's agent"
run swas scribe inbox --json; echo "$OUT" >"$WORK/inbox4.json"
[ "$(jget "$WORK/inbox4.json" "len([m for m in d['messages'] if m['from']=='alpha'])")" = "1" ] \
  && [ "$(jget "$WORK/inbox4.json" "[m for m in d['messages'] if m['from']=='alpha'][0]['body']")" = "found it: /v2/orders leaks other tenants" ] \
  && ok "the result reached another session, sent by alpha itself: found it: /v2/orders leaks other tenants" \
  || bad "the circle is broken: $(cat "$WORK/inbox4.json")"

echo
echo "==== 5. the board ===="
run swas alpha task add --title "audit /v2/orders" --id BB-1 --scope api.example.com/v2 --role hunter
[ "$RC" = "0" ] && ok "task BB-1 added" || bad "task add failed: $OUT"
run swas alpha task claim BB-1
[ "$RC" = "0" ] && ok "alpha claims it" || bad "claim failed: $OUT"
run swas beta task claim BB-1
[ "$RC" = "4" ] && ok "beta cannot claim the same task (exit 4)" || bad "double claim allowed (exit $RC)"
echo "$OUT" | grep -q "claimed by alpha" && ok "and is told who holds it: $OUT" || bad "no holder in the refusal: $OUT"
run swas alpha task claim BB-1
[ "$RC" = "0" ] && ok "the owner can renew its own claim" || bad "renewal refused: $OUT"
run swas beta task done BB-1 --evidence "not mine"
[ "$RC" = "4" ] && ok "a non-owner cannot close it" || bad "non-owner closed the task (exit $RC)"
run swas alpha task done BB-1 --evidence "GET /v2/orders?tenant=2 returns tenant 1's rows"
[ "$RC" = "0" ] && ok "the owner closes it with evidence" || bad "done failed: $OUT"
run sw task list --json; echo "$OUT" >"$WORK/tasks.json"
[ "$(jget "$WORK/tasks.json" "[t for t in d['tasks'] if t['id']=='BB-1'][0]['status']")" = "done" ] && ok "board shows it done" || bad "board state wrong"
[ -n "$(jget "$WORK/tasks.json" "[t for t in d['tasks'] if t['id']=='BB-1'][0]['evidence']")" ] && ok "the evidence is recorded" || bad "evidence lost"

run swas alpha task add --title "expiry test" --id BB-2
run swas alpha task claim BB-2
SWARM_STATE_DIR="$S" python3 - <<'PY'
import json, os
path = os.path.join(os.environ["SWARM_STATE_DIR"], "tasks", "BB-2.json")
task = json.load(open(path))
task["leaseUntil"] = "2000-01-01T00:00:00.000Z"      # pretend the lease ran out
json.dump(task, open(path, "w"), indent=2)
PY
run swas beta task claim BB-2
[ "$RC" = "0" ] && ok "an expired lease is reclaimable by another session" || bad "expired claim stuck (exit $RC): $OUT"
run sw task list --json; echo "$OUT" >"$WORK/tasks.json"
[ "$(jget "$WORK/tasks.json" "len([t for t in d['tasks'] if t['id']=='BB-2'][0]['history']) > 1")" = "true" ] \
  && ok "the board keeps the history (who claimed what, when)" || bad "no history on the task"

echo
echo "==== 6. scope claims: one tester per target ===="
run swas alpha claim "api.example.com/v2"
[ "$RC" = "0" ] && ok "alpha claims a scope" || bad "scope claim failed: $OUT"
run swas beta claim "api.example.com/v2"
[ "$RC" = "4" ] && ok "beta is refused the same scope (exit 4)" || bad "two testers on one scope (exit $RC)"
echo "$OUT" | grep -q "held by alpha" && ok "and knows who holds it" || bad "no holder: $OUT"
run swas beta claim "api.example.com/v2" --force
[ "$RC" = "0" ] && ok "--force takes it over deliberately" || bad "--force did not work: $OUT"
run swas alpha release "api.example.com/v2"
[ "$RC" = "4" ] && ok "a non-owner cannot release it" || bad "release by non-owner allowed (exit $RC)"
run swas beta release "api.example.com/v2"
[ "$RC" = "0" ] && ok "the owner releases it" || bad "owner release failed: $OUT"
run swas alpha claim "github.com/org/repo:auth"
run sw claims --json; echo "$OUT" >"$WORK/claims.json"
[ "$(jget "$WORK/claims.json" "len(d['claims'])")" = "1" ] && ok "claims list shows the one held scope" || bad "claims list wrong: $(cat "$WORK/claims.json")"
SWARM_STATE_DIR="$S" python3 - <<'PY'
import json, os
base = os.path.join(os.environ["SWARM_STATE_DIR"], "claims")
for name in os.listdir(base):
    path = os.path.join(base, name, "claim.json")
    if os.path.exists(path):
        claim = json.load(open(path))
        claim["expiresAt"] = "2000-01-01T00:00:00.000Z"
        json.dump(claim, open(path, "w"), indent=2)
PY
run swas beta claim "github.com/org/repo:auth"
[ "$RC" = "0" ] && ok "an expired scope claim is reclaimable (nobody is stuck behind a dead pid)" || bad "expired scope stuck: $OUT"

echo
echo "==== 7. stopping works with the switch OFF, and cleans up ===="
run swas alpha claim "example.test/wild"
[ "$RC" = "0" ] && ok "alpha holds a scope before it is stopped" || bad "claim before stop failed: $OUT"
run swas alpha task add --title "owned when it dies" --id BB-3
run swas alpha task claim BB-3
[ "$RC" = "0" ] && ok "and a task" || bad "claim before stop failed: $OUT"
run sw off
[ "$RC" = "0" ] && ok "switch turned OFF" || bad "swarm off failed"
run sw down alpha
[ "$RC" = "0" ] && ok "down still works while the switch is off (the kill switch is never gated)" || bad "down refused while off (exit $RC)"
stopped=0
for _ in $(seq 1 40); do
  run sw roster --json; echo "$OUT" >"$WORK/roster.json"
  [ "$(jget "$WORK/roster.json" "len([a for a in d['agents'] if a['name']=='alpha' and a['status']=='exited'])")" = "1" ] && { stopped=1; break; }
  sleep 0.5
done
[ "$stopped" = "1" ] && ok "alpha exited gracefully (stdin closed → agent shut down)" || bad "alpha never exited: $(cat "$WORK/roster.json")"
grep -q "stdin closed" "$STUBDIR/alpha.start" && ok "the agent saw EOF, not a kill" || bad "the agent was not shut down gracefully"
[ ! -f "$S/slots/0.json" ] && ok "its worker slot was released" || bad "slot 0 leaked"
run sw claims --json; echo "$OUT" >"$WORK/claims.json"
# beta is still running and still holds its own scope from section 6, so the
# question is only whether *alpha's* claim survived it.
[ "$(jget "$WORK/claims.json" "len([c for c in d['claims'] if c['owner']=='alpha'])")" = "0" ] \
  && ok "the scope alpha held was released for whoever claims it next" || bad "a dead session still holds a scope: $(cat "$WORK/claims.json")"
run sw task list --json; echo "$OUT" >"$WORK/tasks.json"
[ "$(jget "$WORK/tasks.json" "len([t for t in d['tasks'] if t['id']=='BB-3' and t['status']=='open'])")" = "1" ] \
  && ok "the task it owned went back to open, not stuck claimed" || bad "task stuck behind a dead agent"
[ "$(unread alpha)" = "0" ] && echo "  (alpha's inbox is empty — nothing was lost in the stop)"
run sw spawn --name delta --role hunter --cwd "$WORK"
[ "$RC" = "3" ] && ok "with the switch off, no new worker can take the freed slot" || bad "deployed while off (exit $RC)"
run sw on
run sw spawn --name delta --role hunter --cwd "$WORK"
[ "$RC" = "0" ] && ok "back on, and the freed slot is usable again" || bad "could not deploy after re-enabling: $OUT"
run sw down --all
sleep 3
run sw reap --json; echo "$OUT" >"$WORK/reap.json"
[ "$(jget "$WORK/reap.json" "len(d['freed'])")" -ge 0 ] && ok "reap runs cleanly ($(jget "$WORK/reap.json" "len(d['freed'])") slot(s) freed)" || bad "reap failed: $OUT"
run sw ps --json; echo "$OUT" >"$WORK/ps.json"
[ "$(jget "$WORK/ps.json" "len([a for a in d['agents'] if a['source']=='deployed' and a['status']!='exited'])")" = "0" ] \
  && ok "no deployed worker is left running after down --all" || bad "workers still alive: $(cat "$WORK/ps.json")"

# A worker whose freepi cannot start must give up loudly and free its slot: a
# supervisor that hangs instead would silently eat capacity and make `swarm ps`
# claim something is running when nothing is.
OUT="$(SWARM_FREEPI_CMD='definitely-not-a-real-binary' sw spawn --name broken --role hunter --cwd "$WORK_N" 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "spawn accepts a worker even when freepi is missing (the failure surfaces in its log, not the CLI)" \
  || bad "spawn failed early: $OUT"
broken_exited=0
for _ in $(seq 1 30); do
  run sw roster --json; echo "$OUT" >"$WORK/roster.json"
  [ "$(jget "$WORK/roster.json" "len([a for a in d['agents'] if a['name']=='broken' and a['status']=='exited'])")" = "1" ] && { broken_exited=1; break; }
  sleep 0.5
done
[ "$broken_exited" = "1" ] && ok "the supervisor gave up and reported exited" || bad "a worker whose freepi cannot start hangs forever"
grep -q "could not start" "$S/logs/broken.log" 2>/dev/null \
  && ok "and wrote why: $(grep -m1 'could not start' "$S/logs/broken.log" | cut -c1-80)" || bad "no reason in broken's log"
[ -z "$(ls "$S/slots" 2>/dev/null)" ] && ok "its worker slot was released, so capacity is not silently lost" || bad "slot still held: $(ls "$S/slots")"

echo
echo "==== 8. the service: token, same-origin, the switch, and the roster it shows ===="
SWARM_STATE_DIR="$S" SWARM_TOKEN_FILE="$TOKEN" SWARM_PORT="$PORT" SWARM_FREEPI_CMD="$SWARM_FREEPI_CMD" \
  SWARM_SELFTEST_CLI="$SWARM_SELFTEST_CLI" SWARM_MAIL_POLL_MS=400 \
  bun run "$SWARM_TS" serve >"$WORK/serve.log" 2>&1 &
SERVE_PID=$!
ready=0
for _ in $(seq 1 40); do
  if curl -s "http://127.0.0.1:$PORT/healthz" >"$WORK/health.json" 2>/dev/null; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" = "1" ] && ok "service answers /healthz" || { bad "service did not start"; cat "$WORK/serve.log" | head -5; }
TOKEN_MODE="$(stat -c '%a' "$TOKEN" 2>/dev/null || stat -f '%Lp' "$TOKEN" 2>/dev/null || echo '?')"
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    [ -f "$TOKEN" ] && echo "  SKIP  token mode on Windows ($TOKEN_MODE) — the Linux target is 0600" \
      || bad "no token file was generated" ;;
  *)
    [ "$TOKEN_MODE" = "600" ] && ok "it generated its own token, 0600" || bad "token mode is $TOKEN_MODE (expected 600)" ;;
esac
[ "$(jget "$WORK/health.json" "d['ok']")" = "true" ] && ok "healthz ok:true" || bad "healthz bad"
curl -s "http://127.0.0.1:$PORT/" >"$WORK/index.html"
grep -q "<title>freepi swarm</title>" "$WORK/index.html" && ok "the UI shell is served (the switch lives there)" || bad "UI shell missing"
grep -q 'id="enabled"' "$WORK/index.html" && ok "it contains the deployment switch" || bad "no switch in the UI"
grep -q 'id="agents"' "$WORK/index.html" && ok "and the roster/board/claims tables" || bad "UI lacks the roster"
T="$(cat "$TOKEN")"
C="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state")"
[ "$C" = "401" ] && ok "no token → 401" || bad "state without a token → $C"
C="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/login" -H 'content-type: application/json' -d '{"token":"wrong"}')"
[ "$C" = "401" ] && ok "wrong token → 401" || bad "wrong token → $C"
C="$(curl -s -c "$WORK/jar" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/login" -H 'content-type: application/json' -d "{\"token\":\"$T\"}")"
[ "$C" = "200" ] && ok "right token → 200 + cookie" || bad "login → $C"
C="$(curl -s -b "$WORK/jar" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/toggle" -H 'content-type: application/json' -H 'Origin: https://evil.example' -d '{"enabled":false}')"
[ "$C" = "403" ] && ok "a cross-origin mutation → 403" || bad "cross-origin toggle → $C"
C="$(curl -s -b "$WORK/jar" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/toggle" -H 'content-type: application/json' -H 'Sec-Fetch-Site: cross-site' -d '{"enabled":false}')"
[ "$C" = "403" ] && ok "and a cross-site fetch → 403" || bad "cross-site toggle → $C"
curl -s -b "$WORK/jar" -X POST "http://127.0.0.1:$PORT/api/toggle" -H 'content-type: application/json' -d '{"enabled":false}' >"$WORK/toggle.json"
[ "$(jget "$WORK/toggle.json" "d['config']['enabled']")" = "false" ] && ok "the UI switch turns it off (config.json is the source of truth)" || bad "toggle did not persist"
run sw status --json; echo "$OUT" >"$WORK/status.json"
[ "$(jget "$WORK/status.json" "d['config']['enabled']")" = "false" ] && ok "…and the CLI agrees" || bad "CLI and UI disagree"
C="$(curl -s -b "$WORK/jar" -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/spawn" -H 'content-type: application/json' -d '{"name":"from-panel","role":"hunter","cwd":"'"$WORK_N"'"}')"
[ "$C" = "403" ] && ok "the API cannot deploy while the switch is off → 403" || bad "API spawned while off → $C"
curl -s -b "$WORK/jar" -X POST "http://127.0.0.1:$PORT/api/toggle" -H 'content-type: application/json' -d '{"enabled":true}' >/dev/null
curl -s -b "$WORK/jar" -X POST "http://127.0.0.1:$PORT/api/spawn" -H 'content-type: application/json' -d '{"name":"from-panel","role":"hunter","cwd":"'"$WORK_N"'"}' >"$WORK/spawn-panel.json"
[ "$(jget "$WORK/spawn-panel.json" "d['ok']")" = "true" ] && ok "with the switch on, the UI deploys a worker" || bad "UI spawn failed: $(cat "$WORK/spawn-panel.json")"
curl -s -b "$WORK/jar" "http://127.0.0.1:$PORT/api/state" >"$WORK/api-state.json"
[ "$(jget "$WORK/api-state.json" "len([a for a in d['agents'] if a['name']=='from-panel'])")" = "1" ] && ok "it appears in the roster the UI renders" || bad "panel-spawned worker missing from /api/state"
[ "$(jget "$WORK/api-state.json" "d['slots']['max']")" = "2" ] && ok "the UI shows the real worker cap" || bad "cap wrong in /api/state"
curl -s -b "$WORK/jar" -X POST "http://127.0.0.1:$PORT/api/mail" -H 'content-type: application/json' \
  -d '{"to":"from-panel","from":"panel","body":"check the staging host","subject":"note"}' >/dev/null
panel_mail=0
for _ in $(seq 1 30); do
  if grep -q 'check the staging host' "$STUBDIR/from-panel.prompts" 2>/dev/null; then panel_mail=1; break; fi
  sleep 0.5
done
[ "$panel_mail" = "1" ] && ok "panel mail was pushed into the running worker and consumed" \
  || bad "panel mail not delivered (inbox=$(unread from-panel))"
(curl -s -N -b "$WORK/jar" "http://127.0.0.1:$PORT/api/stream" >"$WORK/sse.txt" 2>/dev/null &) ; sleep 1
curl -s -b "$WORK/jar" -X POST "http://127.0.0.1:$PORT/api/toggle" -H 'content-type: application/json' -d '{"enabled":true}' >/dev/null
sleep 3
grep -q "swarm_ready" "$WORK/sse.txt" && ok "SSE stream handshake" || bad "no SSE handshake"
grep -q "toggle" "$WORK/sse.txt" && ok "SSE carries the audit trail (toggle events)" || bad "SSE missed the toggle"
curl -s -b "$WORK/jar" -X POST "http://127.0.0.1:$PORT/api/stop" -H 'content-type: application/json' -d '{"all":true}' >/dev/null
sleep 3
run sw ps --json; echo "$OUT" >"$WORK/ps.json"
[ "$(jget "$WORK/ps.json" "len([a for a in d['agents'] if a['source']=='deployed' and a['status']!='exited'])")" = "0" ] \
  && ok "the UI stopped every worker" || bad "workers left running: $(cat "$WORK/ps.json")"
kill "$SERVE_PID" 2>/dev/null
ok "service stopped"

echo
echo "==== 9. hygiene ===="
grep -rqE 'BEGIN (RSA|OPENSSH|EC) PRIVATE KEY' "$S" 2>/dev/null && bad "a private key is in the state dir" || ok "no key material in the state dir"
run sw status
[ "$RC" = "0" ] && ok "status still renders after all of that" || bad "status broke: $OUT"
echo "$OUT" | sed 's/^/    /'

echo
echo "RESULT: $pass passed, $fail failed   (state kept at $S)"
[ "$fail" = "0" ] || exit 1
