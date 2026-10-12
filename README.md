# freepi-plus

A hardened, quality-of-life-enhanced fork of [free-pi-cli](https://github.com/earendil-works/free-pi-cli) — the free, ad-supported [pi](https://github.com/earendil-works/pi) coding agent.

## What's different from upstream

| Feature | Status |
|---|---|
| Auto-continue when response is truncated (`stopReason: length`) | ✅ |
| Auto-compact on context-ceiling errors (413 / `context_ceiling`) | ✅ |
| Auto-continue after threshold-based context compaction | ✅ |
| Ctrl+C ignored — agent can't be killed mid-task accidentally | ✅ |
| Auto-executes text tool calls (`<bash>`, DSML, `<invoke>`, JSON) | ✅ |
| Antseed P2P auto-fallback on quota exhaustion (429 / daily cap) | ✅ |
| `antseed_deposit_usdc` built-in tool to fund inference balance | ✅ |

---

## Quick start

One script works on both Windows and Linux: **`setup.ps1`** (PowerShell).

### Windows

PowerShell is built-in — just clone and run:

```powershell
git clone https://github.com/Wenenu/freepi-plus.git
cd freepi-plus
powershell -ExecutionPolicy Bypass -File setup.ps1
```

### Linux / macOS

Install PowerShell Core first (one-time, ~30 seconds):

```bash
# Ubuntu / Debian
sudo apt-get install -y powershell

# Arch
sudo pacman -S powershell

# macOS
brew install --cask powershell
```

Then clone and run:

```bash
git clone https://github.com/Wenenu/freepi-plus.git
cd freepi-plus
pwsh setup.ps1
```

---

## What `setup.ps1` does

1. **Detects your OS** automatically (Windows / Linux / macOS)
2. **Installs Node.js 22 LTS** via `winget` (Windows) or `nvm` (Linux/macOS) — skipped if already installed
3. **Installs bun** — skipped if already installed
4. **Installs npm dependencies** (`bun install`)
5. **Creates a global `freepi` command** you can run from any directory:
   - **Windows**: `freepi.cmd` in `%LOCALAPPDATA%\freepi-plus\`, added to your User PATH
   - **Linux/macOS**: `freepi` shell script in `~/.local/bin/`

After setup, open a **new terminal** and run from any directory:

```
freepi
```

---

## Requirements

| Tool | Installed automatically? |
|---|---|
| Node.js ≥ 22.15 | ✅ |
| bun | ✅ |
| PowerShell (`pwsh`) | Windows: built-in · Linux: see above |
| git | Must be pre-installed |

---

## How it works

Authentication is via GitHub OAuth (device flow). Your token is stored in `~/.free-pi/agent/` — separate from any existing `~/.pi/agent` installation.

Inference is paid for by ads shown in the terminal. No model API key needed.

---

## Development

```bash
cd free-pi-cli
bun test        # 279 tests, ~15s, no network required
bun run build   # produces dist/ (bundled for npm publish)
```

Override the backend:
```bash
FREEPI_BASE_URL=http://localhost:3000 freepi
```
