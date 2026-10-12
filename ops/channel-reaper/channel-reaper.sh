#!/usr/bin/env bash
# channel-reaper.sh — close Antseed payment channels that have gone idle.
#
# Why: a buyer payment channel holds a reserve (it shows up as "reserved" in the
# balance, separate from "available"). While a channel sits open with no traffic,
# that money is committed and unspendable. Nothing in the Antseed CLI closes it
# for you, so a channel opened for one request and then abandoned keeps its
# reserve indefinitely. This watches the buyer's channel activity and closes any
# active channel whose token counters have not moved for IDLE_SECONDS.
#
# What "idle" means here, precisely:
#   * only channels with local status "active" are considered — settled, timeout
#     and ghost channels are never touched;
#   * activity is the buyer's own `updatedAt` stamp for the channel (from
#     `antseed buyer activity --json`), combined with this script's observation
#     of the token/request counters between runs. The stamp alone can be bumped
#     by non-token events, and the counters alone cannot date a channel that was
#     already idle when the reaper was installed, so both are used and the later
#     of the two wins;
#   * a channel that has been idle for IDLE_SECONDS gets `channels close <id>`,
#     which asks the seller to settle now instead of waiting out the grace
#     period.
#
# It is deliberately conservative: one close per run by default, never a channel
# whose counters moved last run, never a retry within CLOSE_RETRY_SECONDS of a
# failed attempt, and nothing at all while the pause file exists.
#
# Usage:
#   channel-reaper.sh              one pass (the systemd timer calls this)
#   channel-reaper.sh --status     show every active channel, its idle time and
#                                  what the next pass would do; changes nothing
#   channel-reaper.sh --dry-run    decide and log, but never close anything
#   channel-reaper.sh --pause      stop closing (keeps watching and logging)
#   channel-reaper.sh --resume     undo --pause
#   channel-reaper.sh --help
#
# Config: /etc/default/channel-reaper (see the sample in the repo's ops dir).
set -uo pipefail

CONFIG="${CHANNEL_REAPER_CONFIG:-/etc/default/channel-reaper}"
# shellcheck source=/dev/null
if [ -r "$CONFIG" ]; then
  . "$CONFIG"
fi

# 600 = the ten minutes this was asked for.
IDLE_SECONDS="${IDLE_SECONDS:-600}"
# close (default) | request-close | notify
ACTION="${ACTION:-close}"
MAX_CLOSES_PER_RUN="${MAX_CLOSES_PER_RUN:-1}"
CLOSE_RETRY_SECONDS="${CLOSE_RETRY_SECONDS:-300}"
ANTSEED="${ANTSEED:-antseed}"
STATE_DIR="${STATE_DIR:-/var/lib/channel-reaper}"
LOG_FILE="${LOG_FILE:-/var/log/channel-reaper.log}"
NOTIFY_TO="${NOTIFY_TO:-}"
NOTIFY_MIN_INTERVAL="${NOTIFY_MIN_INTERVAL:-21600}"
PYTHON="${PYTHON:-python3}"
PAUSE_FILE="${PAUSE_FILE:-$STATE_DIR/paused}"
LOCK_FILE="${LOCK_FILE:-$STATE_DIR/lock}"
STATE_FILE="${STATE_FILE:-$STATE_DIR/state.json}"

# Deliberately NOT named zipbox-*: /run/systemd/system/zipbox-.service.d/ forces
# Restart=always on any unit whose name starts with "zipbox-", which systemd
# refuses to combine with Type=oneshot. See the README.

DRY_RUN=0
PASS=1
case "${1:-}" in
  --status) PASS=0 ;;
  --dry-run) DRY_RUN=1 ;;
  --pause) PASS=2 ;;
  --resume) PASS=3 ;;
  -h | --help)
    awk '/^# Usage:/{p=1} p && /^#/ {sub(/^# ?/, ""); print; next} p && !/^#/ {exit}' "$0"
    exit 0
    ;;
  "") ;;
  *)
    echo "unknown option: $1 (try --help)" >&2
    exit 2
    ;;
esac

mkdir -p "$STATE_DIR" 2>/dev/null

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG_FILE" 2>/dev/null || true
  [ "$PASS" = "0" ] && return 0
  [ "$DRY_RUN" = "1" ] && echo "$*"
  return 0
}

emit() { [ "$PASS" = "0" ] && echo "$*"; return 0; }

if [ "$PASS" = "2" ] || [ "$PASS" = "3" ]; then
  if [ "$PASS" = "2" ]; then
    : >"$PAUSE_FILE" 2>/dev/null && echo "PAUSED: $PAUSE_FILE exists — no channel will be closed." ||
      echo "could not write $PAUSE_FILE" >&2
  else
    rm -f "$PAUSE_FILE" 2>/dev/null
    echo "RESUMED: idle channels will be closed again."
  fi
  exit 0
fi

if ! command -v "$ANTSEED" >/dev/null 2>&1; then
  log "antseed not found on PATH — nothing to do"
  [ "$PASS" = "1" ] && exit 0
  emit "antseed not found on PATH."
  exit 0
fi

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  log "$PYTHON not found — the activity JSON cannot be parsed"
  [ "$PASS" = "1" ] && exit 0
  emit "$PYTHON not found; the reaper needs it to read the activity JSON."
  exit 0
fi

# --- single-flight -----------------------------------------------------------
# A slow pass overlapping the next timer tick must not double-close, so hold a
# lock for the whole run. flock is present on these images; without it, skip the
# safety rather than the work (the close path is idempotent anyway: a second
# close on an already-settled channel just errors and is logged).
if [ "$PASS" = "1" ] || [ "$PASS" = "0" ]; then
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE" || exit 0
    if ! flock -n 9; then
      [ "$PASS" = "0" ] && emit "another pass is running (lock held)"
      exit 0
    fi
  fi
fi

NOW_MS="$(date +%s)000"

if [ -f "$PAUSE_FILE" ]; then
  log "paused ($PAUSE_FILE) — no action"
  emit "PAUSED ($PAUSE_FILE): nothing will be closed."
fi

# --- read the buyer's channel activity --------------------------------------
ACTIVITY="$(mktemp)"
trap 'rm -f "$ACTIVITY"' EXIT
if ! "$ANTSEED" buyer activity --json >"$ACTIVITY" 2>/dev/null; then
  log "could not read 'antseed buyer activity --json' — skipping this pass"
  [ "$PASS" = "1" ] && exit 0
fi
if [ ! -s "$ACTIVITY" ]; then
  log "empty activity output — skipping this pass"
  [ "$PASS" = "1" ] && exit 0
  emit "The buyer reported no activity data (is the daemon running?)."
  exit 0
fi

# --- decide -----------------------------------------------------------------
# One planner in python: JSON + epoch arithmetic in shell is where this would
# otherwise rot. It prints a JSON plan and rewrites the state file.
PLAN="$(
  NOW_MS="$NOW_MS" \
    IDLE_SECONDS="$IDLE_SECONDS" \
    MAX_CLOSES_PER_RUN="$MAX_CLOSES_PER_RUN" \
    CLOSE_RETRY_SECONDS="$CLOSE_RETRY_SECONDS" \
    STATE_FILE="$STATE_FILE" \
    PAUSED="$([ -f "$PAUSE_FILE" ] && echo 1 || echo 0)" \
    "$PYTHON" - "$ACTIVITY" <<'PY' 2>/dev/null
import json, os, sys, time

path = sys.argv[1]
now_ms = int(os.environ["NOW_MS"])
idle_seconds = int(os.environ["IDLE_SECONDS"])
max_closes = int(os.environ["MAX_CLOSES_PER_RUN"])
retry_seconds = int(os.environ["CLOSE_RETRY_SECONDS"])
state_file = os.environ["STATE_FILE"]
paused = os.environ["PAUSED"] == "1"

try:
    with open(path) as fh:
        doc = json.load(fh)
except Exception as exc:
    print(json.dumps({"error": f"unparseable activity json: {exc}"}))
    sys.exit(0)

try:
    with open(state_file) as fh:
        state = json.load(fh)
except Exception:
    state = {}
if not isinstance(state, dict):
    state = {}

def as_int(value):
    try:
        return int(str(value).strip())
    except Exception:
        return None

channels = doc.get("channels") or []
active, idle, planned, skipped, dropped = [], [], [], [], []
seen = set()

for chan in channels:
    cid = chan.get("channelId")
    if not cid:
        continue
    seen.add(cid)
    status = str(chan.get("status") or "")
    peer = chan.get("peerId") or chan.get("seller") or "?"
    name = chan.get("sellerDisplayName") or ""
    tokens_in = as_int(chan.get("inputTokens")) or 0
    tokens_out = as_int(chan.get("outputTokens")) or 0
    tokens = tokens_in + tokens_out
    requests = as_int(chan.get("requestCount"))
    signed = as_int(chan.get("cumulativeSigned"))

    entry = state.get(cid) or {}
    # A counter change since the last pass is activity *now*, whatever the
    # channel's own stamp says.
    changed = (
        entry.get("tokens") is not None
        and (entry.get("tokens") != tokens or entry.get("requests") != requests or entry.get("signed") != signed)
    )
    last_change_at = now_ms if changed else entry.get("lastChangeAt")

    # The channel's own updatedAt is authoritative when it is available and newer
    # than anything this script observed (it can also be bumped by non-token
    # events, hence the max() rather than a replacement).
    updated_at = as_int(chan.get("updatedAt"))
    stamps = [s for s in (last_change_at, updated_at) if isinstance(s, int) and s > 1_000_000_000_000]
    activity_at = max(stamps) if stamps else now_ms

    idle_ms = max(0, now_ms - activity_at)
    info = {
        "id": cid,
        "peer": peer,
        "name": name,
        "status": status,
        "tokens": tokens,
        "requests": requests,
        "idleSeconds": idle_ms // 1000,
        "updatedAt": updated_at,
        "onChainStatus": chan.get("onChainStatus"),
    }
    if status == "active":
        active.append(info)
    else:
        # not closable by definition; keep no history for it
        dropped.append(cid)
        continue

    last_attempt = entry.get("lastAttemptAt")
    recently_attempted = isinstance(last_attempt, int) and (now_ms - last_attempt) < retry_seconds * 1000

    if idle_ms // 1000 >= idle_seconds and not recently_attempted:
        planned.append(info)
    elif idle_ms // 1000 >= idle_seconds:
        info["reason"] = f"close attempt {(now_ms - last_attempt) // 1000}s ago (retry window {retry_seconds}s)"
        skipped.append(info)
    else:
        info["reason"] = f"idle {info['idleSeconds']}s < {idle_seconds}s"
        skipped.append(info)

    state[cid] = {
        "tokens": tokens,
        "requests": requests,
        "signed": signed,
        "lastChangeAt": activity_at,
        "lastSeenAt": now_ms,
        "attempts": entry.get("attempts", 0),
        "lastAttemptAt": entry.get("lastAttemptAt"),
        "peer": peer,
    }

# Forget channels the buyer no longer tracks: they were closed, settled or
# withdrawn, which is exactly the outcome this script exists to produce.
for cid in list(state.keys()):
    if cid not in seen:
        del state[cid]

planned.sort(key=lambda c: c["idleSeconds"], reverse=True)
to_close = [] if paused else planned[:max_closes]
for c in planned[max_closes:]:
    c["reason"] = "queued behind MAX_CLOSES_PER_RUN; next pass"
    skipped.append(c)

try:
    tmp = state_file + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, state_file)
except Exception as exc:
    print(json.dumps({"error": f"could not write state: {exc}"}))
    sys.exit(0)

print(json.dumps({
    "active": active,
    "idle_since_threshold": [c for c in active if c["idleSeconds"] >= idle_seconds],
    "close": to_close,
    "skipped": skipped,
    "dropped": dropped,
    "idle_seconds": idle_seconds,
}))
PY
)"

if [ -z "$PLAN" ]; then
  log "planner produced nothing — skipping this pass"
  [ "$PASS" = "1" ] && exit 0
  emit "Could not plan (activity JSON unreadable)."
  exit 0
fi
case "$PLAN" in
  *'"error"'*)
    log "planner error: $(printf '%s' "$PLAN" | head -c 300)"
    [ "$PASS" = "1" ] && exit 0
    emit "Planner error — see $LOG_FILE"
    exit 0
    ;;
esac

# --- status output -----------------------------------------------------------
if [ "$PASS" = "0" ]; then
  printf '%s' "$PLAN" | "$PYTHON" -c '
import json, sys
p = json.load(sys.stdin)
n = p["idle_seconds"]
print("idle threshold: %ss (%s min)" % (n, n // 60))
print("active channels: %d | over threshold: %d | would close now: %d" % (
    len(p["active"]), len(p["idle_since_threshold"]), len(p["close"])))
ids = {c["id"] for c in p["close"]}
for c in p["active"]:
    flag = "CLOSE" if c["id"] in ids else ("idle" if c["idleSeconds"] >= n else "ok")
    print("  %s...  %-5s idle %dm%02ds  tokens %-9s requests %s  %s" % (
        c["id"][:18], flag, c["idleSeconds"] // 60, c["idleSeconds"] % 60,
        c["tokens"], c["requests"], c["name"] or c["peer"]))
for s in p["skipped"]:
    print("    skipped %s...: %s" % (s["id"][:18], s.get("reason", "")))
for d in p["dropped"]:
    print("    not active (untouched): %s..." % d[:18])
'
  exit 0
fi

# --- notify ------------------------------------------------------------------
# One throttled message per outcome kind: a long-idle estate should not turn into
# a mail storm just because the timer runs every couple of minutes.
notify() {
  local kind="$1" cid="$2" peer="$3" idle="$4" tokens="$5" detail="$6"
  local last now_ts
  now_ts="$(date +%s)"
  last="$(cat "$STATE_DIR/last-notified-$kind" 2>/dev/null || echo 0)"
  [ $((now_ts - last)) -lt "$NOTIFY_MIN_INTERVAL" ] && return 0
  printf '%s\n' "$now_ts" >"$STATE_DIR/last-notified-$kind" 2>/dev/null
  if command -v tribes-notify >/dev/null 2>&1; then
    tribes-notify --message "Antseed channel $(printf '%s' "$cid" | cut -c1-14)… $kind after $((idle / 60)) min idle (peer $peer)" \
      --key "channel-reaper-$kind" --label "Antseed channel" >/dev/null 2>&1 &&
      log "notified (push, $kind)" || log "tribes-notify failed ($kind)"
  fi
  if [ -n "$NOTIFY_TO" ] && command -v tribes-email >/dev/null 2>&1; then
    tribes-email send "$NOTIFY_TO" "[zipbox] Antseed channel $kind ($((idle / 60)) min idle)" \
      --body "channel-reaper acted on $(hostname).

  channel:  $cid
  peer:     $peer
  idle for: $((idle / 60)) min (threshold $((IDLE_SECONDS / 60)) min)
  tokens:   $tokens
  action:   $ACTION
  result:   $kind

  $detail

Closing a channel asks its seller to settle now, which returns the reserve to your
spendable balance. The counters in 'antseed buyer activity --json' are the authority:
a channel is only closed after its token and request counters stop moving.

-- channel-reaper on $(hostname)" >/dev/null 2>&1 &&
      log "notified (email, $kind -> $NOTIFY_TO)" || log "tribes-email failed ($kind)"
  fi
  return 0
}

# --- act ---------------------------------------------------------------------
CLOSED=0
FAILED=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  CID="$(printf '%s' "$line" | cut -d' ' -f1)"
  IDLE="$(printf '%s' "$line" | cut -d' ' -f2)"
  TOKENS="$(printf '%s' "$line" | cut -d' ' -f3)"
  PEER="$(printf '%s' "$line" | cut -d' ' -f4-)"

  if [ "$ACTION" = "notify" ]; then
    log "IDLE CHANNEL (notify only): $CID peer=$PEER idle=${IDLE}s tokens=$TOKENS"
    notify "idle" "$CID" "$PEER" "$IDLE" "$TOKENS" "would close (ACTION=notify)"
    CLOSED=$((CLOSED + 1))
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY RUN: would run '$ANTSEED buyer channels $ACTION $CID' (peer=$PEER idle=${IDLE}s tokens=$TOKENS)"
    CLOSED=$((CLOSED + 1))
    continue
  fi

  OUT="$("$ANTSEED" buyer channels "$ACTION" "$CID" 2>&1)"
  RC=$?
  if [ "$RC" = "0" ]; then
    log "closed idle channel $CID (peer=$PEER idle=${IDLE}s tokens=$TOKENS): $(printf '%s' "$OUT" | tr '\n' ' ' | head -c 200)"
    notify "closed" "$CID" "$PEER" "$IDLE" "$TOKENS" "$OUT"
    CLOSED=$((CLOSED + 1))
  else
    log "FAILED to close $CID (peer=$PEER idle=${IDLE}s): $(printf '%s' "$OUT" | tr '\n' ' ' | head -c 300)"
    FAILED=$((FAILED + 1))
  fi
  # Record the attempt whether or not it worked, so the retry window applies.
  "$PYTHON" - "$STATE_FILE" "$CID" "$NOW_MS" <<'PY' 2>/dev/null
import json, os, sys
path, cid, now = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    with open(path) as fh:
        state = json.load(fh)
except Exception:
    state = {}
entry = state.get(cid)
if isinstance(entry, dict):
    entry["lastAttemptAt"] = now
    entry["attempts"] = int(entry.get("attempts") or 0) + 1
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, path)
PY
done < <(printf '%s' "$PLAN" | "$PYTHON" -c '
import json, sys
p = json.load(sys.stdin)
for c in p["close"]:
    print(c["id"], c["idleSeconds"], c["tokens"], c["name"] or c["peer"])
')

log "pass done: closed=$CLOSED failed=$FAILED (ACTION=$ACTION, threshold=${IDLE_SECONDS}s)"
exit 0
