#!/usr/bin/env bash
# scripts/verify-swarm.sh — end-to-end verification of free-pi's built-in swarm.
#
# This drives the *shipped* code through real processes: `free-pi-cli swarm …`
# deploys a worker, the worker's detached supervisor starts an RPC session, the
# brief is delivered, the worker acts through the same CLI a real agent's bash
# tool would use, it reports a finding on the bus, mail is pushed into its next
# turn, and stopping it releases the scope and the slot it held.
#
# Only the free-pi binary itself is replaced (FREEPI_SWARM_CMD →
# scripts/stub-freepi.ts): no sign-in, no network, no ad-funded allowance spent.
#
# Every spawned process goes through the CLI's own spawn options, which pass
# windowsHide — so this runs headless on Windows too (no console window, nothing
# to alt-tab away from).
#
# Usage: bash scripts/verify-swarm.sh
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }

check() { # check <what> <got> <want>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi
}

check_contains() { # check_contains <what> <haystack> <needle>
  case "$2" in
  *"$3"*) ok "$1" ;;
  *) bad "$1 (missing '$3')" ;;
  esac
}

check_missing() { # check_missing <what> <haystack> <needle>
  case "$2" in
  *"$3"*) bad "$1 (unexpectedly present: '$3')" ;;
  *) ok "$1" ;;
  esac
}

BUN=$(command -v bun || true)
if [ -z "$BUN" ]; then
  echo "bun is not on PATH; the swarm's worker sessions are started with the current runtime" >&2
  exit 1
fi

STUB="$HERE/stub-freepi.ts"

# FREEPI_SWARM_CMD is handed to a native spawn, and under Git Bash/MSYS the paths
# this script sees (`/d/repo/...`) are not Windows paths a process can be started
# from — so the override gets the native form while this script keeps the POSIX
# ones for its own shell.
NATIVE_BUN="$BUN"
NATIVE_STUB="$STUB"
if command -v cygpath >/dev/null 2>&1; then
  NATIVE_BUN=$(cygpath -w "$BUN")
  NATIVE_STUB=$(cygpath -w "$STUB")
fi

case "$BUN$STUB" in
*" "*)
  echo "this checkout's path contains a space, and FREEPI_SWARM_CMD is whitespace-split" >&2
  exit 1
  ;;
esac

WORK=$(mktemp -d)
export FREEPI_SWARM_DIR="$WORK/state"
export STUB_DIR="$WORK/stub"
# Speed the mail push up from its 2s default so the run stays short.
export FREEPI_SWARM_MAIL_POLL_MS=300
export FREEPI_SWARM_CMD="$NATIVE_BUN $NATIVE_STUB"
mkdir -p "$STUB_DIR"

PIDS=""
track() { PIDS="$PIDS $1"; }

cleanup() {
  "$BUN" "$REPO/src/index.ts" swarm stop --all >/dev/null 2>&1
  sleep 1
  # Last resort, so a failed assertion cannot leave a stub session running.
  for pid in $PIDS; do
    kill -9 "$pid" >/dev/null 2>&1
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

sw() { "$BUN" "$REPO/src/index.ts" swarm "$@" 2>&1; }

# wait_for <file> <pattern> <what> — poll a log for a line the stub only writes
# after the real code path delivered something.
wait_for() {
  i=0
  while [ "$i" -lt "${4:-60}" ]; do
    if grep -q "$2" "$1" 2>/dev/null; then
      ok "$3"
      return 0
    fi
    sleep 0.4
    i=$((i + 1))
  done
  bad "$3 (timed out waiting for '$2')"
  return 1
}

wait_until() { # wait_until <what> <max iterations> <command…> — poll until it exits 0
  i=0
  while [ "$i" -lt "$2" ]; do
    if eval "$3" >/dev/null 2>&1; then
      ok "$1"
      return 0
    fi
    sleep 0.4
    i=$((i + 1))
  done
  bad "$1 (timed out)"
  return 1
}

supervisor_pid() { # supervisor_pid <agent>
  grep -o '"supervisorPid": *[0-9]*' "$FREEPI_SWARM_DIR/agents/$1.json" 2>/dev/null | grep -o '[0-9]*$'
}

# Liveness is asked of the runtime, not of this shell: under Git Bash/MSYS
# `kill -0` cannot see a native Windows pid, and a probe that cannot see a live
# process would turn every "it exited" assertion into a false pass.
alive() {
  "$BUN" -e 'try { process.kill(Number(process.argv[1]), 0); } catch (e) { process.exit(e && e.code === "EPERM" ? 0 : 1); }' "$1" >/dev/null 2>&1
}

echo "== the CLI surface"
out=$(sw --help); rc=$?
check "swarm --help exits 0" "$rc" "0"
check_contains "the help lists the surface a worker is told to use" "$out" "swarm send --to NAME"

out=$(sw status); rc=$?
check "status on a fresh state dir exits 0" "$rc" "0"
check_contains "the switch starts OFF" "$out" "switch: OFF"
check_contains "nothing is on the roster yet" "$out" "crew:   none deployed"

out=$(sw spawn --name recon-1 --role recon); rc=$?
check "spawning with the switch off is refused with exit 3" "$rc" "3"
check_contains "and says why" "$out" "switch is OFF"

echo
echo "== the switch, the roster and the board"
sw on >/dev/null
check_contains "swarm on flips the switch" "$(sw status)" "switch: ON"
sw register --name coordinator --role coordinator >/dev/null
check_contains "the coordinator is on the roster" "$(sw roster)" "coordinator"

sw task add --id BB-1 --title "audit /v2/orders" --scope api.example.com/v2 >/dev/null
check_contains "the task is on the board" "$(sw task list)" "BB-1"
check_contains "with its scope" "$(sw task list)" "api.example.com/v2"

echo
echo "== deploying a worker session"
out=$(sw spawn --name recon-1 --role recon --task BB-1); rc=$?
check "spawn exits 0" "$rc" "0"
check_contains "and reports the session it started" "$out" "deployed recon-1 (recon)"
check_contains "with a bound slot" "$out" "slot 0"

wait_until "the worker's roster entry appears" 25 "[ -f '$FREEPI_SWARM_DIR/agents/recon-1.json' ]"
SUP=$(supervisor_pid recon-1)
if [ -n "$SUP" ]; then
  if alive "$SUP"; then
    ok "the supervisor is a live process (pid $SUP)"
  else
    bad "supervisor pid $SUP is not alive"
    printf '     worker log: %s\n' "$(tail -n 3 "$FREEPI_SWARM_DIR/logs/recon-1.log" 2>/dev/null)"
    printf '     roster: %s\n' "$(cat "$FREEPI_SWARM_DIR/agents/recon-1.json" 2>/dev/null)"
  fi
  track "$SUP"
else bad "no supervisor pid was recorded"; fi

echo
echo "== the worker's first turn: the brief"
wait_for "$STUB_DIR/recon-1.log" "You are recon-1" "the brief reached its session"
wait_for "$STUB_DIR/recon-1.log" "session name: swarm:recon:recon-1" "its session is named for the roster"
wait_for "$STUB_DIR/recon-1.log" "swarm spawn --name sibling --role hunter -> 3" "a worker cannot deploy siblings behind the coordinator"
wait_for "$STUB_DIR/recon-1.log" "swarm task claim BB-1 -> 0" "it claimed its task through the CLI"
wait_for "$STUB_DIR/recon-1.log" "swarm claim api.example.com/v2 --ttl 30 -> 0" "it took its scope"
wait_for "$STUB_DIR/recon-1.log" "swarm send --to coordinator --kind finding .*-> 0" "it reported a finding on the bus"
wait_for "$STUB_DIR/recon-1.log" "swarm task done BB-1 --evidence .*-> 0" "it closed the task with evidence"

echo
echo "== the coordinator's view"
out=$(sw inbox --name coordinator)
check_contains "the finding is in the coordinator's inbox" "$out" "IDOR on /v2/orders?tenant=2"
check_contains "as a finding" "$out" "finding"
check_contains "the board shows the closed task" "$(sw task list)" "done"
check_contains "the scope is held by the worker" "$(sw claims)" "recon-1"
check_missing "a second reader of the same message gets nothing" "$(sw inbox --name coordinator)" "IDOR"

echo
echo "== mail is pushed into the worker's next turn"
sw send --to recon-1 --kind question "did you test the export endpoint?" >/dev/null
wait_for "$STUB_DIR/recon-1.log" "did you test the export endpoint" "the question arrived as a turn"
wait_for "$STUB_DIR/recon-1.log" "mail handled: prompt" "and was handled as mail, not as the brief"

echo
echo "== stopping a worker frees what it held"
out=$(sw stop recon-1); rc=$?
check "stop exits 0" "$rc" "0"
wait_until "the worker leaves the live crew" 25 "sw status | grep -q 'none deployed'"
check_contains "its scope went back to the pool" "$(sw claims)" "no scopes are held"
check_contains "its slot was released" "$(sw status)" "slots:  0/"
check_contains "the supervisor reported the release" "$(cat "$FREEPI_SWARM_DIR/logs/recon-1.log")" "released 1 scope(s)"
if [ -n "$SUP" ] && alive "$SUP"; then bad "the supervisor is still running after stop"; else ok "the supervisor exited"; fi
if [ -f "$FREEPI_SWARM_DIR/stop/recon-1" ]; then bad "a stop marker was left behind"; else ok "no stop marker was left behind"; fi
check_contains "reap finds nothing to free" "$(sw reap)" "freed 0 slot(s)"

echo
echo "== one tester per target, across real processes"
sw claim api.example.com/v2 --ttl 5 >/dev/null
out=$(sw spawn --name hunter-2 --role hunter); rc=$?
check "a second worker still deploys" "$rc" "0"
wait_for "$STUB_DIR/hunter-2.log" "swarm claim api.example.com/v2 --ttl 30 -> 4" "the second worker is refused the held scope"
wait_for "$STUB_DIR/hunter-2.log" "held by coordinator" "and is told who holds it"
check_contains "the coordinator still holds it" "$(sw claims)" "coordinator"

echo
echo "== the worker cap is a spend limit, enforced end to end"
sw spawn --name hunter-3 --role hunter >/dev/null
sw spawn --name hunter-4 --role hunter >/dev/null
out=$(sw spawn --name hunter-5 --role hunter); rc=$?
check "the fourth worker is refused with exit 4" "$rc" "4"
check_contains "and the refusal names the limit" "$out" "worker limit reached"
check_contains "the crew is at its limit" "$(sw status)" "slots:  3/3 in use"

echo
echo "== stopping the whole crew"
sw stop --all >/dev/null
wait_until "every worker has exited" 40 "sw status | grep -q 'none deployed'"
check_contains "all three slots are free" "$(sw status)" "slots:  0/3 in use"
for name in hunter-2 hunter-3 hunter-4; do
  pid=$(supervisor_pid "$name")
  if [ -n "$pid" ] && alive "$pid"; then bad "$name's supervisor is still running"; else ok "$name's supervisor exited"; fi
done
check_contains "the coordinator's own claim is still its own to release" "$(sw claims)" "coordinator"
sw release api.example.com/v2 >/dev/null
check_contains "and releasing it empties the pool" "$(sw claims)" "no scopes are held"

echo
echo "== summary"
if [ "$FAIL" -eq 0 ]; then
  printf '%d passed, 0 failed — the swarm works end to end with no sign-in and no allowance spent\n' "$PASS"
  exit 0
fi
printf '%d passed, %d FAILED\n' "$PASS" "$FAIL"
exit 1
