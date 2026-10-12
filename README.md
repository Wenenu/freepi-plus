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

### Linux / macOS

```bash
git clone https://github.com/Wenenu/freepi-plus.git
cd freepi-plus
bash setup.sh
```

Both scripts install **Node.js 22** and **bun** automatically if they're missing, then launch the agent. On every subsequent run they skip straight to launch (dependency check is near-instant).

---

## Requirements

| Tool | Installed by setup script? |
|---|---|
| Node.js ≥ 22.15 | ✅ auto-installed |
| bun | ✅ auto-installed |
| git | must be pre-installed |
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
FREEPI_BASE_URL=http://localhost:3000 bash setup.sh
```
