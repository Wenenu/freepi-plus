#!/usr/bin/env bash
# free-pi.sh — run freepi-plus on Linux / macOS
# Usage: bash free-pi.sh [pi args...]
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load nvm if bun/node were installed via the setup script
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

exec bun run "$SCRIPT_DIR/free-pi-cli/src/index.ts" "$@"
