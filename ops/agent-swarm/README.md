# agent-swarm

Deploy freepi subagents, and let freepi sessions talk to each other while they work.

Built for one job: running a bug-bounty effort as several sessions that split the
target between them instead of duplicating each other's work. One session
reconnoitres and writes the board; others each take a scope, claim it
exclusively, hunt it, and report findings to the others as they get them; a
verifier reproduces what a hunter claims before it is written up.

- **The switch** — `swarm on` / `swarm off`, or the checkbox in the UI. Off by
  default: a box with this installed deploys nothing until you flip it. It gates
  *deployment* only; `swarm down` always works.
- **The bus** — every session can message every other one with plain files.
  Needs no daemon, survives restarts, and is readable with `cat`.
- **The board** — tasks with an atomic claim, so a task has exactly one owner.
- **Scope claims** — exclusive rights to a host, path or repo, so two testers
  never burn the same allowance on the same target.

## What a "subagent" is here (and why this is not in the CLI)

free-pi-cli deliberately has no subagent capability. Its extension list is
closed, `packages: []`, the SDK `tools` allowlist is exactly `SAFE_TOOLS` plus
four custom tools, and `test/no-subagents.test.ts` fails structurally *and*
dynamically (a real `AgentSession` driven against a stub upstream, asserting
`maxOpen <= 1`) if that ever changes. The reason is the business model:
inference is ad-funded, one session holds one lease, and the server-side lease
(R19) is the backstop. `AGENTS.md` adds that `free-pi-cli` is a generated mirror —
hand edits to `src/` are overwritten by the next sync, which refuses to run when
it finds them.

So nothing here touches the CLI. A subagent is a **separate headless session**:
`freepi --mode rpc` in its own process, with its own session id, its own lease
and its own single-concurrent-completion guarantee — the same mechanism pi's own
`examples/extensions/subagent` uses. `--mode rpc` and `--session` in this repo
are what make it possible; the panel already drives one session that way, this
drives many.

Coordination is by **bash**, not by a tool: `bash` is in `SAFE_TOOLS`, so an
agent can run `swarm send`/`swarm claims`/`swarm task claim` with no new tool
registration, no allowlist change and nothing to re-port at the next mirror
sync. Every agent inherits `SWARM_SESSION`, so it never has to name itself.

## The three files that matter

```
swarm.ts            the whole system: bus, board, claims, supervisors, UI, CLI
roles/*.md          what each kind of worker is told (recon, hunter, verifier, scribe)
public/index.html   the switch, the roster, the board, the claims, the live log
```

State lives outside the repo, root-only, in `SWARM_STATE_DIR`
(default `~/.free-pi/swarm`, installed as `/var/lib/freepi-swarm`):

```
config.json         the switch: { enabled, maxWorkers, defaultRole, leaseSeconds, deliverMail, cwdAllowlist }
agents/<name>.json  the roster: role, cwd, pid, session id, status, current task
mail/<name>/new/    the bus: one JSON file per message; reading it moves it to read/
tasks/<id>.json     the board, with the full history of who claimed what
tasks/<id>.claim/   the lock for a task — a directory, so mkdir is the atomic test
claims/<key>/       a scope claim (owner, expiry, task)
slots/<n>.json      a worker slot: the cap, enforced with mkdir/openExcl, no daemon
logs/<name>.log     what each supervisor and its agent did
events.jsonl        append-only audit trail (what the UI streams)
```

## Deploying subagents

```bash
swarm on
swarm task add --title "audit /v2/orders" --id BB-1 --role hunter --scope api.example.com/v2
swarm spawn --name scout --role recon  --cwd /root/workspace/target
swarm spawn --name hunter-1 --role hunter --task BB-1 --cwd /root/workspace/target
swarm status
```

`swarm spawn` starts a **detached supervisor** (`swarm worker`), which starts one
`freepi --mode rpc` child and owns it for its whole life. The supervisor:

1. records the roster entry and binds its worker slot (the pid in the slot file
   is the supervisor's, never the short-lived CLI's — otherwise every slot would
   look stale to the next command and the cap would quietly stop meaning anything),
2. asks the session for its id and renames it `swarm:<role>:<name>`, so the
   session shows up recognisably in `ops/freepi-panel`,
3. sends the brief: role file + assignment + how to use the bus + the rules,
4. then loops — pushing new mail into the running turn (`steer` while it is
   working, `prompt` when it is idle), heartbeating the roster, and watching for
   its stop marker,
5. and on exit releases everything the agent still held (its scope claims and any
   task it owned go back on the board, not stuck behind a dead pid).

Every handshake step races the child's exit, so a worker whose freepi cannot
start reports `exited` with the reason in `logs/<name>.log` and frees its slot in
about a second, rather than holding capacity and an "idle" roster entry forever.

`swarm down <name>` (or `--all`) writes a stop marker; the supervisor closes
freepi's stdin, so the agent shuts down gracefully. `swarm reap` frees slots
whose supervisor died; a slot reserved by a spawn still in flight is given a
minute of grace, a self-registered session with no heartbeat for a day is retired.

### The cap

`maxWorkers` (config.json, further capped by `SWARM_MAX_WORKERS`) is a *spend*
ceiling as much as a resource one: each worker is its own ad-funded session. It
is enforced by slot files created with `open(…, "wx")`, so it holds across
processes without a daemon owning a counter. A worker's cwd must be inside
`cwdAllowlist` when that list is non-empty.

## Sessions talking to each other

No daemon is involved — this half works with the service stopped and with no
workers at all:

```bash
swarm register --name scout --role recon      # a hand-driven session joins
swarm roster                                  # who is here, and what they hold
swarm send --to hunter-1 "staging host is in scope too"
swarm send --all --kind question "who wants the IDOR?"
swarm inbox                                   # read your mail (moves it to read/)
swarm watch                                   # print mail as it arrives
swarm leave                                   # release everything and gone
```

A **deployed** worker does not need to poll: its supervisor pushes new mail into
its turn. A **hand-driven** session pulls with `swarm inbox` — it may be a TUI
nobody can inject into, which is exactly why the bus is files rather than a
socket. Both kinds can send, and both are addressed by name. Mail to a name that
is not (yet) on the roster still queues, so a message to an agent you are about
to deploy is not lost.

## The board, and scope claims

```bash
swarm task add --title "audit /v2/orders" --id BB-1 --scope api.example.com/v2 --role hunter
swarm task claim BB-1        # atomic: exactly one owner, the second gets exit 4 and the holder's name
swarm task done BB-1 --evidence "GET /v2/orders?tenant=2 returns tenant 1's rows"
swarm task fail BB-1 --result "ruled out: the tenant filter is enforced in the query"
swarm claim api.example.com/v2 --ttl 45      # nobody else will work this target
swarm claims
swarm release api.example.com/v2
```

Claims carry a lease (`leaseSeconds`, `--ttl MIN`). When it runs out — or when
the agent that held them exits, even ungracefully — the claim and any task it
owned return to the pool, so a killed worker cannot lock a target out of the
swarm. `--force` takes over deliberately; the take-over is written to
`events.jsonl`.

## The UI

```bash
swarm serve                  # http://127.0.0.1:8790
cat ~/.free-pi/swarm/token   # the token is the password
```

The switch (the same `config.json` the CLI reads, so the two can never
disagree), the roster with each agent's state and unread mail, the board, the
scope claims, a form to send a message, each agent's log, and a live stream of
the audit trail. `/healthz` reports the switch, the live agent count and the
slot usage without a token.

## Install (on the box)

```bash
scp -r ops/agent-swarm zipbox:/root/
ssh zipbox 'cd /root/agent-swarm && ./install.sh --enable'
```

That installs the files under `/usr/local/share/freepi-swarm`, the `swarm`
wrapper at `/usr/local/bin/swarm` (the CLI every agent runs from bash), a token
at `/etc/freepi-swarm/token` (0600, never printed by the installer), config at
`/etc/default/freepi-swarm`, and the UI service. **The switch stays off.** The
service's `PATH` matters twice: it must contain `bun` and `freepi`, and it is
inherited by every deployed agent — that is how an agent's bash finds `swarm`.

## Verifying a deployment

```bash
bash ops/agent-swarm/verify.sh
```

101 assertions against a **stubbed** `freepi --mode rpc` (a small JS process that
answers the RPC protocol, records every prompt it is given, and runs the swarm
CLI when a pushed message asks it to). No model, no network, no allowance is
spent, and no real session is ever touched. It covers the switch (off by
default, refusing spawn with exit 3, and the UI's 403), deployment and the cap
including the failure path where freepi cannot start at all, the brief's content
(identity, role file, bus instructions, rules), the bus (send/inbox/`--keep`/
broadcast/queued-to-unknown/invalid names), the full circle *bus → running
worker → the worker's own bash → bus → another session*, the board (exclusive
claim, renewal, non-owner close, evidence, lease expiry), scope claims
(exclusive, `--force`, non-owner release, expiry), a graceful stop with the
switch off plus the cleanup it implies, and the service (token, 401s, a
cross-origin mutation, the switch persisting to config.json, spawn via the API,
mail pushed to the API-spawned worker, SSE).

## Security

- The service binds loopback and needs a token (0600, constant-time compare) for
  every `/api` route; the login cookie is `HttpOnly`/`SameSite=Lax` and
  mutations additionally require a same-origin `Origin`. Treat the token like an
  SSH key: it can start processes, so publishing the UI is the same deliberate
  step as publishing `freepi-panel`.
- Agent names, task ids and roles are validated against `[A-Za-z0-9._-]{1,32}`
  before they become any path segment.
- The state dir is root-only and holds agent output — for a bug-bounty run, that
  means unannounced findings. It is deliberately outside the repo, so nothing
  here can be committed by accident.
- A worker only ever runs the configured `SWARM_FREEPI_CMD`; there is no path
  from a bus message to arbitrary execution. The bus is a prompt to an agent,
  which then decides — with the same tools and the same rules of engagement it
  had before.

## Troubleshooting

```bash
swarm status                     # the one honest view: switch, slots, roster, board, claims
cat /var/log/freepi-swarm.log    # the UI service
tail -f /var/lib/freepi-swarm/logs/<name>.log     # one worker (and its freepi stderr)
tail -f /var/lib/freepi-swarm/events.jsonl        # the audit trail
```

- **`spawn` says the switch is OFF** — that is the point; `swarm on`.
- **`spawn` says `at capacity`** — `swarm ps`, then `swarm down <name>`; a slot
  whose supervisor died is freed by `swarm reap`.
- **A worker is `exited` immediately** — its log has the reason: usually
  `could not start <cmd>` (wrong `SWARM_FREEPI_CMD`, or `freepi` not on the
  service's PATH) or a first-run consent/sign-in that RPC mode refuses to do over
  its own stdin (`Run free-pi-cli once in a terminal first`).
- **An agent says it cannot find `swarm`** — the service's `PATH` does not
  include `/usr/local/bin`, or the unit was not restarted after install.
- **A message is not delivered to a worker** — it is in
  `mail/<name>/new/`; the supervisor restores it there if a push fails, so
  `swarm inbox` inside that session still finds it.
