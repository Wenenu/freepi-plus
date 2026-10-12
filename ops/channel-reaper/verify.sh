#!/usr/bin/env bash
# verify.sh — prove the reaper's decisions without touching a real channel.
#
# Everything runs against a stubbed `antseed` (and stubbed notify binaries), so a
# passing run cannot close a channel or send mail. Each case writes the channel
# activity the buyer would report, runs one pass, and asserts on what the stub
# was asked to do.
set -uo pipefail

REAPER="${REAPER:-/usr/local/bin/channel-reaper.sh}"
STUB=/tmp/cr-stub
STATE=/tmp/cr-test
ACT="$STATE/activity.json"
CLOSES="$STATE/closes.txt"
NOTIFY="$STATE/notify.txt"
EMAIL="$STATE/email.txt"
pass=0; fail=0
ok()  { echo "  PASS  $*"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $*"; fail=$((fail + 1)); }
closes() { [ -f "$CLOSES" ] && wc -l <"$CLOSES" | tr -d ' ' || echo 0; }

if [ ! -x "$REAPER" ]; then
  echo "reaper not installed at $REAPER — run ./install.sh first (or set REAPER=…)" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
mkdir -p "$STUB"
cat >"$STUB/antseed" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "buyer" ] && [ "${2:-}" = "activity" ]; then
  [ -n "${STUB_ACTIVITY:-}" ] && [ -f "$STUB_ACTIVITY" ] && cat "$STUB_ACTIVITY"
  exit "${STUB_ACTIVITY_RC:-0}"
fi
if [ "${1:-}" = "buyer" ] && [ "${2:-}" = "channels" ] && { [ "${3:-}" = "close" ] || [ "${3:-}" = "request-close" ]; }; then
  echo "$4" >> "${STUB_CLOSES:?}"
  echo "Close requested for channel $4"
  exit "${STUB_CLOSE_RC:-0}"
fi
echo "stub antseed: unexpected args: $*" >&2
exit 2
EOF
cat >"$STUB/tribes-notify" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"${STUB_NOTIFY:?}"
EOF
cat >"$STUB/tribes-email" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"${STUB_EMAIL:?}"
EOF
chmod +x "$STUB"/*

write_activity() {
  python3 - "$ACT" "$@" <<'PY'
import json, sys, time
path = sys.argv[1]
now = int(time.time() * 1000)
chans = []
args = sys.argv[2:]
for i in range(0, len(args), 5):
    cid, status, idle_min, tokens, requests = args[i:i + 5]
    bumped = int(idle_min) if idle_min != "none" else 0
    chans.append({
        "channelId": cid,
        "peerId": "peer" + cid[-6:],
        "seller": "0x" + cid[-8:],
        "buyer": "0x25108E51c7ecA58976320117C969cd021D869644",
        "sellerDisplayName": "Seller " + cid[-4:],
        "cumulativeSigned": str(int(tokens)),
        "reservedAt": now - 3_600_000,
        # "none" -> omit the stamp entirely, so only this script's own samples can date it
        "updatedAt": (now - int(bumped) * 60_000) if idle_min != "none" else None,
        "status": status,
        "requestCount": int(requests),
        "inputTokens": str(int(tokens)),
        "outputTokens": "0",
        "lockedBaseUnits": "0",
        "onChainReserveBaseUnits": "1000000",
        "onChainStatus": 1,
    })
json.dump({"deposits": {"available": 1449688, "reserved": 1000000}, "channels": chans}, open(path, "w"))
PY
}

run() {
  env -i PATH="$STUB:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" HOME=/root \
    CHANNEL_REAPER_CONFIG=/dev/null STATE_DIR="$STATE" LOG_FILE="$STATE/log" \
    IDLE_SECONDS="${IDLE_SECONDS:-600}" ACTION="${ACTION:-close}" \
    MAX_CLOSES_PER_RUN="${MAX_CLOSES_PER_RUN:-1}" CLOSE_RETRY_SECONDS="${CLOSE_RETRY_SECONDS:-300}" \
    NOTIFY_TO=you@example.com PAUSE_FILE="$STATE/paused" \
    STUB_ACTIVITY="$ACT" STUB_CLOSES="$CLOSES" STUB_NOTIFY="$NOTIFY" STUB_EMAIL="$EMAIL" \
    STUB_ACTIVITY_RC="${STUB_ACTIVITY_RC:-0}" STUB_CLOSE_RC="${STUB_CLOSE_RC:-0}" \
    "$REAPER" "$@"
}
reset_state() {
  rm -rf "$STATE"; mkdir -p "$STATE"; : >"$CLOSES"; : >"$NOTIFY"; : >"$EMAIL"
  unset IDLE_SECONDS ACTION MAX_CLOSES_PER_RUN CLOSE_RETRY_SECONDS STUB_ACTIVITY_RC STUB_CLOSE_RC
}

echo "=== syntax + help ==="
bash -n "$REAPER" && ok "bash -n" || bad "syntax error"
"$REAPER" --help | grep -q "Usage:" && ok "--help prints usage" || bad "--help"
if command -v shellcheck >/dev/null 2>&1; then shellcheck -S warning "$REAPER" && ok "shellcheck" || bad "shellcheck"; else echo "  skip  shellcheck not installed"; fi

echo
echo "=== 1. an active channel idle past the threshold is closed ==="
reset_state
write_activity 0xaaaa000000000000000000000000000000000000000000000000000000000001 active 11 100 1
run >/dev/null 2>&1
[ "$(closes)" = "1" ] && ok "close issued once" || bad "closes=$(closes) (expected 1)"
grep -q "0xaaaa000000000000000000000000000000000000000000000000000000000001" "$CLOSES" && ok "closed the right channel" || bad "wrong channel id: $(cat "$CLOSES")"
grep -q "closed idle channel" "$STATE/log" && ok "logged the close" || bad "no close in the log"
grep -q "Antseed channel closed" "$EMAIL" && ok "emailed the owner" || bad "no email captured"
grep -q "idle" "$NOTIFY" && ok "pushed a notification" || bad "no push captured"

echo
echo "=== 2. it does not close the same channel again on the next pass ==="
run >/dev/null 2>&1
[ "$(closes)" = "1" ] && ok "still one close (retry window holds)" || bad "closes=$(closes) (expected 1)"

echo
echo "=== 3. a channel that is still active is left alone ==="
reset_state
write_activity 0xbbbb000000000000000000000000000000000000000000000000000000000002 active 1 500 2
run >/dev/null 2>&1
[ "$(closes)" = "0" ] && ok "no close for a 1-minute-idle channel" || bad "closes=$(closes) (expected 0)"

echo
echo "=== 4. a token counter that moved resets the idle clock ==="
reset_state
write_activity 0xcccc000000000000000000000000000000000000000000000000000000000003 active 1 100 1
run >/dev/null 2>&1                # baseline: 100 tokens
write_activity 0xcccc000000000000000000000000000000000000000000000000000000000003 active 30 250 2
run >/dev/null 2>&1                # counters moved 30 minutes "after" an old stamp
[ "$(closes)" = "0" ] && ok "no close: tokens changed since the last pass" || bad "closes=$(closes) (expected 0)"
write_activity 0xcccc000000000000000000000000000000000000000000000000000000000003 active 30 250 2
run >/dev/null 2>&1                # now the counters are still again
[ "$(closes)" = "0" ] && ok "still no close: the stamp is fresh, so it waits out the threshold" || bad "closes=$(closes) (expected 0)"

echo
echo "=== 5. only 'active' channels are considered ==="
reset_state
write_activity 0xdddd000000000000000000000000000000000000000000000000000000000004 settled 120 900 9 \
               0xeeee000000000000000000000000000000000000000000000000000000000005 active 11 42 1
run >/dev/null 2>&1
[ "$(closes)" = "1" ] && ok "one close" || bad "closes=$(closes) (expected 1)"
grep -q "0xdddd" "$CLOSES" && bad "a settled channel was closed" || ok "settled channel untouched"

echo
echo "=== 6. MAX_CLOSES_PER_RUN caps a pass ==="
reset_state
write_activity 0xe111111111111111111111111111111111111111111111111111111111110006 active 25 1 1 \
               0xe222222222222222222222222222222222222222222222222222222222220007 active 12 2 1
run >/dev/null 2>&1
[ "$(closes)" = "1" ] && ok "closed exactly one of two idle channels" || bad "closes=$(closes) (expected 1)"
grep -q "0xe111111111111111111111111111111111111111111111111111111111110006" "$CLOSES" \
  && ok "picked the most idle one" || bad "picked the wrong channel first: $(cat "$CLOSES")"

echo
echo "=== 7. ACTION=notify never calls close ==="
reset_state
ACTION=notify write_activity 0xf111111111111111111111111111111111111111111111111111111111110008 active 40 10 1
ACTION=notify run >/dev/null 2>&1
[ "$(closes)" = "0" ] && ok "no close command" || bad "closed despite ACTION=notify"
grep -q "Antseed channel idle" "$EMAIL" && ok "notified instead" || bad "no idle notification"
unset ACTION

echo
echo "=== 8. --dry-run decides but does not act ==="
reset_state
write_activity 0xf222222222222222222222222222222222222222222222222222222222220009 active 40 10 1
run --dry-run >/dev/null 2>&1
[ "$(closes)" = "0" ] && ok "no close under --dry-run" || bad "closed under --dry-run"
grep -q "DRY RUN: would run" "$STATE/log" && ok "logged the intended action" || bad "dry run not logged"

echo
echo "=== 9. a failing close is logged, backed off, and retried later ==="
reset_state
write_activity 0xf333333333333333333333333333333333333333333333333333333333330010 active 40 10 1
STUB_CLOSE_RC=1 run >/dev/null 2>&1; rc=$?
[ "$rc" = "0" ] && ok "exit status stays 0 (no systemd restart loop)" || bad "exit=$rc"
grep -q "FAILED to close" "$STATE/log" && ok "logged the failure" || bad "failure not logged"
STUB_CLOSE_RC=1 run >/dev/null 2>&1
[ "$(closes)" = "1" ] && ok "no immediate retry: CLOSE_RETRY_SECONDS holds it off" || bad "retried inside the window: $(closes)"
CLOSE_RETRY_SECONDS=0 STUB_CLOSE_RC=1 run >/dev/null 2>&1
[ "$(closes)" = "2" ] && ok "retries once the window has passed" || bad "did not retry after the window: $(closes)"
CLOSE_RETRY_SECONDS=0 run >/dev/null 2>&1
[ "$(closes)" = "3" ] && ok "and closes it as soon as a retry succeeds" || bad "successful retry missing: $(closes)"
unset STUB_CLOSE_RC

echo
echo "=== 10. an unreadable buyer is a skip, not a crash ==="
reset_state
STUB_ACTIVITY_RC=1 run >/dev/null 2>&1; rc=$?
[ "$rc" = "0" ] && ok "exit status 0" || bad "exit=$rc"
grep -q "could not read" "$STATE/log" && ok "logged the skip" || bad "skip not logged"
unset STUB_ACTIVITY_RC

echo
echo "=== 11. --status changes nothing and reports the estate ==="
reset_state
write_activity 0xf444444444444444444444444444444444444444444444444444444444440011 active 30 77 3
run --status >"$STATE/status.out" 2>&1
[ "$(closes)" = "0" ] && ok "no action from --status" || bad "status pass acted"
grep -q "idle threshold: 600s" "$STATE/status.out" && ok "shows the threshold" || bad "threshold missing"
grep -q "0xf444444444444444" "$STATE/status.out" && ok "lists the channel" || bad "channel not listed"
sed -n '1,4p' "$STATE/status.out" | sed 's/^/    /'

echo
echo "=== 12. pause holds everything; resume restores it ==="
reset_state
write_activity 0xf555555555555555555555555555555555555555555555555555555555550012 active 30 5 1
run --pause >/dev/null 2>&1
run >/dev/null 2>&1
[ "$(closes)" = "0" ] && ok "paused: nothing closed" || bad "closed while paused"
run --resume >/dev/null 2>&1
run >/dev/null 2>&1
[ "$(closes)" = "1" ] && ok "resumed: closed again" || bad "did not resume (closes=$(closes))"

echo
echo "=== 13. channels the buyer no longer tracks are forgotten ==="
reset_state
write_activity 0xf666666666666666666666666666666666666666666666666666666666660013 active 30 5 1
run >/dev/null 2>&1
grep -q "0xf666" "$STATE/state.json" && ok "state recorded the channel" || bad "state missing the channel"
write_activity 0xf777777777777777777777777777777777777777777777777777777777770014 active 1 5 1
run >/dev/null 2>&1
grep -q "0xf666" "$STATE/state.json" && bad "stale channel kept in state" || ok "pruned the vanished channel"

echo
echo "=== 14. pass summary in the log ==="
tail -3 "$STATE/log" | sed 's/^/    /'

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
