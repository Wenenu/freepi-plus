#!/usr/bin/env bash
# Focused follow-up: (a) is a remote shell actually detected as a busy signal on
# this box? (b) does a busy run re-arm the idle notification?
set -uo pipefail
GUARD=/usr/local/bin/idle-guard.sh
STUB=/tmp/ig-stub
rm -rf /tmp/igt2; mkdir -p /tmp/igt2

echo "=== a. what does a remote shell look like here? ==="
ps -eo pid,ppid,etime,cmd | grep -Ei "sshd|chisel|pty" | grep -v grep | head -10
echo "guard's session pattern matches:"
pgrep -af 'sshd: root@|ssh: root@' || echo "  (nothing -- so a plain ssh call is NOT detected on this box)"

echo
echo "=== b. re-arm: a busy run must clear last-notified ==="
: >/tmp/igt2/keepalive
printf '1111\n' >/tmp/igt2/last-notified
env -i PATH="$STUB:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" HOME=/root \
  IDLE_GUARD_CONFIG=/dev/null IDLE_SECONDS=0 STATE_DIR=/tmp/igt2 LOG_FILE=/tmp/igt2/log \
  KEEPALIVE_FILE=/tmp/igt2/keepalive "$GUARD" >/tmp/igt2/out 2>&1
echo "guard saw: $(grep -E '^(state|busy)' /tmp/igt2/log | tail -1)"
echo "log: $(tail -3 /tmp/igt2/log)"
if [ -f /tmp/igt2/last-notified ]; then
  echo "RESULT: last-notified still present -> NOT re-armed (unexpected)"
else
  echo "RESULT: last-notified cleared -> re-armed (a new idle stretch will notify again)"
fi

echo
echo "=== c. and an idle run at that point notifies again ==="
rm -f /tmp/igt2/keepalive
env -i PATH="$STUB:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" HOME=/root \
  IDLE_GUARD_CONFIG=/dev/null IDLE_SECONDS=0 NOTIFY_TO=you@example.com STATE_DIR=/tmp/igt2 \
  LOG_FILE=/tmp/igt2/log KEEPALIVE_FILE=/tmp/igt2/keepalive "$GUARD" >/dev/null 2>&1
echo "emails captured: $(grep -c '^ARGS:' /tmp/igtest/email-captured.txt 2>/dev/null || echo 0) (was 2 before this run)"

echo
echo "=== d. hold is back on ==="
"$GUARD" --hold
"$GUARD" --status
