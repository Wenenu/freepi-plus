#!/usr/bin/env bash
# install.sh — put the Antseed channel reaper on this box.
#
#   ./install.sh              install files, leave the timer disabled
#   ./install.sh --enable     install and start the timer
#
# Idempotent: an existing /etc/default/channel-reaper is never overwritten, so
# re-running after an update keeps your thresholds.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UNIT=channel-reaper
ENABLE=0
for arg in "$@"; do
  case "$arg" in
    --enable) ENABLE=1 ;;
    *) echo "unknown option: $arg (use --enable)" >&2; exit 2 ;;
  esac
done

command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found — this installer expects systemd" >&2; exit 1; }
command -v antseed >/dev/null 2>&1 || {
  echo "warning: 'antseed' is not on PATH — the reaper will log and do nothing until it is." >&2
}
command -v python3 >/dev/null 2>&1 || {
  echo "error: python3 is required (it parses 'antseed buyer activity --json')." >&2
  exit 1
}

install -m 0755 "$HERE/$UNIT.sh" "/usr/local/bin/$UNIT.sh"
install -m 0644 "$HERE/$UNIT.service" "/etc/systemd/system/$UNIT.service"
install -m 0644 "$HERE/$UNIT.timer" "/etc/systemd/system/$UNIT.timer"
mkdir -p "/usr/local/share/$UNIT" "/var/lib/$UNIT"
install -m 0644 "$HERE/README.md" "/usr/local/share/$UNIT/README.md"

if [ -f "/etc/default/$UNIT" ]; then
  echo "keeping existing /etc/default/$UNIT"
else
  install -m 0644 "$HERE/$UNIT.default" "/etc/default/$UNIT"
  echo "wrote /etc/default/$UNIT (IDLE_SECONDS=600, ACTION=close)"
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

This closes Antseed payment channels whose token counters have not moved for
\$((\$(sed -n 's/^IDLE_SECONDS=//p' /etc/default/$UNIT | head -1) / 60)) minutes, which returns their reserve to your spendable
balance. Nothing else on the network is touched; settled channels are ignored.

Look before it acts (safe, changes nothing):
  $UNIT.sh --status
  $UNIT.sh --dry-run

Pause / resume (the reaper keeps watching, just closes nothing):
  $UNIT.sh --pause
  $UNIT.sh --resume

Follow it:
  tail -f /var/log/$UNIT.log
  systemctl list-timers $UNIT.timer

Stop:
  systemctl disable --now $UNIT.timer
EOF
