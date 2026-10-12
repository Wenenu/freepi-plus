# freepi-panel

A phone-friendly web panel for the freepi agent running on this box.

freepi normally only exists inside an SSH terminal. This serves a small
authenticated UI that can

1. **watch** every session on the machine live — including one a terminal is
   writing right now,
2. **drive** a session for real: prompt, steer, abort, switch model, compact,
3. show the **Antseed balance** and whether the **idle guard** currently holds the
   box awake, so the meter and the work are on one screen.

## Why watching a terminal's session works

Sessions are append-only JSONL under
`~/.free-pi/agent/sessions/<cwd-slug>/<timestamp>_<uuid>.jsonl`:

```json
{"type":"session","version":3,"id":"01a1…","timestamp":"…","cwd":"/root/workspace/buggy"}
{"type":"message","id":"580938f2","parentId":"…","timestamp":"…","message":{"role":"assistant","content":[…]}}
```

Because nothing is ever rewritten in place, the panel can tail the file a live TUI
is appending to and show exactly what the agent is doing, with no cooperation
from the agent process. The reader keeps a byte offset per file and only parses
what was appended, so a 6 MB transcript costs nothing to follow.

## How control works

The panel starts its own `freepi --mode rpc` child per project directory and
bridges the pi RPC protocol (JSON commands on stdin, events on stdout — see the
SDK's `docs/rpc.md`) to the browser over SSE:

| UI action | RPC command |
|---|---|
| send a message | `prompt` (queued as `steer` if the agent is mid-turn) |
| Stop | `abort` |
| model picker | `get_available_models` + `set_model` |
| Compact | `compact` |
| New session | `new_session` (or a fresh child in a chosen cwd) |
| extension prompts (`confirm`, `select`, `input`, `editor`) | rendered as a dialog, answered with `extension_ui_response` |

That headless mode is what `--mode rpc` added to freepi in this repo: the same
runtime the TUI draws (same provider, same scoped models, same extensions),
driven over stdio instead of a terminal. Anything the TUI can do is a JSON
command away.

## Security, and the one thing to get right

The panel token is the *only* barrier between the internet and a shell on this
box, so:

- the token is 32 random bytes in `/etc/freepi-panel/token` (0600) and is never
  printed by the installer;
- every `/api` route requires it; the login sets an `HttpOnly`, `SameSite=Lax`
  cookie holding an HMAC of the token (`Secure` when the request arrived over
  TLS), compared in constant time;
- mutations additionally require a same-origin `Origin` header;
- login attempts are rate-limited per IP;
- the server binds `127.0.0.1` and is meant to be reached through the
  TLS-terminating proxy, never exposed directly;
- the panel runs as root (it must, to read your sessions and start agents), so
  treat the token like an SSH key. Rotate it by rewriting
  `/etc/freepi-panel/token` and restarting the service — everyone signed in is
  logged out.

## Install

```bash
scp -r ops/freepi-panel zipbox:/root/
ssh zipbox 'cd /root/freepi-panel && ./install.sh'
```

Then read the token in your own terminal and paste it into the panel's login
screen:

```bash
cat /etc/freepi-panel/token
```

Config lives in `/etc/default/freepi-panel` (bind address, port, session root,
`PANEL_FREEPI_CMD`, `PANEL_PROJECTS`). `systemctl restart freepi-panel` after
editing it.

## Publishing it for your phone

Loopback-only until you say otherwise. To reach it from a phone, ask the sandbox
platform to expose a hostname and route it at the panel:

```bash
tribes-dns expose freepi                      # DNS label for this sandbox
tribes-caddy add freepi.<apex> 127.0.0.1:8787 # HTTPS front end -> the panel
tribes-caddy list                             # what is routed where
```

`<apex>` is what `tribes-dns list` prints (e.g. `west.zbox.sh`). Both commands
are the platform's own; the panel needs no knowledge of them. **This makes the
panel reachable from the public internet** — the token is then the only thing
protecting it, so keep it long and never share a URL that has it in a query
string (the panel only ever takes it in a POST body).

To take it back off the internet:

```bash
tribes-caddy rm freepi.<apex>
```

## Driving a session a terminal is already writing

Two processes appending to one session file interleave. The panel warns before
attaching to a session whose file was modified in the last 20 seconds and
otherwise leaves you a choice:

- **watch** — always safe, and enough to see what the agent is doing;
- **take control** — starts an RPC child on that session (fine when the terminal
  is idle or closed, risky while it is mid-turn).

## Verifying a deployment

`verify.sh` runs the whole thing on the box itself — service health, the auth
barrier (wrong token, missing cookie, cross-origin and cross-site mutations), the
session list and incremental transcript reads, a live SSE tail against a file
being appended, a real `freepi --mode rpc` agent driven through the panel
(prompt → streamed reply → model list → abort), and the idle-guard hold/release
round trip. It reads the token locally and never prints it.

```bash
scp ops/freepi-panel/verify.sh zipbox:/root/ && ssh zipbox 'bash /root/verify.sh'
```

## Troubleshooting

```bash
systemctl status freepi-panel --no-pager
tail -50 /var/log/freepi-panel.log
curl -s localhost:8787/healthz          # {"ok":true,…}
```

- **"no sessions yet"** — `PANEL_SESSION_ROOT` is wrong, or nothing has run under
  that user yet.
- **balance unavailable** — the `antseed` CLI is missing from the service's PATH,
  or no buyer account is set up (`antseed buyer activity --json` by hand).
- **Take control does nothing / exits immediately** — the child's stderr is in
  the agent log pane; a first run needs consent + sign-in, which RPC mode
  deliberately refuses to do over its own stdin (`Run free-pi-cli once in a
  terminal first`).
