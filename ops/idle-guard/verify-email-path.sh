#!/usr/bin/env bash
# Verification for the updated idle-guard: hold/release, re-arm, and the
# email-on-idle path. Runs entirely in a scratch state dir with a stubbed
# tribes-email, so it cannot send real mail; the last step does one real send.
set -uo pipefail
GUARD=/usr/local/bin/idle-guard.sh

echo "=== 1. syntax ==="
bash -n "$GUARD" && echo "bash -n: OK"
if command -v shellcheck >/dev/null 2>&1; then shellcheck -S warning "$GUARD" && echo "shellcheck: OK"; else echo "shellcheck: not installed (skipped)"; fi

echo
echo "=== 2. --help ==="
"$GUARD" --help

echo
echo "=== 3. real status (live box) ==="
"$GUARD" --status

echo
echo "=== 4. hold / release ==="
"$GUARD" --release
"$GUARD" --hold
"$GUARD" --status | grep -E "^(state|keepalive)"
"$GUARD" --release
"$GUARD" --status | grep -E "^(state|keepalive)"

echo
echo "=== 5. idle -> notify path with a stubbed mailer ==="
STUB=/tmp/ig-stub
rm -rf "$STUB" /tmp/igtest; mkdir -p "$STUB" /tmp/igtest
cat >"$STUB/tribes-email" <<'EOF'
#!/usr/bin/env bash
# Capture only: the guard passes the body as --body, so never read stdin here
# (a bare `cat` blocks forever on the inherited stdin and hangs the run).
{ printf 'ARGS: %s\n' "$*"; echo "BODY-END"; } >>/tmp/igtest/email-captured.txt
EOF
cat >"$STUB/tribes-notify" <<'EOF'
#!/usr/bin/env bash
printf 'NOTIFY: %s\n' "$*" >>/tmp/igtest/notify-captured.txt
EOF
chmod +x "$STUB"/*

# force the idle branch: threshold 0, own state dir, empty config, stubbed mailer
env -i PATH="$STUB:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" HOME=/root \
  IDLE_GUARD_CONFIG=/dev/null IDLE_SECONDS=0 NOTIFY_TO=you@example.com \
  STATE_DIR=/tmp/igtest LOG_FILE=/tmp/igtest/log \
  "$GUARD" >/tmp/igtest/stdout.txt 2>&1
echo "exit=$? (first run only starts the baseline clock)"
env -i PATH="$STUB:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" HOME=/root \
  IDLE_GUARD_CONFIG=/dev/null IDLE_SECONDS=0 NOTIFY_TO=you@example.com \
  STATE_DIR=/tmp/igtest LOG_FILE=/tmp/igtest/log \
  KEEPALIVE_FILE=/tmp/igtest/keepalive "$GUARD" >/tmp/igtest/stdout2.txt 2>&1
echo "exit=$? (threshold 0 -> should act)"
echo "--- log ---"; cat /tmp/igtest/log
echo "--- notify captured ---"; cat /tmp/igtest/notify-captured.txt 2>/dev/null
echo "--- email captured ---"; cat /tmp/igtest/email-captured.txt 2>/dev/null

echo
echo "=== 6. re-arm check (second idle stretch must notify again) ==="
rm -f /tmp/igtest/last-notified /tmp/igtest/keepalive
env -i PATH="$STUB:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" HOME=/root \
  IDLE_GUARD_CONFIG=/dev/null IDLE_SECONDS=0 NOTIFY_TO=you@example.com \
  STATE_DIR=/tmp/igtest LOG_FILE=/tmp/igtest/log KEEPALIVE_FILE=/tmp/igtest/keepalive \
  "$GUARD" >/dev/null 2>&1
ENV="env -i PATH=$STUB:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root"
# busy here (this ssh session is running) -> snapshot written, notify re-armed
env -i PATH="$STUB:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" HOME=/root \
  IDLE_GUARD_CONFIG=/dev/null IDLE_SECONDS=0 NOTIFY_TO=you@example.com \
  STATE_DIR=/tmp/igtest LOG_FILE=/tmp/igtest/log KEEPALIVE_FILE=/tmp/igtest/keepalive \
  "$GUARD" >/dev/null 2>&1
echo "last-notified after a busy run: $([ -f /tmp/igtest/last-notified ] && echo 'still set (NOT re-armed)' || echo 'cleared (re-armed)')"
echo "emails captured so far: $(grep -c '^ARGS:' /tmp/igtest/email-captured.txt 2>/dev/null || echo 0)"

echo
echo "=== 7. one real send through the new body (tribes-email as it ships) ==="
tribes-email send "$NOTIFY_TO_REAL" "[zipbox] $(hostname) — idle-guard email test (not idle: this is a verification run)" \
  --body "Verification of the idle-guard email path after the hold/release + re-arm change.

If you are reading this, the exact command idle-guard uses to email you works with the new body format. Nothing is paused by the guard; it only notifies.

-- idle-guard verification on $(hostname)" && echo "tribes-email: OK" || echo "tribes-email: FAILED"
