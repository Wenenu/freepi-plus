#!/usr/bin/env bash
# install.sh — put the freepi swarm on this box.
#
#   ./install.sh              install files + the `swarm` CLI, leave the service stopped
#   ./install.sh --enable     install and start the UI service
#   ./install.sh --state DIR  use DIR for the bus (default /var/lib/freepi-swarm)
#
# Idempotent. It never overwrites an existing token or /etc/default/freepi-swarm,
# and it never turns the switch on: a box with this installed deploys nothing
# until someone runs `swarm on` (or flips the switch in the UI).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=freepi-swarm
TARGET="/usr/local/share/$NAME"
CONF_DIR=/etc/$NAME
ENV_FILE="/etc/default/$NAME"
STATE_DIR=/var/lib/$NAME
ENABLE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --enable) ENABLE=1; shift ;;
    --state) STATE_DIR="${2:?--state needs a directory}"; shift 2 ;;
    --state=*) STATE_DIR="${1#*=}"; shift ;;
    *) echo "unknown option: $1 (use --enable [--state DIR])" >&2; exit 2 ;;
  esac
done

command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found — this installer expects systemd" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || {
  echo "bun not found on PATH. On these sandboxes it is /opt/zipbox/bin/bun; add its directory to PATH." >&2
  exit 1
}

echo "== files =="
install -d -m 0755 "$TARGET" "$TARGET/roles" "$TARGET/public"
install -m 0644 "$HERE/swarm.ts" "$TARGET/swarm.ts"
install -m 0644 "$HERE/public/index.html" "$TARGET/public/index.html"
install -m 0644 "$HERE/README.md" "$TARGET/README.md"
for role in "$HERE"/roles/*.md; do install -m 0644 "$role" "$TARGET/roles/$(basename "$role")"; done
echo "  $TARGET/{swarm.ts,public/index.html,roles/}"

echo "== the swarm CLI (what agents run from bash) =="
# A tiny wrapper, because `swarm send ...` from an agent's bash is the whole
# coordination interface — it must be on PATH and must not need the state dir as
# an argument. $SWARM_STATE_DIR is exported by the unit, so this wrapper reads
# nothing else.
cat >/usr/local/bin/swarm <<EOF
#!/bin/sh
# installed by ops/agent-swarm/install.sh — see $TARGET/README.md
exec bun run "$TARGET/swarm.ts" "\$@"
EOF
chmod 0755 /usr/local/bin/swarm
echo "  /usr/local/bin/swarm"

echo "== state + token =="
install -d -m 0700 "$STATE_DIR"
install -d -m 0700 "$CONF_DIR"
if [ -s "$CONF_DIR/token" ]; then
  echo "  keeping the existing $CONF_DIR/token"
else
  head -c 32 /dev/urandom | base64 | tr -d '\n' >"$CONF_DIR/token"
  chmod 600 "$CONF_DIR/token"
  echo "  wrote a new token to $CONF_DIR/token (read it with: cat $CONF_DIR/token)"
fi

echo "== config =="
if [ -f "$ENV_FILE" ]; then
  echo "  keeping existing $ENV_FILE"
else
  install -m 0644 "$HERE/swarm.default" "$ENV_FILE"
  sed -i "s#^SWARM_STATE_DIR=.*#SWARM_STATE_DIR=$STATE_DIR#" "$ENV_FILE"
  echo "  wrote $ENV_FILE"
fi

echo "== config.json (the switch — starts OFF) =="
if [ -f "$STATE_DIR/config.json" ]; then
  echo "  keeping existing $STATE_DIR/config.json"
else
  SWARM_STATE_DIR="$STATE_DIR" bun run "$TARGET/swarm.ts" status >/dev/null 2>&1 || true
  echo "  defaults written on first use: enabled=false, maxWorkers=\${SWARM_MAX_WORKERS:-3}"
fi

echo "== service =="
install -m 0644 "$HERE/$NAME.service" "/etc/systemd/system/$NAME.service"
systemctl daemon-reload
if systemd-analyze verify "/etc/systemd/system/$NAME.service" 2>&1 | grep -q Refusing; then
  echo "ERROR: systemd refuses the unit (see systemd-analyze verify output above)" >&2
  exit 1
fi

if [ "$ENABLE" = "1" ]; then
  systemctl enable --now "$NAME.service"
  sleep 1
  systemctl --no-pager --lines=0 status "$NAME.service" | head -5 || true
else
  echo "  installed, not started (--enable to start the UI)"
fi

cat <<EOF

Nothing is deployed yet: the switch is OFF.

Turn it on, and watch what happens:
  swarm status                 # switch, slots, roster, board, claims, unread mail
  swarm on                     # allow deployment (the UI switch does the same)
  swarm task add --title "audit api.example.com /v2" --role hunter --scope api.example.com/v2
  swarm spawn --name scout --role recon --cwd /root/workspace/target

Talk to a session from anywhere (no daemon needed for this at all):
  swarm roster
  swarm send --to scout "check the staging host too"
  swarm inbox                  # inside a freepi session, via bash

The UI (token is the password; never printed by this script):
  cat $CONF_DIR/token
  curl -s localhost:8790/healthz
  # from your phone, deliberately: tribes-caddy add swarm.<apex> 127.0.0.1:8790

Stop the workers, keep the switch as it is (always allowed, even when OFF):
  swarm down --all
  swarm reap                   # free slots whose supervisor died

Stop / uninstall:
  systemctl disable --now $NAME.service
  # state, token and config are left in place on purpose:
  #   $STATE_DIR  $ENV_FILE  $CONF_DIR/token  /var/log/$NAME.log
EOF
