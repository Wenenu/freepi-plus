# Changelog

All notable changes to `free-pi-cli`. Format based on [Keep a Changelog](https://keepachangelog.com/).

The short highlights shown in the CLI at startup live in `src/changelog.ts` (bundled into the
build); this file is the fuller human record.

## [Unreleased]

### Added
- **A bug-bounty crew inside free-pi.** `/coordinate [target]` turns the swarm
  switch on, puts the session on the roster, and hands the agent its operating
  brief; the `free_pi_swarm` tool is how it puts scopes on the board and deploys a
  worker only where the work is genuinely independent. Each worker is a separate
  free-pi session in its own process with its own allowance, and the crew is capped
  (`maxWorkers`, default 3) because that cap is a spend limit.
- `/swarm` — the control surface: status, on, off, crew, stop, board, inbox.
- **`free-pi-cli swarm …`** — the same coordination from a shell, which is what a
  deployed worker has (it has no crew tool, only bash): `status`, `register`,
  `send`, `inbox`, `watch`, `task`, `claim`, `release`, `spawn`, `stop`, `reap`,
  `brief`, `roles`. It contacts nothing and needs no sign-in.
- One tester per target: scopes are claimed exclusively and leased, so two sessions
  never test the same target and a dead one cannot pin a target or a task forever.
- Messages are pushed into the recipient's session rather than polled for, so a
  teammate's finding arrives without anyone asking.
- A worker killed without a graceful exit has its scope, task and slot freed on the
  next roster read, instead of leaving a teammate blocked behind a lease nothing holds.

### Fixed
- **A turn no longer dies when the model prints its tool call as text.** DeepSeek
  emits DSML markup, and the recovery missed the shapes it actually produces: the
  `tool_calls` wrapper (plural), parameter tags carrying extra attributes
  (`string="false"`), and the whole argument object wrapped in a parameter named
  `arguments`. Those calls were left as prose, the session stopped, and the work
  with it. All of them are now recovered into real calls.
- **The printed-call recovery ran for one provider only.** It sat behind the
  free-pi-provider gate, and the models that print their calls as text are
  exactly the ones reached through the Antseed fallback (DeepSeek) — so a session
  on Antseed kept stopping dead on every printed call, with nothing to restart
  it. Recovery and the re-issue nudge are provider-blind now, and the nudge
  budget is given back by any turn that carries no markup, so one long run no
  longer exhausts its safety net.
- When a printed call still cannot be recovered, the session is told so and asked
  to re-issue it through the tool-calling API — at most twice in a row, so a model
  that will not comply cannot loop. A call the model never closed is deliberately
  left alone (a truncated shell command is worse than asking again).
- A tool call whose argument blob arrived with one broken escape (a raw newline
  inside a heredoc, as DeepSeek emits it) used to be handed to the tool as its
  command — the whole `{"command": …}` text. The blob is now salvaged key by key.
- **A rotation's handoff told the truth about the model again.** The record named
  the provider and model, but `appendModelChange` only writes a note into the
  transcript; it does not change what the next request uses, so a new session
  opened on free-pi's default while the handoff said `antseed`. The model is now
  read at rotation time (the live picker value, not the one the session started
  on) and put back by the replacement's own `session_start` through the checked
  model switch — so the first turn of the new session is already on the right
  model.

### Added
- **The findings ledger: `lead → testing → poc → proven | dead | duplicate`.**
  A bug-bounty run now has one file per hypothesis under
  `~/.free-pi/swarm/findings/`, shared by every session, and it will not let a row
  move without the evidence that makes it worth anything: `testing` needs the
  invariant being attacked, `poc` needs a reproduction a verifier can run,
  `proven` needs one sentence of impact (which asset, what the attacker gets),
  `dead` needs the reason it cannot be exploited, `duplicate` needs the prior
  report. A `proven` row can never be edited back into a guess.
- **It is in the session's system prompt, and it says what to do next.** A
  compact digest — counts, the single next action, what is in flight, and the ids
  that are dead and must not be re-tested — is re-read every turn, so a
  teammate's kill reaches you without anyone asking. It is skipped entirely on an
  empty ledger, so a session that is not hunting pays nothing for it.
  `action:"finding"` `op:"next"` ranks the work by money rather than curiosity
  (proven → poc → an unfinished test → a new lead) and, past two open rows,
  refuses new leads and names the ones to close instead: a session with six live
  hypotheses finishes none.
- The same ledger from a shell: `free-pi-cli swarm finding add|list|show|status|next|digest`.
  The CLI is what a worker (or its bash) uses, and it enforces exactly the same
  rules as the tool — there is no second path into the state.
- A rotation with no usable closing reply now falls back to the ledger for its
  four-sentence brief: counts, what is proven, the next action, and what is dead.
- **The next chat starts briefed.** A rotation no longer only leaves a document: the
  session that is ending is asked to close with **exactly four sentences** — where
  the work stands, what it was doing, what is next, what must not be repeated — and
  that reply is injected into the replacement's **system prompt**, so it is present
  in every request the new session makes instead of depending on the model opening
  a file. The brief is also written to `~/.free-pi/agent/handoff/latest-brief.md`
  (with a timestamped copy) and recorded in the handoff record; `/rotate status`
  says whether the session is running on one. If the closing reply is unusable
  ("handoff written"), the first four sentences of the document's body supply the
  brief instead, and with neither, the system prompt is left exactly as it was.
- **Keepalive**: an idle session is nudged to continue (`/keepalive status | off |
  on | now`; `FREEPI_KEEPALIVE=0` disables). A running turn is never interrupted,
  and a turn that ended on printed tool markup is nudged at the next check rather
  than after the full idle window.
- **Rotation, every 3 hours**: the session writes a full handoff document, then the
  task continues in a **new session with the same provider and model**. The
  document is quoted into the new session's context (up to 60k characters; the
  file is named for anything beyond that), a four-sentence brief of the session
  goes into its system prompt, and the message that opens the session tells it to
  carry on from there
  (`/rotate status | now | off | on`; `FREEPI_ROTATE=0` disables,
  `FREEPI_ROTATE_MS` sets the shift). Documents and records live in
  `~/.free-pi/agent/handoff/`. A missing document is retried once and then noted in
  the handoff rather than stalling the run.

### Changed
- `free-pi-cli` now takes a subcommand (`swarm`), where previously every argument
  was a run flag; unknown arguments still fail loudly rather than starting a session.

## [0.2.18] - 2026-09-04

### Changed
- The startup consent line reads "Usage is funded by ads and training." instead of naming sessions
  directly.

## [0.2.17] - 2026-09-03

### Added
- `/tos` and `/privacy-policy` slash commands: open the Terms of Service and Privacy Policy in
  your browser.
- The consent screen and startup header now state that usage is funded by ads and by training
  on your sessions.

## [0.2.16] - 2026-09-03

### Added
- The whole ad card is one clickable link. Every row of the card carries the same link, so a
  click anywhere on the card opens the advertiser.
- `free_pi_docs` tool: the agent can answer questions about free-pi itself (what it is, the
  free allowance, credits, and the slash commands) from a built-in guide.

## [0.2.15] - 2026-09-03

### Added
- A free-pi startup screen: name and model, a welcome line, and the five free-pi commands
  (`/usage`, `/support`, `/buy-credits`, `/close-other-session`, `/update`). `ctrl+o` shows one line
  of key hints. pi's own startup header, skill list, and extension list no longer print.
- `/support` slash command: opens the advertiser currently shown in the banner. It grants nothing.

## [0.2.12] - 2026-09-01

### Added
- `/buy-credits` slash command (#241): opens the buy page with no model turn, so it works when
  you are out of usage and every request is rejected.
- `/usage` slash command: the same report as `free_pi_usage`, with no model turn.
- One readable line when the server rejects a request with a 429: the server's own buy notice at
  the wall, or a plain rate-limit line with the retry time. pi still prints its raw error and
  retries; this line sits beside it.
- A heads-up in the meter from 80% of the free daily allowance (server-owned text).
- A one-turn "Payment received — $X of usage added" line in the meter when a purchase lands.

### Changed
- `free_pi_usage` reports free usage as a percentage of today's allowance (#242). No free-usage
  dollar figure is shown anywhere (cap, spend, lifetime). Purchased credit stays in dollars.

## [0.2.11] - 2026-09-01

### Added
- **Buy more usage when the free daily cap is hit** (epic #221). A purchased credit balance
  covers usage above the free allowance and persists across days. Packs: $5 → $4.00 of usage,
  $10 → $8.00, paid by card or USDC through Stripe Checkout.
- `free_pi_buy_credits` tool (#226): ask pi to buy credits and it opens the buy page in your
  browser and prints the URL (for SSH sessions).
- `free_pi_usage` now shows the purchased balance (#227).

### Changed
- The out-of-usage line in the meter is now server-supplied (#225), so the offer and link can
  change without a CLI update. Against an older server the previous text is shown unchanged.

## [0.2.10] - 2026-08-29

### Changed
- **free-pi now pins the exact agent version it was tested against.** The dependency on
  `@earendil-works/pi-coding-agent` was a `^0.84.2` range, and because the build marks it
  external it resolved on *your* machine at install time — so a fresh install was already
  pulling 0.84.4, a version free-pi had never run a test against. Nobody chose that; npm did.
  It is now pinned to `0.84.4` (tested: 178 CLI tests, typecheck, build, and a real session with
  the ad banner, model-lock and all five extensions loaded). Adopting a newer agent is now a
  deliberate release rather than something that happens to you.
- A nightly CI canary runs the CLI against the *newest* agent release, so a breaking upstream
  change shows up as a red job instead of a user's broken install.

## [0.2.9] - 2026-08-28

Windows fixes and the first cross-platform CI, all from community pull requests by
[@andreolf](https://github.com/andreolf) on the public repo.

### Fixed
- **Windows: self-update never ran.** `npm` on Windows is `npm.cmd`, a batch file, and Node
  refuses to spawn one without a shell. The resulting error was read as "not updatable", so every
  Windows launch silently skipped the update since the feature shipped. The same bug made
  `/update` fail too.
- **Windows: sign-in never opened a browser.** `start` treats its first quoted argument as a
  window title, so the sign-in URL opened an empty console window instead of a browser.
- **Non-interactive runs no longer hang or silently do nothing.** With stdin piped from something
  that never sends a line (CI, `cat | free-pi-cli`), first-run consent waited forever. With stdin
  closed (`< /dev/null`) it printed the consent screen and exited 0 without consenting or
  launching — a success that did nothing. Both now print one line explaining that consent needs a
  terminal, and exit 1.

### Added
- `free-pi-cli logout` — removes the stored sign-in token; the next run signs in again. Purely
  local, so it works offline. Note there is no server-side revoke: the token stays valid until it
  expires.
- `free-pi-cli --version` and `--help`.
- An unrecognized argument now prints help and exits 2, instead of quietly starting a full agent
  session on a typo.

### Security
- The sign-in URL is validated before it is handed to a shell. It arrives from the server and was
  previously passed through with only `&` escaped, which on Windows left `|`, `(` and `)` able to
  run a command. It must now parse as an http/https URL, and every shell metacharacter is escaped.

## [0.2.8] - 2026-08-22

### Added
- Model picker. When the server offers more than one model, `/model` lists them and lets you
  switch; the picker is scoped to exactly the free-pi models. Backed by a server-side model
  catalog, so models can be added or changed without a CLI release. Older CLIs are unaffected —
  they keep using the single active model.

## [0.2.7] - 2026-08-21

### Changed
- The model-lock is now reliable and no longer touches your environment. 0.2.6 hid extra
  providers by deleting their API-key env vars before startup, which (a) missed HuggingFace
  (its token is `HF_TOKEN`, not `*_API_KEY`) and (b) could not hide providers discovered from
  dual-use credentials (AWS Bedrock, Google Vertex) without also deleting those credentials —
  which the agent's shell tool legitimately needs. The lock now leaves every credential in your
  shell intact and instead scopes the model picker to just the free-pi model. Set
  `FREEPI_KEEP_ENV_PROVIDERS=1` to unlock the picker and use your own providers.

## [0.2.6] - 2026-08-21

### Added
- `/close-other-session` — clear a stuck or orphaned session yourself, instead of waiting out the
  timeout, when you hit "you've already got a free-pi session running somewhere". Force-releases
  only your own account's session lease; the one-session-per-account limit is unchanged.
- `/whats-new` — show recent release highlights on demand.
- `/update` — update free-pi-cli to the latest version (a no-op on `npx`, which is always latest).
- "What's new" note shown once at startup after you update to a newer version.

### Changed
- The model list is now limited to the free-pi model instead of inheriting every provider whose
  API key happens to be in your shell (which silently bypassed free-pi). Bring your own key
  deliberately with `/login`, or set `FREEPI_KEEP_ENV_PROVIDERS=1` to keep your shell's provider
  keys.

## [0.2.5] - 2026-08-21

### Added
- The CLI now shows the model the server is actually serving (accurate status-line label) plus a
  one-line notice for trial models.
- Free **Ox Alpha** trial — a frontier preview model, free for the trial period.

## [0.2.4] - 2026-08-20

### Fixed
- Moved the Node-version guard into the bin shim so even very old Node versions get a friendly
  message instead of crashing mid-startup (undici/zstd).

## [0.2.3] - 2026-08-20

### Added
- Preflight check for Node zstd support: a clear "upgrade your Node" message instead of a crash
  mid-request.
