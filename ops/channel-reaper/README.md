# channel-reaper

Closes Antseed payment channels that have gone idle, so their reserve stops
sitting on your balance.

## Why this exists

When the Antseed buyer serves a request, it opens a **payment channel** to that
seller and reserves USDC in it. The balance screen shows this as *reserved*,
separate from *available*:

```
$ antseed buyer balance
  Deposits available   1.449688 USDC
  Reserved (channels)  1.000000 USDC
```

Nothing in the buyer closes a channel just because it has gone quiet. A channel
opened for one request and then abandoned keeps its reserve committed: the money
is still yours, but it is not spendable until the channel settles. This runs as a
background timer, watches the buyer's own channel activity, and asks the seller
to settle any channel whose traffic has stopped for ten minutes.

## How "idle" is decided

Two sources, because neither is sufficient alone:

| Source | What it gives | Why not on its own |
|---|---|---|
| `antseed buyer activity --json` → `channels[].updatedAt` | a per-channel last-activity stamp (epoch ms) | can be bumped by non-token events (authorizations), and a channel that was already idle when the reaper was installed still needs dating |
| the `inputTokens` / `outputTokens` / `requestCount` counters, sampled each pass | proof that traffic *moved* since the last pass | cannot date a channel, only detect change |

The idle clock is the **later** of the two: a counter that moved since the last
pass is activity now, otherwise the channel's own stamp wins. A channel is closed
when that clock reads `IDLE_SECONDS` (600, ten minutes) or more.

Hard rules:

- only channels with local status `active` are ever closed — `settled`,
  `timeout` and `ghost` channels are ignored;
- at most `MAX_CLOSES_PER_RUN` (default 1) per pass, most-idle first;
- a failed close is not retried for `CLOSE_RETRY_SECONDS` (default 300);
- while the pause file exists nothing is closed, though the reaper keeps
  watching and logging;
- if `antseed` is missing, the activity JSON is unreadable, or the state file
  cannot be written, the pass is skipped and logged — it never guesses.

The 2-minute timer means a channel is closed between 10 and 12 minutes after its
last token movement. `--status` shows the live idle times if you want to see the
margin.

## What a close actually does

`antseed buyer channels close <id>` asks the seller to settle now, skipping the
`request-close` grace period, so the reserve returns to *available* as soon as
the seller settles on chain. If you would rather be gentler, set
`ACTION=request-close` (start the timeout close, then `antseed buyer channels
withdraw <id>` after the grace period) or `ACTION=notify` (never touch anything,
just tell you). Exactly one channel id is passed, taken from the JSON — never a
truncated display id.

## Install

```bash
scp -r ops/channel-reaper zipbox:/root/
ssh zipbox 'cd /root/channel-reaper && ./install.sh --enable'
```

Config lives in `/etc/default/channel-reaper`:

```ini
IDLE_SECONDS=600          # ten minutes
ACTION=close              # close | request-close | notify
MAX_CLOSES_PER_RUN=1
CLOSE_RETRY_SECONDS=300
NOTIFY_TO=you@example.com # empty = no email (tribes-notify push is still sent)
PAUSE_FILE=/var/lib/channel-reaper/paused
```

## What it looks like when it fires

First real close on this box (`--status` had shown the channel one second short of
the threshold a moment earlier):

```
$ channel-reaper.sh --status
idle threshold: 600s (10 min)
active channels: 1 | over threshold: 0 | would close now: 0
  0x3b762b65a2ab2481...  ok    idle 9m59s  tokens 42276     requests 7  Apex Ant
    skipped 0x3b762b65a2ab2481...: idle 599s < 600s

$ tail -1 /var/log/channel-reaper.log
2026-10-12T19:49:54Z closed idle channel 0x3b762b65a2ab2481… (peer=Apex Ant idle=613s tokens=42276): Asking seller 73b4c9335fa2… to close 0x3b762b65a2ab2481… ✔ Seller closed … Transaction: 0x71a14b2b…
```

and the point of the whole thing, the reserve coming back:

| | available | reserved | channels |
|---|---|---|---|
| before | 1.4497 USDC | 0.9556 | 1 (idle 10.3 min) |
| after | 2.4053 USDC | 0.0 | 0 |

## Look before it acts

```bash
channel-reaper.sh --status     # every active channel, its idle time, what's next
channel-reaper.sh --dry-run    # decide + log, close nothing
channel-reaper.sh --pause      # stop closing (keeps watching)
channel-reaper.sh --resume
tail -f /var/log/channel-reaper.log
systemctl list-timers channel-reaper.timer
```

`--status` reads:

```
idle threshold: 600s (10 min)
active channels: 1 | over threshold: 0 | would close now: 0
  0x3b762b65a2ab2481…  ok    idle 7m12s  tokens 42276     requests 7  Apex Ant
```

## Verifying it

`verify.sh` proves the decisions against a stubbed `antseed`, so a test run
cannot close a channel or send mail. It covers: closing after the threshold,
not re-closing, leaving a live channel alone, a token counter that moved resetting
the clock, `settled` channels being ignored, the per-run cap, `ACTION=notify`,
`--dry-run`, a failing close, an unreadable buyer, `--status`, pause/resume, and
state pruning.

```bash
scp ops/channel-reaper/verify.sh zipbox:/root/ && ssh zipbox 'bash /root/verify.sh'
```

## Notes and limits

- **Not named `zipbox-*` on purpose.** These sandboxes install a prefix-scoped
  systemd drop-in that forces `Restart=always`, which systemd refuses to combine
  with `Type=oneshot` — the unit would never load. See `ops/idle-guard/README.md`
  for the full story.
- **Settling needs the seller reachable.** If the buyer daemon is stopped, `close`
  fails; that is logged, backed off, and retried — the channel stays open.
- **Reopening is cheap.** A later request to the same peer opens a fresh channel;
  closing an idle one does not break a conversation, because the ten-minute
  silence is the precondition.
- The activity JSON is the buyer's *local* view (its last known values), not a
  chain read. That is deliberate: the question here is "has this channel been
  doing anything", which the local store answers immediately and cheaply.

## Uninstall

```bash
systemctl disable --now channel-reaper.timer
rm /etc/systemd/system/channel-reaper.{service,timer} /usr/local/bin/channel-reaper.sh
systemctl daemon-reload
# config, state and log are left on purpose:
#   /etc/default/channel-reaper  /var/lib/channel-reaper  /var/log/channel-reaper.log
```
