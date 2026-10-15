# freepi-plus

**freepi** is [Hermes Agent](https://github.com/NousResearch/hermes-agent) — the
self-improving agent by Nous Research — with one addition: **Antseed**, the P2P
inference network, as a first-class provider.

Antseed is how freepi pays for inference. You deposit USDC on Base L2 once, run
the buyer daemon locally, and the daemon routes requests to peers over an
OpenAI-compatible endpoint. No per-provider API keys, no subscription, and the
cost of each request is drawn from a balance you can read at any time.

| Piece | Where it lives |
|---|---|
| Agent runtime, TUI, tools, gateway, skills, subagents | vendored Hermes Agent (see **Provenance**) |
| `antseed` provider profile | [`plugins/model-providers/antseed/`](plugins/model-providers/antseed/) |
| Antseed registry row, endpoint normalization, no-auth placeholder | [`hermes_cli/auth.py`](hermes_cli/auth.py), [`hermes_cli/auth_constants.py`](hermes_cli/auth_constants.py), [`hermes_cli/auth_zai_kimi.py`](hermes_cli/auth_zai_kimi.py) |
| Tests | [`tests/plugins/model_providers/test_antseed_profile.py`](tests/plugins/model_providers/test_antseed_profile.py) |

---

## Pull and build

The Antseed work is on the **`hermes-antseed`** branch.

**Windows (PowerShell)** — this is where `D:\freepi` lives:

```powershell
cd D:\freepi
git fetch origin
git checkout hermes-antseed
git pull

.\setup-hermes.ps1          # stages uv, builds the pm-managed dev environment
. .\activate.ps1            # puts it into this session (PATH + tool vars)
hermes                      # start the agent
```

**Linux / macOS / WSL:**

```bash
cd freepi
git fetch origin
git checkout hermes-antseed
git pull

./setup-hermes.sh           # stages uv, builds the pm-managed dev environment
source ./activate
hermes
```

Both scripts are Hermes' own dev-environment entry points: they stage the pinned
`uv`, let it install the bootstrap interpreter, then hand the environment to
`pm`, which owns the final interpreter and tool store. Nothing about the build
changed with Antseed — the provider is a plugin plus four small core edits, all
of them pure Python.

Either script publishes the usual `hermes` commands **and `anthermes`**, this
build's name for the same agent: the alias is one small forwarder file pointing
at the installation's own launcher, so `hermes` and `anthermes` can never drift —
an update that renews one renews the other. For a checkout you have not built yet
(`pm` not run), publish just the alias against its own interpreter:

```bash
python hermes_cli/_launchers.py ~/.local/bin --dev      # Windows: %LOCALAPPDATA%\hermes\bin
```

To run the test suite the way CI does:

```bash
scripts/run_tests.sh tests/plugins/model_providers/test_antseed_profile.py -q
scripts/run_tests.sh tests/plugins/model_providers tests/providers
```

(An `uv` shortcut that skips `pm`, handy for a quick loop:
`uv sync --group dev` then `./.venv/Scripts/python.exe -m pytest ...`.)

---

## Antseed

### Get a balance

```bash
antseed buyer deposit      # prints the Base L2 address to fund (gasless sweep)
antseed buyer status       # live daemon state + depositsAvailable / depositsReserved
antseed buyer start        # OpenAI-compatible proxy on 127.0.0.1:8377
```

The buyer proxy ignores the `Authorization` header — it authenticates with the
on-chain buyer identity key — so freepi hands it a local placeholder credential
(`antseed-local`) purely so the provider counts as configured.

### Then, in Hermes

```
hermes model                # pick "Antseed", then a model
/usage                      # the buyer's USDC deposit
```

The model list is read **live from your daemon** (`GET /v1/models`), so it is the
catalog your peers are actually advertising right now. While the daemon is not
running, the picker falls back to the bundled catalog that freepi-plus ships —
583 models, generated from <https://antseedstats.com/network> — so a model can
still be chosen before the daemon comes up.

`/usage` shells out to the `antseed` CLI for the balance, because the deposit is
on-chain state the HTTP proxy does not expose:

```
📈 Antseed balance
Provider: antseed
available: $0.45 USDC
reserved: $2.00 USDC (committed to open payment channels; returned when they close)
deposit account: 0x1111…1111
buyer identity: /home/you/.antseed/identity.key
buyer daemon: connected
open payment channels: 3
```

`available` is what you can spend now; `reserved` is money committed to open
payment channels — still yours, returned when a channel closes — which is why the
two are shown separately instead of as one total. A stopped daemon reads as
`Unavailable: no Antseed buyer daemon is listening — start one with `antseed
buyer start``, never as a failure: every Antseed read fails open.

### Configuration

| Variable | Meaning |
|---|---|
| `ANTSEED_BASE_URL` | Buyer proxy on another host/port. The bare host is fine — `/v1` is appended. Default `http://127.0.0.1:8377` |
| `ANTSEED_API_KEY` | Only needed if you front the daemon with a proxy that checks a bearer |
| `ANTSEED_CLI_COMMAND` | How to invoke the `antseed` CLI when it is not on `PATH`. Defaults to `antseed`, then `npx -y @antseed/cli` |
| `ANTSEED_IDENTITY_HEX` | The **daemon's** identity key, for a machine that does not already have `~/.antseed/identity.key`. Hermes never reads the key itself — the local proxy authenticates by the daemon's on-chain identity, not by a client credential — it only reports which of the two the daemon is using |

Antseed is deliberately **never auto-detected** from the environment
(`_NO_AUTO_DETECT_PROVIDERS`): a stray `ANTSEED_API_KEY` must not silently move
inference onto a daemon that may not be running. Select it explicitly with
`hermes model` or `hermes auth add antseed`.

---

## Provenance

This repository is **Hermes Agent**, vendored at upstream commit
`f56c92b47dc86a77b3bcdef023c1fa76deea2c6c` (2026-10-15), MIT licensed, with the
Antseed provider added on top. Everything else — the runtime, tools, gateway,
skills, memory, subagents, seven terminal backends — is upstream code and
upstream documentation lives at
<https://hermes-agent.nousresearch.com/docs>.

The Antseed provider is a port of the same integration in
[freepi-plus' pi-based CLI](https://github.com/Wenenu/freepi-plus/tree/main) (the
Node/TypeScript client this repository replaced), so both clients share one
contract with the buyer daemon: the same `buyer status`/`buyer balance` JSON
fields, the same `/v1` endpoint normalization, and the same status line
`[Antseed] <model> · $0.45 USDC left · $2.00 reserved`.

`ops/` still holds the systemd units and helper scripts written for that retired
Node CLI (agent swarm, channel reaper, idle guard, web panel); they are kept for
reference and do not apply to this Python base.
