#!/usr/bin/env bash
# install.sh — put freepi-panel on this box.
#
#   ./install.sh              install + start on loopback only (127.0.0.1)
#   ./install.sh --no-start   install the files, leave the service stopped
#
# Idempotent. It never overwrites an existing token or /etc/default/freepi-panel,
# so re-running it after an update keeps your sign-in and configuration.
#
# The panel is loopback-only by design: publishing it to the internet is a
# separate, deliberate step (see README.md).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=freepi-panel
TARGET="/usr/local/share/$NAME"
CONF_DIR=/etc/freepi-panel
ENV_FILE="/etc/default/$NAME"
START=1
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    *) echo "unknown option: $arg (use --no-start)" >&2; exit 2 ;;
  esac
done

command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found — this installer expects systemd" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || {
  echo "bun not found on PATH. On these sandboxes it is /opt/zipbox/bin/bun; add its directory to PATH." >&2
  exit 1
}

echo "== files =="
install -d -m 0755 "$TARGET" "$TARGET/public"
install -m 0644 "$HERE/server.ts" "$TARGET/server.ts"
install -m 0644 "$HERE/public/index.html" "$TARGET/public/index.html"
install -m 0644 "$HERE/README.md" "$TARGET/README.md"
echo "  $TARGET/{server.ts,public/index.html}"

echo "== token =="
install -d -m 0700 "$CONF_DIR"
if [ -s "$CONF_DIR/token" ]; then
  echo "  keeping the existing $CONF_DIR/token"
else
  # The token is the only thing standing between the internet and a shell on
  # this box, so it is 32 random bytes, 0600, and never printed by this script.
  head -c 32 /dev/urandom | base64 | tr -d '\n' >"$CONF_DIR/token"
  chmod 600 "$CONF_DIR/token"
  echo "  wrote a new token to $CONF_DIR/token (read it with: cat $CONF_DIR/token)"
fi

echo "== config =="
if [ -f "$ENV_FILE" ]; then
  echo "  keeping existing $ENV_FILE"
else
  # Discover how to start freepi, and which projects to offer for new sessions.
  FREEPI_CMD_DEFAULT="bun run /root/workspace/freepi-plus/free-pi-cli/src/index.ts"
  for candidate in /root/workspace/*/free-pi-cli/src/index.ts /root/*/free-pi-cli/src/index.ts; do
    [ -f "$candidate" ] && { FREEPI_CMD_DEFAULT="bun run $candidate"; break; }
  done
  PROJECTS="$(ls -d /root/workspace/*/ 2>/dev/null | sed 's:/$::' | paste -sd, - || true)"

  cat >"$ENV_FILE" <<EOF
# /etc/default/freepi-panel — config for the freepi web panel.
# Edited by hand; restart the service after changes: systemctl restart $NAME

# Bind address and port. Loopback on purpose: the public route is added later
# with tribes-caddy (which terminates TLS) — see README.md.
PANEL_HOST=127.0.0.1
PANEL_PORT=8787
PANEL_TOKEN_FILE=$CONF_DIR/token

# Where session transcripts live, and where the RPC bridge is told to look.
PANEL_SESSION_ROOT=/root/.freepi-placeholder
PANEL_FREEPI_CMD=$FREEPI_CMD_DEFAULT
PANEL_PROJECTS=$PROJECTS

# Balance is read from the Antseed CLI; it is cached this long (ms).
PANEL_BALANCE_TTL_MS=60000
PANEL_IDLE_GUARD=/usr/local/bin/idle-guard.sh
EOF
  # The session root is per-user; fill in the real one.
  sed -i "s#PANEL_SESSION_ROOT=.*#PANEL_SESSION_ROOT=/root/.free-pi/agent/sessions#" "$ENV_FILE"
  echo "  wrote $ENV_FILE"
  echo "  freepi command: $FREEPI_CMD_DEFAULT"
fi

echo "== service =="
install -m 0644 "$HERE/$NAME.service" "/etc/systemd/system/$NAME.service"
systemctl daemon-reload
if systemd-analyze verify "/etc/systemd/system/$NAME.service" 2>&1 | grep -q "Refusing"; then
  echo "ERROR: systemd refuses the unit (see systemd-analyze verify above)" >&2
  exit 1
fi

if [ "$START" = "1" ]; then
  systemctl enable --now "$NAME.service"
  sleep 1
  systemctl --no-pager --lines=0 status "$NAME.service" | head -5 || true
else
  echo "  installed, not started (--no-start)"
fi

cat <<EOF

Check it:
  systemctl status $NAME --no-pager
  curl -s localhost:8787/healthz
  tail -f /var/log/$NAME.log

Sign in as the owner (the token is the password):
  cat $CONF_DIR/token

Publish it to your phone (deliberate, public step — see README.md):
  tribes-dns expose freepi
  tribes-caddy add freepi.\$(tribes-dns list | sed -n 's/^apex: //p').sh 127.0.0.1:8787

Stop / uninstall:
  systemctl disable --now $NAME.service
  # config, token and logs are left in place on purpose:
  #   $ENV_FILE  $CONF_DIR/token  /var/log/$NAME.log
EOF
