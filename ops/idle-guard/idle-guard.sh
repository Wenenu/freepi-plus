#!/usr/bin/env bash
# idle-guard.sh — act when this sandbox has nothing going on.
#
# Deliberately NOT named zipbox-*: this sandbox installs drop-ins under
# /run/systemd/system/zipbox-.service.d/ for its own units, which force
# Restart=always — and systemd refuses that combination with Type=oneshot, so a
# zipbox-prefixed oneshot unit can never load. See README.md.
#
# Why this exists: zipbox bills per second while a machine is running, and a
# sandbox left on overnight is pure cost. This catches the two cases that
# actually happen: (a) no agent process at all, (b) an agent process parked at
# a prompt / waiting forever, where the process exists but has done no work.
#
# It is deliberately conservative: it only acts when every signal agrees, and
# the default action talks to you instead of pulling the rug out.
#
# Usage:
#   idle-guard.sh              normal run (the systemd timer calls this)
#   idle-guard.sh --status     show every signal + how much idle time has
#                              accrued; changes nothing
#   idle-guard.sh --dry-run    decide + log, but take no action
#   idle-guard.sh --hold       never treat this sandbox as idle until --release
#                              ("I'm working on something — leave it alone")
#   idle-guard.sh --release    drop the hold set by --hold
#   idle-guard.sh --help
#
# Config: /etc/default/idle-guard (see the sample in the repo's ops dir).
set -uo pipefail

CONFIG="${IDLE_GUARD_CONFIG:-/etc/default/idle-guard}"
# shellcheck source=/dev/null
if [ -r "$CONFIG" ]; then
  . "$CONFIG"
fi

IDLE_SECONDS="${IDLE_SECONDS:-3600}"
LOAD_THRESHOLD="${LOAD_THRESHOLD:-1.0}"
# Processes that mean "an AI agent is running here". ERE for pgrep.
AGENT_PATTERN="${AGENT_PATTERN:-free-pi-cli/.*index\.ts|pi-coding-agent|claude-code|codex}"
# Comma-separated: notify, poweroff, stop-antseed, none
ACTIONS="${ACTIONS:-notify}"
NOTIFY_TO="${NOTIFY_TO:-}"
NOTIFY_MIN_INTERVAL="${NOTIFY_MIN_INTERVAL:-21600}"
STATE_DIR="${STATE_DIR:-/var/lib/idle-guard}"
LOG_FILE="${LOG_FILE:-/var/log/idle-guard.log}"
KEEPALIVE_FILE="${KEEPALIVE_FILE:-$STATE_DIR/keepalive}"

MODE="run"
case "${1:-}" in
  --status) MODE="status" ;;
  --dry-run) MODE="dry-run" ;;
  --hold) MODE="hold" ;;
  --release) MODE="release" ;;
  -h | --help)
    # Print the usage block only (from the "Usage:" comment to the end of the
    # comment header), so editing the preamble above never leaks into --help.
    awk '/^# Usage:/{p=1} p && /^#/ {sub(/^# ?/, ""); print; next} p && !/^#/ {exit}' "$0"
    exit 0
    ;;
  "") ;;
  *)
    echo "unknown option: $1 (try --help)" >&2
    exit 2
    ;;
esac

NOW="$(date +%s)"
mkdir -p "$STATE_DIR" 2>/dev/null
LAST_BUSY_FILE="$STATE_DIR/last-busy"
LAST_NOTIFIED_FILE="$STATE_DIR/last-notified"

# --- hold / release ----------------------------------------------------------
# The one-command way to say "I'm working, do not touch this box": it sets the
# keepalive that signal 4 checks. Survives reboots and config edits.
if [ "$MODE" = "hold" ] || [ "$MODE" = "release" ]; then
  if [ "$MODE" = "hold" ]; then
    : >"$KEEPALIVE_FILE" 2>/dev/null &&
      echo "HELD: $KEEPALIVE_FILE exists — this sandbox will not be treated as idle." ||
      echo "could not write $KEEPALIVE_FILE" >&2
  else
    rm -f "$KEEPALIVE_FILE" 2>/dev/null
    echo "RELEASED: the idle clock restarts from now."
    printf '%s\n' "$NOW" >"$LAST_BUSY_FILE" 2>/dev/null
  fi
  exit 0
fi

log() {
  [ "$MODE" = "status" ] && return 0
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG_FILE" 2>/dev/null || true
}

# --- identify our own process tree, so we never mistake ourselves for work ---
# shellcheck disable=SC2086
SELF_CHAIN=" $$ "
_walk="$$"
while [ "$_walk" != "1" ] && [ -n "$_walk" ]; do
  _next="$(awk '{print $4}' "/proc/$_walk/stat" 2>/dev/null)"
  [ -z "${_next:-}" ] && break
  SELF_CHAIN="$SELF_CHAIN$_next "
  _walk="$_next"
done
is_self() {
  case "$SELF_CHAIN" in *" $1 "*) return 0 ;; esac
  return 1
}

# pgrep -af output: "<pid> <cmdline>"; keep only PIDs outside our own tree.
match_pids() {
  local pid
  while read -r pid _rest; do
    [ -z "${pid:-}" ] && continue
    is_self "$pid" && continue
    printf '%s ' "$pid"
  done < <(pgrep -af "$1" 2>/dev/null || true)
}

# The tail of --status: the signals whose answer does not depend on the verdict.
# Printed for BUSY as well as IDLE, so "is the keepalive set?" is answerable
# without waiting for the box to look idle (and so a caller parsing this output
# gets the same keys either way).
print_status_tail() {
  echo "keepalive: $([ -f "$KEEPALIVE_FILE" ] && echo present || echo absent)"
  echo "actions: $ACTIONS"
  LAST_NOTIFIED="$(cat "$LAST_NOTIFIED_FILE" 2>/dev/null || echo 0)"
  echo "last notified: $([ "$LAST_NOTIFIED" = "0" ] && echo never || echo "$((NOW - LAST_NOTIFIED))s ago")"
}

cpu_ticks() { awk '{print $14+$15}' "/proc/$1/stat" 2>/dev/null; }

load1() { awk '{print $1}' /proc/loadavg 2>/dev/null; }

# --- signals -----------------------------------------------------------------
AGENT_PIDS="$(match_pids "$AGENT_PATTERN")"
# A remote shell means somebody is (or was just) driving this box. Note the
# convention here: non-tty sessions (root@notty) are how automated ssh commands
# arrive, tty sessions (root@pts/N) are interactive shells.
SESSION_PIDS="$(match_pids 'sshd: root@|ssh: root@')"
LOAD="$(load1)"

BUSY_REASONS=""
add_reason() { BUSY_REASONS="${BUSY_REASONS}${BUSY_REASONS:+; }$1"; }

# 1. A remote session that is genuinely active (idle tty shells do not count
#    forever: their CPU time stops advancing, same rule as agents below).
active_session=""
for pid in $SESSION_PIDS; do
  cur="$(cpu_ticks "$pid")"
  prev_file="$STATE_DIR/session-$pid.cpu"
  prev="$(cat "$prev_file" 2>/dev/null || echo "")"
  if [ -n "$cur" ]; then
    # --status is read-only: report from the last snapshot, never rewrite it.
    [ "$MODE" != "status" ] && printf '%s\n' "$cur" >"$prev_file" 2>/dev/null
    if [ -z "$prev" ] || [ "$cur" != "$prev" ]; then
      active_session="$active_session $pid"
    fi
  fi
done
[ -n "$active_session" ] && add_reason "active ssh session(s):$active_session"

# 2. Agents doing work (CPU advancing), or brand new agents.
working_agent=""
parked_agent=""
for pid in $AGENT_PIDS; do
  cur="$(cpu_ticks "$pid")"
  prev_file="$STATE_DIR/agent-$pid.cpu"
  prev="$(cat "$prev_file" 2>/dev/null || echo "")"
  [ -n "$cur" ] && [ "$MODE" != "status" ] && printf '%s\n' "$cur" >"$prev_file" 2>/dev/null
  if [ -z "$prev" ] || [ "$cur" != "$prev" ]; then
    working_agent="$working_agent $pid"
  else
    parked_agent="$parked_agent $pid"
  fi
done
[ -n "$working_agent" ] && add_reason "agent working (cpu advancing):$working_agent"

# 3. Load safety net: catches heavy children (builds, test runs) that a parked
#    parent agent would otherwise hide.
if awk -v l="$LOAD" -v t="$LOAD_THRESHOLD" 'BEGIN { exit !(l >= t) }'; then
  add_reason "load ${LOAD} >= ${LOAD_THRESHOLD}"
fi

# 4. Explicit opt-out for long unattended jobs.
if [ -f "$KEEPALIVE_FILE" ]; then
  add_reason "keepalive file present ($KEEPALIVE_FILE)"
fi

# --- idle bookkeeping --------------------------------------------------------
if [ "$MODE" != "status" ]; then
  # Drop CPU snapshots for pids that no longer exist.
  for f in "$STATE_DIR"/agent-*.cpu "$STATE_DIR"/session-*.cpu; do
    [ -f "$f" ] || continue
    pid="$(basename "$f" | sed -E 's/.*-([0-9]+)\.cpu/\1/')"
    [ -d "/proc/$pid" ] || rm -f "$f" 2>/dev/null
  done
fi

if [ -n "$BUSY_REASONS" ]; then
  if [ "$MODE" != "status" ]; then
    printf '%s\n' "$NOW" >"$LAST_BUSY_FILE" 2>/dev/null
    # Re-arm the notification: a NEW idle stretch is a new event. Without this,
    # one notification suppresses every later one for NOTIFY_MIN_INTERVAL, so
    # "worked for ten minutes, then left" would never email you again.
    [ -f "$LAST_NOTIFIED_FILE" ] && rm -f "$LAST_NOTIFIED_FILE" 2>/dev/null
    log "busy: $BUSY_REASONS"
  fi
  if [ "$MODE" = "status" ]; then
    echo "state: BUSY — $BUSY_REASONS"
    print_status_tail
  fi
  [ "$MODE" = "dry-run" ] && echo "dry-run: BUSY ($BUSY_REASONS) — no action"
  exit 0
fi

LAST_BUSY="$(cat "$LAST_BUSY_FILE" 2>/dev/null || echo "")"
if [ -z "$LAST_BUSY" ]; then
  printf '%s\n' "$NOW" >"$LAST_BUSY_FILE" 2>/dev/null
  log "first run: baseline idle clock started"
  [ "$MODE" = "status" ] && echo "state: IDLE (baseline just started)"
  [ "$MODE" = "dry-run" ] && echo "dry-run: baseline just started — no action"
  exit 0
fi

IDLE_FOR=$((NOW - LAST_BUSY))
[ "$IDLE_FOR" -lt 0 ] && IDLE_FOR=0

# --- status output -----------------------------------------------------------
if [ "$MODE" = "status" ]; then
  echo "state: IDLE for ${IDLE_FOR}s (threshold ${IDLE_SECONDS}s)"
  echo "agents:  ${AGENT_PIDS:-none} (parked:${parked_agent:- none})"
  echo "sessions:${SESSION_PIDS:- none}"
  echo "load:    ${LOAD} (threshold ${LOAD_THRESHOLD})"
  print_status_tail
  echo "would act: $([ "$IDLE_FOR" -ge "$IDLE_SECONDS" ] && echo yes || echo "no (${IDLE_FOR}s < ${IDLE_SECONDS}s)")"
  exit 0
fi

if [ "$IDLE_FOR" -lt "$IDLE_SECONDS" ]; then
  log "idle ${IDLE_FOR}s of ${IDLE_SECONDS}s${parked_agent:+ (parked agent:$parked_agent)}"
  [ "$MODE" = "dry-run" ] && echo "dry-run: idle ${IDLE_FOR}s < ${IDLE_SECONDS}s — no action"
  exit 0
fi

# --- idle long enough: act ---------------------------------------------------
SUMMARY="no agent has run for $((IDLE_FOR / 60)) minutes (no remote session, load ${LOAD}${parked_agent:+, agent parked:$parked_agent})"

notify() {
  local last now_ts
  now_ts="$NOW"
  last="$(cat "$LAST_NOTIFIED_FILE" 2>/dev/null || echo 0)"
  if [ $((now_ts - last)) -lt "$NOTIFY_MIN_INTERVAL" ]; then
    log "notify suppressed (last sent $((now_ts - last))s ago)"
    return 0
  fi
  if command -v tribes-notify >/dev/null 2>&1; then
    tribes-notify --message "This sandbox has been idle for $((IDLE_FOR / 60)) min. Pause it in the zipbox dashboard to stop the per-second meter." \
      --key "idle-guard-${IDLE_FOR}" --label "Sandbox idle" >/dev/null 2>&1 &&
      log "notified via tribes-notify" || log "tribes-notify failed"
  fi
  if [ -n "$NOTIFY_TO" ] && command -v tribes-email >/dev/null 2>&1; then
    tribes-email send "$NOTIFY_TO" "[zipbox] $(hostname) is idle — safe to pause ($((IDLE_FOR / 60)) min)" \
      --body "$(hostname) looks idle, so nothing is being billed for work right now — but the sandbox is still running, and zipbox bills per running second.

Reason: $SUMMARY

Details
  idle for:        $((IDLE_FOR / 60)) min (threshold $((IDLE_SECONDS / 60)) min)
  load average:    $LOAD (threshold $LOAD_THRESHOLD)
  agent processes: ${AGENT_PIDS:-none} (parked:${parked_agent:- none})
  sign-in shells:  ${SESSION_PIDS:-none}
  keepalive file:  $([ -f "$KEEPALIVE_FILE" ] && echo present || echo absent)

What to do
  Pause it: zipbox dashboard -> this sandbox -> Pause. The disk is kept; resuming boots the same machine and stops the per-second meter.

  To leave it awake on purpose (a long job, or you are about to use it again):
    idle-guard.sh --hold          # never considered idle until --release
    idle-guard.sh --release       # undo the hold

  Nothing is paused for you: this guard only tells you. A poweroff would be irreversible from inside the sandbox unless the dashboard can boot it again.

-- idle-guard on $(hostname)" >/dev/null 2>&1 &&
      log "notified via tribes-email ($NOTIFY_TO)" || log "tribes-email failed"
  fi
  printf '%s\n' "$now_ts" >"$LAST_NOTIFIED_FILE" 2>/dev/null
  return 0
}

stop_antseed() {
  local pids
  pids="$(match_pids 'antseed buyer start')"
  for pid in $pids; do
    kill "$pid" 2>/dev/null && log "stopped antseed buyer daemon (pid $pid)"
  done
  return 0
}

ACTION_LIST="${ACTIONS//,/ }"
for action in $ACTION_LIST; do
  case "$action" in
    notify) notify ;;
    stop-antseed) stop_antseed ;;
    poweroff)
      log "POWEROFF: $SUMMARY"
      sync
      systemctl poweroff >/dev/null 2>&1 || shutdown -h now >/dev/null 2>&1 || log "poweroff failed"
      ;;
    none) log "idle threshold reached, action=none: $SUMMARY" ;;
    *) log "unknown action '$action' ignored" ;;
  esac
done

log "acted: $SUMMARY (actions=$ACTIONS)"
[ "$MODE" = "dry-run" ] && echo "dry-run: WOULD ACT ($ACTIONS) — $SUMMARY"
exit 0
