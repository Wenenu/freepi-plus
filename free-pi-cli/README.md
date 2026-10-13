# free-pi-cli

A preconfigured [pi](https://github.com/earendil-works/pi) coding agent, free
for the user because ads pay for inference. All model calls route through the
free-pi proxy — you never handle a model API key.

```
npx free-pi-cli
```

First run shows a consent screen (free inference, ads pay for it, sessions
may be used to train models), then signs you in with GitHub. Config and the
signed-in token live under `~/.free-pi/agent`, kept separate from any
existing `~/.pi/agent` install.

## Running it again

Closed the terminal? Just run the same command again — you stay signed in:

```
npx free-pi-cli
```

Prefer a shorter command? Install it once, globally, then call it by name:

```
npm install -g free-pi-cli
free-pi-cli
```

Note: `free-pi-cli` is the command — **not** `pi`. If you see the built-in
agent suggest `pi --session …` on exit, use `npx free-pi-cli` instead (each
run starts a fresh session).

## Coordinating a crew (bug bounties)

One session can be the coordinator of several others, on one target. Type:

```
/coordinate hackerone acme — the /v2 API
```

That turns the swarm switch on, puts this session on the roster, and hands the
agent its operating brief: recon the target, put the **scopes** on the **board**,
claim the one it works, and deploy a worker only where the work is genuinely
independent. `/coordinate --crew` deploys a recon worker immediately.

Nothing is deployed on its own. Each worker is a **separate free-pi session in
its own process**, drawing on its own free allowance, so the crew tool is a spend
control as much as a control surface: `maxWorkers` (default 3) is the limit.

Inside the session:

- `/swarm` — status (default), `on`, `off`, `crew [role]`, `stop [name|all]`, `board`, `inbox`.
- the `free_pi_swarm` tool — what the coordinating agent uses: `status`, `plan`,
  `spawn`, `stop`, `task`, `claim`, `release`, `send`, `inbox`, `report`.

From a shell (this is what a deployed worker has — it has no crew tool, only
bash, so the CLI is the whole bus for it):

```
free-pi-cli swarm status                 switch, crew, board, scope claims, unread mail
free-pi-cli swarm task add --title "audit /v2/orders" --scope api.example.com/v2
free-pi-cli swarm spawn --name recon-1 --role recon --task BB-1
free-pi-cli swarm send --to recon-1 "did you test the export endpoint?"
free-pi-cli swarm inbox                  read your own mail
free-pi-cli swarm stop --all
```

## The findings ledger

The one thing an agent hunting bugs loses most of its allowance to is not
hunting: re-deriving a fact it already established, and carrying a dozen
half-tested suspicions that never become a report. The ledger is the smallest
structure that stops both. One file per hypothesis under
`~/.free-pi/swarm/findings/`, shared by every session on the target:

```
lead → testing → poc → proven | dead | duplicate
```

and it will not let a row move without the evidence that makes it worth
something — `testing` needs the invariant being attacked, `poc` needs a
reproduction, `proven` needs one sentence of impact (which asset, what the
attacker gets), `dead` needs the reason it cannot be exploited, `duplicate` needs
the prior report. A `proven` row cannot be edited back into a guess, and a dead
row is a result: it is what stops the next session, or the next rotation, paying
for the same idea twice.

```
free-pi-cli swarm finding add --title "liquidation threshold mixes 1e8 and 1e18" \
                              --target twyne --severity high --location src/twyne/EulerCollateralVault.sol:142
free-pi-cli swarm finding status F-1 testing --invariant "debt ≤ collateral value × liquidation LTV"
free-pi-cli swarm finding status F-1 poc --evidence test/twyne/LiqThreshold.t.sol
free-pi-cli swarm finding status F-1 dead --killed "the guard reverts before the branch"
free-pi-cli swarm finding next           the single next thing to do
free-pi-cli swarm finding list           every row, with the evidence each state required
```

The agent does the same thing in-session with the `free_pi_swarm` tool
(`action: "finding"`). The **digest** — counts, the next action, what is in
flight, and the dead ids — rides in every session's system prompt (skipped
entirely on an empty ledger), so a teammate's kill reaches you without anyone
asking. `op: "next"` ranks work by money rather than curiosity (proven → poc →
an unfinished test → a new lead) and, past two open rows, refuses new leads and
names the rows to close instead.

How the coordination actually works:

- **Scopes are exclusive.** A host, URL prefix, repo+dir or binary is claimed by
  one session; a second claimer is refused and told who holds it, so two agents
  never test the same target. Claims are leased, so a dead session cannot pin a
  target forever, and a worker's claims are released as it exits.
- **The board is the shared plan.** One task per scope, with an owner and a lease;
  a task with an expired lease can be reclaimed, and the history says who took it over.
- **Mail is pushed, not polled.** A message to a live session arrives as a turn in
  that session; a worker's supervisor delivers it, so an agent in the middle of a
  finding is interrupted exactly once, at a turn boundary.
- **Nothing pops up at you.** Workers are deployed detached and hidden, so a crew
  can be working while you do something else.

State lives in `~/.free-pi/swarm` (override with `FREEPI_SWARM_DIR`) — plain files,
no daemon, no account, no server.

## Leaving it running

free-pi does not stop when you look away. Two built-in extensions keep a long
run going:

- **Keepalive** — when the session has been quiet for a minute, it gets one
  short message: continue with the task, take the next useful step, do not wait
  for input. A running turn is never interrupted, and a rotation in progress is
  left alone. One exception: a turn that ended on a tool call the model *printed*
  instead of making did not do anything and nothing follows it, so it is nudged
  at the next check rather than after the full idle window.
  `/keepalive status | off | on | now` gets it out of the way.
- **Rotation (3-hour shift)** — every 3 hours the session is asked to write a
  complete handoff document, and then the task continues in a **new session**
  with the *same provider and model* — the model is read at rotation time (so a
  session switched to Antseed mid-run stays on Antseed), and the new session's
  own `session_start` puts it back through the checked model switch. The handoff
  document is **quoted into the new session's context**, so the next chat has it
  even if its first turn never opens the file, and the message that opens it
  names the file as well. On top of that the ending session closes with a
  **four-sentence brief** of where the work stands, which goes into the new
  session's **system prompt** — so every request it makes is already oriented,
  which a handoff document alone cannot guarantee. `/rotate status` says whether
  the session is running on one. No context death, no restart of the TUI.
  `/rotate status | now | off | on` controls it.

Handoff documents, briefs and their records live in `~/.free-pi/agent/handoff/`
(`summary-<timestamp>.md`, `brief-<timestamp>.md`, `latest-brief.md` and
`latest.json`). If the agent never writes the
document, the rotation retries once, then goes ahead anyway and says so in the
handoff — an unattended run must not stall on a missing file. A document too big
for the quote (60k characters) is quoted up to that point and the file named in
the message.

Both are on by default because the point is unattended work, and both are one
command away from off:

```
FREEPI_KEEPALIVE=0        # no "continue" nudges
FREEPI_KEEPALIVE_CHECK_MS=30000   FREEPI_KEEPALIVE_IDLE_MS=60000
FREEPI_ROTATE=0           # never rotate
FREEPI_ROTATE_MS=10800000        # shift length (3 hours by default)
FREEPI_ROTATE_GRACE_MS=600000    # how long a handoff document may take
```

While the swarm is running, the same switch governs a crew: each worker is its
own session with its own allowance, so a crew left running is a crew spending.
Watch it with `free-pi-cli swarm status` and stop it with `swarm stop --all`.

## Development

- `FREEPI_BASE_URL` overrides the backend base URL (default
  `https://api.freepi.ai`) — point it at a local dev server.
- `bun test` runs the test suite against an in-process stub server; no real
  network or real pi TUI involved.
- `bash scripts/verify-swarm.sh` runs the swarm end to end through real processes
  (`status` → `spawn` → brief → board → bus → push delivery → `stop` → cleanup →
  the worker cap). Only the free-pi binary is stubbed, so it needs no sign-in and
  spends no allowance.

## Layout

| File | Purpose |
|---|---|
| `src/index.ts` | bin entry — wires real dependencies, calls `run()` |
| `src/run.ts` | orchestration: consent → login → token check → launch |
| `src/consent.ts` | consent screen text/parsing |
| `src/auth-flow.ts` | GitHub device flow client (`/auth/github/device`, `/auth/consent`, `/auth/token`), `/me` token check |
| `src/credentials.ts` | JWT file storage (mode 0600) under the free-pi config dir |
| `src/provider.ts` | pure builder for the `pi.registerProvider` config |
| `src/pi-launch.ts` | the actual pi SDK integration (registers the provider, launches the TUI) |
| `src/paths.ts` | free-pi-namespaced config dir, isolated from `~/.pi/agent` |
| `src/swarm/store.ts` | the swarm's shared state: roster, board, scope claims, the message bus, the worker cap |
| `src/swarm/workers.ts` | deploying a worker, and the detached supervisor that owns one |
| `src/swarm/cli.ts` | `free-pi-cli swarm …` — the bus every session (and every worker's bash) uses |
| `src/swarm/extension.ts` | `/coordinate` and `/swarm`, and the mail watcher inside a session |
| `src/swarm/tool.ts` | the `free_pi_swarm` tool the coordinating agent calls |
| `src/swarm/roles.ts` | the role briefs (recon, hunter, verifier, scribe) and the coordinator's own brief |
| `src/swarm/ledger.ts` | the findings ledger: the states, the evidence each move requires, the next-action ranking, the system-prompt digest |
| `src/keepalive.ts` | an idle session is told to continue (/keepalive) |
| `src/rotate.ts` | the 3-hour shift: handoff summary, then a new session on the same provider and model (/rotate) |
| `src/handoff.ts` | the handoff record, its summary path, and the first message of the new session |
| `src/text-tool-parser.ts` | recovers tool calls a model printed as text (DeepSeek DSML, `<invoke>`), so the turn keeps going |
