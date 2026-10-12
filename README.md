# freepi-plus

A hardened, quality-of-life-enhanced fork of [free-pi-cli](https://github.com/earendil-works/free-pi-cli) — the free, ad-supported [pi](https://github.com/earendil-works/pi) coding agent.

## What's different from upstream

| Feature | Status |
|---|---|
| Auto-continue when response is truncated (`stopReason: length`) | ✅ |
| Auto-compact on context-ceiling errors (413 / `context_ceiling`) | ✅ |
| Auto-continue after threshold-based context compaction | ✅ |
| Ctrl+C ignored — agent can't be killed mid-task accidentally | ✅ |

---

## Quick start

### Windows

```bat
git clone https://github.com/Wenenu/freepi-plus.git
cd freepi-plus
setup.bat
```

`setup.bat` will:
1. Install **Node.js 22 LTS** via `winget` if not already installed
2. Install **bun** via PowerShell if not already installed
3. Run `bun install` to fetch all npm dependencies

Then launch the agent anytime with:

```bat
free-pi.bat
```

### Linux / macOS

```bash
git clone https://github.com/Wenenu/freepi-plus.git
cd freepi-plus
bash setup.sh
```

`setup.sh` will:
1. Install **Node.js 22** via [nvm](https://github.com/nvm-sh/nvm) if not already installed
2. Install **bun** if not already installed
3. Run `bun install` to fetch all npm dependencies

Then launch the agent anytime with:

```bash
bash free-pi.sh
```

---

## Manual setup (if you already have Node 22+ and bun)

```bash
cd free-pi-cli
bun install
bun run src/index.ts
```

## Requirements

| Tool | Version |
|---|---|
| Node.js | ≥ 22.19.0 |
| bun | any recent |
| Internet | GitHub OAuth + free-pi API |

---

## How it works

Authentication is done via GitHub OAuth (device flow). Your token is stored in `~/.free-pi/agent/` — completely separate from any existing `~/.pi/agent` installation.

Inference is paid for by ads shown in the terminal. You never need a model API key.

---

## Development

```bash
cd free-pi-cli
bun test        # 279 tests, ~15s, no network
bun run build   # produces dist/ (Node-bundled, for npm publish)
```

Override the backend:
```bash
FREEPI_BASE_URL=http://localhost:3000 bash free-pi.sh
```
