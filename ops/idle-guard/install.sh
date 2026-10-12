#!/usr/bin/env bash
# install.sh — put the idle guard on this sandbox.
#
#   ./install.sh                 install files, leave the timer disabled
#   ./install.sh --enable        install and start the timer
#   ./install.sh --poweroff      (implies --enable) also let it power the box off
#
# Idempotent: an existing /etc/default/idle-guard is never overwritten.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UNIT="idle-guard"
ENABLE=0
POWEROFF=0
for arg in "$@"; do
  case "$arg" in
    --enable) ENABLE=1 ;;
    --poweroff) ENABLE=1; POWEROFF=1 ;;
    *)
      echo "unknown option: $arg (use --enable / --poweroff)" >&2
      exit 2
      ;;
  esac
done

command -v systemctl >/dev/null 2>&1 || {
  echo "systemctl not found — this installer expects systemd" >&2
  exit 1
}

# An earlier version of this guard installed itself as zipbox-idle-guard.*, which
# this sandbox's prefix-scoped drop-in breaks: any zipbox-* unit gets
# Restart=always, and systemd refuses that with Type=oneshot, so it never loads.
# Clean that up if it's lying around.
for legacy in zipbox-idle-guard.service zipbox-idle-guard.timer; do
  if [ -e "/etc/systemd/system/$legacy" ]; then
    systemctl disable --now "$legacy" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$legacy"
    echo "removed legacy unit /etc/systemd/system/$legacy (zipbox-* units can't be oneshot)"
  fi
done
rm -rf /var/lib/zipbox-idle-guard

install -m 0755 "$HERE/idle-guard.sh" "/usr/local/bin/$UNIT.sh"
install -m 0644 "$HERE/$UNIT.service" "/etc/systemd/system/$UNIT.service"
install -m 0644 "$HERE/$UNIT.timer" "/etc/systemd/system/$UNIT.timer"
mkdir -p "/usr/local/share/$UNIT" "/var/lib/$UNIT"
install -m 0644 "$HERE/README.md" "/usr/local/share/$UNIT/README.md"

if [ -f "/etc/default/$UNIT" ]; then
  echo "keeping existing /etc/default/$UNIT"
else
  install -m 0644 "$HERE/idle-guard.default" "/etc/default/$UNIT"
fi

if [ "$POWEROFF" = "1" ]; then
  # Opt-in, and only after confirming with zipbox that a powered-off sandbox can
  # be booted again from the dashboard — see README.md.
  sed -i 's/^ACTIONS=.*/ACTIONS=notify,poweroff/' "/etc/default/$UNIT"
  echo "!! ACTIONS set to 'notify,poweroff': this sandbox will shut itself down"
  echo "!! when idle. Confirm the dashboard can boot it again first."
fi

systemctl daemon-reload
if systemd-analyze verify "/etc/systemd/system/$UNIT.service" 2>&1 | grep -q Refusing; then
  echo "ERROR: systemd refuses the unit (see systemd-analyze verify output above)" >&2
  exit 1
fi
if [ "$ENABLE" = "1" ]; then
  systemctl enable --now "$UNIT.timer"
  echo "timer enabled:"
  systemctl list-timers "$UNIT.timer" --no-pager | head -3
else
  echo "files installed, timer NOT enabled (re-run with --enable to start it)"
fi

cat <<EOF

Check it (safe, changes nothing):
  $UNIT.sh --status

First real run by the timer is ~10 minutes after boot, then every 5 minutes.
Log:   tail -f /var/log/$UNIT.log
Stop:  systemctl disable --now $UNIT.timer
EOF
