# idle-guard

Stops a zipbox sandbox from burning money while nothing is running on it.

Zipbox bills **per running second**; a machine keeps working after you close the
browser tab, so an unused sandbox is pure cost. There is no documented
auto-sleep/auto-pause setting in the product, and the supported way to stop the
meter is the **Pause** action in the dashboard. This guard watches the sandbox
and tells you when it has become safe to pause — and can optionally shut the
sandbox down itself.

## What counts as "an AI is running"

All signals are checked; the sandbox is only treated as idle when every one of
them says nothing is happening:

| Signal | Idle when |
|---|---|
| Agent processes | no process matches `AGENT_PATTERN` (`free-pi-cli/.*index\.ts`, `pi-coding-agent`, …) |
| Agent progress | every matching agent process has the **same CPU time as on the previous run** for the whole idle window — i.e. parked at a prompt, not working |
| Remote session | no `sshd: root@…` session is making progress either (an idle shell doesn't count forever) |
| Load average | 1-minute load below `LOAD_THRESHOLD` — catches heavy child processes a parked agent would otherwise hide |
| Keepalive | `KEEPALIVE_FILE` does not exist |

That progress rule is the whole point: a freepi process sitting at a prompt for
an hour looks "busy" to a naive `pgrep` check while being exactly the case where
the sandbox should be paused.

## Install

```bash
scp -r ops/idle-guard zipbox:/root/
ssh zipbox 'cd /root/idle-guard && ./install.sh --enable'
```

`--enable` starts a systemd timer (10 minutes after boot, then every 5 minutes).
A zipbox sandbox has **no cron**, so systemd is the scheduler.

## Check it

```bash
idle-guard.sh --status     # every signal, idle time, what it would do
idle-guard.sh --dry-run    # decide + log, act on nothing
idle-guard.sh --hold       # I'm working — never treat this box as idle
idle-guard.sh --release    # done — start watching again
tail -f /var/log/idle-guard.log
```

`--hold` is the switch to reach for before a long session (it sets the keepalive
file, so it survives reboots and config edits); `--release` drops it and restarts
the idle clock from that moment.

`--status` is read-only. A busy line looks like:

```
state: BUSY — agent working (cpu advancing): 413562; active ssh session(s): 426725
```

## Verifying it

Two scripts cover the parts that are easy to get subtly wrong, and both stub the
mailer so a test run cannot send you mail:

- `verify-email-path.sh` — syntax, `--help`, `--hold`/`--release`, and the full
  idle → notify path (subject, body, both channels), plus one real send.
- `verify-rearm.sh` — that a busy run re-arms the notification, and that a later
  idle stretch notifies again.

```bash
scp ops/idle-guard/verify-*.sh zipbox:/root/idle-guard/ && ssh zipbox 'bash /root/idle-guard/verify-rearm.sh'
```

## Tuning

Everything lives in `/etc/default/idle-guard`; the timer re-reads it every run,
so nothing needs restarting after an edit.

- `IDLE_SECONDS=3600` — the hour you asked for.
- `ACTIONS=notify` — comma list of `notify`, `stop-antseed`, `poweroff`, `none`.
- `NOTIFY_TO=` / `NOTIFY_MIN_INTERVAL=` — email target and anti-spam window.
- `LOAD_THRESHOLD=1.0` — raise it on a box that legitimately idles hot.

### Email when it goes idle

When the idle threshold is hit, `notify` emails `NOTIFY_TO` (and pushes via
`tribes-notify`) with the reason, the load, and the exact Pause instructions —
nothing is paused for you, because a guest-initiated poweroff is not documented
as recoverable here.

The notification is **re-armed whenever anything counts as busy again**. So
"worked for ten minutes, then walked away" notifies again instead of being
swallowed by the anti-flap window; `NOTIFY_MIN_INTERVAL` only stops a flapping
agent from sending a burst within one idle stretch.

### Keepalive for long unattended jobs

```bash
idle-guard.sh --hold                    # I'm doing something long
idle-guard.sh --release                 # done
# or directly:
touch /var/lib/idle-guard/keepalive
rm    /var/lib/idle-guard/keepalive
```

## Why this unit is not called `zipbox-*`

`systemctl start` on a `zipbox-idle-guard.service` fails with:

```
Unit zipbox-idle-guard.service has a bad unit file setting.
Service has Restart= set to either always or on-success, which isn't allowed
for Type=oneshot services. Refusing.
```

The sandbox installs two drop-ins into `/run/systemd/system/`:

- `service.d/10-zipbox-retry.conf` — applies to **all** services; sets
  `Restart=on-failure`, `StartLimitIntervalSec=0`.
- `zipbox-.service.d/20-retry.conf` — applies to every unit whose name starts
  with `zipbox-`; sets `Restart=always`, `RestartSec=1`.

Drop-ins in `/run` outrank anything in `/etc/systemd/system`, so a
`zipbox-`-prefixed unit of ours inherits `Restart=always`, which systemd
**refuses** to combine with `Type=oneshot` — the unit never loads. Naming it
`idle-guard.service` avoids the prefix-scoped drop-in entirely (only the generic
one applies, `Restart=on-failure`, which is fine for oneshot). Verified both
ways on the sandbox on 2026-10-12: a probe `Type=oneshot` unit named `ig-probe`
loads and runs with exit status 0.

Do not rename these units to `zipbox-*`.

## About `poweroff` (read this before enabling it)

`ACTIONS=poweroff` runs `systemctl poweroff`. Be aware:

- **Suspend is not available** on this sandbox: `/sys/power/state` is `disk`
  only, and hibernation cannot fit ~8 GB of RAM into the 2 GB swapfile.
- Zipbox documents **Pause** (dashboard) as the way to stop the meter while
  keeping the disk. It does **not** document what a guest-initiated poweroff does
  to billing or how to bring the machine back.
- So the default is `notify`: the guard pushes/emails you, you hit Pause. Add
  `poweroff` only once zipbox confirms the sandbox can be booted again from the
  dashboard — a "cheap" shutdown that loses the machine is not cheap.

## Uninstall

```bash
systemctl disable --now idle-guard.timer
rm /etc/systemd/system/idle-guard.{service,timer} /usr/local/bin/idle-guard.sh
systemctl daemon-reload
# config, state and log are left on purpose:
#   /etc/default/idle-guard  /var/lib/idle-guard  /var/log/idle-guard.log
```
