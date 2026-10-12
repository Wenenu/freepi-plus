#!/usr/bin/env bash
# setup.sh — Linux / macOS first-time setup for freepi-plus
# Run: bash setup.sh
set -e

REQUIRED_NODE_MAJOR=22

###############################################################################
# Helpers
###############################################################################
info()  { printf "\033[1;34m[setup]\033[0m %s\n" "$*"; }
ok()    { printf "\033[1;32m[setup]\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m[setup]\033[0m %s\n" "$*"; }
die()   { printf "\033[1;31m[setup]\033[0m %s\n" "$*" >&2; exit 1; }

###############################################################################
# 1. Node.js — install via nvm if missing or too old
###############################################################################
node_major() {
  node --version 2>/dev/null | sed 's/v\([0-9]*\).*/\1/'
}

CURRENT_MAJOR=$(node_major 2>/dev/null || echo 0)

if [ "$CURRENT_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ] 2>/dev/null; then
  warn "Node.js ${REQUIRED_NODE_MAJOR}+ required (found: $(node --version 2>/dev/null || echo none))"
  info "Installing Node.js via nvm..."

  # Install nvm if not present
  if ! command -v nvm &>/dev/null && [ ! -f "$HOME/.nvm/nvm.sh" ]; then
    info "Downloading nvm..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi

  # Load nvm in this shell
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

  nvm install "$REQUIRED_NODE_MAJOR"
  nvm use "$REQUIRED_NODE_MAJOR"
  ok "Node.js $(node --version) installed via nvm"
else
  ok "Node.js $(node --version) — OK"
fi

###############################################################################
# 2. Bun — install if missing
###############################################################################
if ! command -v bun &>/dev/null; then
  info "Installing bun..."
  curl -fsSL https://bun.sh/install | bash

  # Add bun to PATH for the rest of this script
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  ok "bun $(bun --version) installed"
else
  ok "bun $(bun --version) — OK"
fi

###############################################################################
# 3. npm dependencies
###############################################################################
info "Installing npm dependencies..."
cd "$(dirname "$0")/free-pi-cli"
bun install
ok "Dependencies installed"

###############################################################################
# 4. Done — tell user how to run
###############################################################################
cd ..
ok "Setup complete!"
echo ""
echo "  Run freepi-plus:  bash free-pi.sh"
echo "  Or directly:      bun run free-pi-cli/src/index.ts"
echo ""
