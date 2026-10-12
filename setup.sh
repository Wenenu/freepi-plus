#!/usr/bin/env bash
# setup.sh — Linux / macOS setup + launcher for freepi-plus
# First run: installs Node.js and bun, then launches the agent.
# Subsequent runs: skips installs (already done) and launches directly.
set -e

REQUIRED_NODE_MAJOR=22
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { printf "\033[1;34m[setup]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[setup]\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m[setup]\033[0m %s\n" "$*" >&2; exit 1; }

###############################################################################
# 1. Node.js
###############################################################################
node_major() { node --version 2>/dev/null | sed 's/v\([0-9]*\).*/\1/'; }
CURRENT_MAJOR=$(node_major 2>/dev/null || echo 0)

if [ "${CURRENT_MAJOR:-0}" -lt "$REQUIRED_NODE_MAJOR" ] 2>/dev/null; then
  info "Node.js ${REQUIRED_NODE_MAJOR}+ required — installing via nvm..."
  export NVM_DIR="$HOME/.nvm"
  if [ ! -f "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh"
  nvm install "$REQUIRED_NODE_MAJOR"
  nvm use "$REQUIRED_NODE_MAJOR"
fi

# Load nvm in case it was installed in a previous run
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

ok "Node.js $(node --version)"

###############################################################################
# 2. Bun
###############################################################################
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun &>/dev/null; then
  info "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

ok "bun $(bun --version)"

###############################################################################
# 3. Dependencies (fast no-op if already installed)
###############################################################################
info "Checking dependencies..."
cd "$SCRIPT_DIR/free-pi-cli"
bun install --frozen-lockfile

###############################################################################
# 4. Launch
###############################################################################
echo ""
exec bun run src/index.ts "$@"
