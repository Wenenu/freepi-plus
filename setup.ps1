#!/usr/bin/env pwsh
# setup.ps1 — Universal setup + global installer for freepi-plus
#
# Windows  : powershell -ExecutionPolicy Bypass -File setup.ps1
# Linux    : pwsh setup.ps1
#   (Install pwsh on Linux first if needed — see README)
#
# What this does:
#   1. Installs Node.js 22+ (if missing)
#   2. Installs bun (if missing)
#   3. Installs npm dependencies
#   4. Creates a global "freepi" command you can run from any directory

$ErrorActionPreference = "Stop"

$REPO_DIR  = Split-Path -Parent $MyInvocation.MyCommand.Path
$CLI_DIR   = Join-Path $REPO_DIR "free-pi-cli"
$ENTRY     = Join-Path $CLI_DIR "src" "index.ts"

$REQUIRED_NODE_MAJOR = 22

# ─── Colour helpers ──────────────────────────────────────────────────────────
function info($msg)  { Write-Host "[setup] $msg" -ForegroundColor Cyan }
function ok($msg)    { Write-Host "[setup] $msg" -ForegroundColor Green }
function warn($msg)  { Write-Host "[setup] $msg" -ForegroundColor Yellow }
function die($msg)   { Write-Host "[setup] ERROR: $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  ╔══════════════════════════════╗" -ForegroundColor Magenta
Write-Host "  ║       freepi-plus setup      ║" -ForegroundColor Magenta
Write-Host "  ╚══════════════════════════════╝" -ForegroundColor Magenta
Write-Host ""

# ─── Detect platform ─────────────────────────────────────────────────────────
$onWindows = $IsWindows -or ($PSVersionTable.PSVersion.Major -lt 6)
$onLinux   = $IsLinux
$onMac     = $IsMacOS

if ($onWindows) { info "Platform: Windows" }
elseif ($onLinux) { info "Platform: Linux" }
elseif ($onMac)   { info "Platform: macOS" }
else              { die "Unsupported platform." }

# ─── 1. Node.js ──────────────────────────────────────────────────────────────
info "Checking Node.js..."
$nodePath = Get-Command node -ErrorAction SilentlyContinue
$needNode = $true
if ($nodePath) {
    $nodeVer = (node --version 2>$null) -replace 'v', ''
    $nodeMajor = [int]($nodeVer -split '\.')[0]
    if ($nodeMajor -ge $REQUIRED_NODE_MAJOR) {
        ok "Node.js v$nodeVer"
        $needNode = $false
    } else {
        warn "Node.js v$nodeVer is too old (need $REQUIRED_NODE_MAJOR+)"
    }
}

if ($needNode) {
    info "Installing Node.js $REQUIRED_NODE_MAJOR LTS..."
    if ($onWindows) {
        $wingetAvail = Get-Command winget -ErrorAction SilentlyContinue
        if ($wingetAvail) {
            winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
            # Reload PATH
            $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                        [System.Environment]::GetEnvironmentVariable("PATH", "User")
        } else {
            die "winget not found. Install Node.js 22+ from https://nodejs.org then re-run."
        }
    } elseif ($onLinux -or $onMac) {
        # Use nvm
        $nvmDir = "$HOME/.nvm"
        if (-not (Test-Path "$nvmDir/nvm.sh")) {
            info "Installing nvm..."
            bash -c "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
        }
        bash -c "source $nvmDir/nvm.sh && nvm install $REQUIRED_NODE_MAJOR && nvm use $REQUIRED_NODE_MAJOR"
        # Reload node from nvm path
        $env:PATH = "$nvmDir/versions/node/$(bash -c "source $nvmDir/nvm.sh && nvm current")/bin:$($env:PATH)"
    }
    ok "Node.js installed."
}

# ─── 2. Bun ──────────────────────────────────────────────────────────────────
info "Checking bun..."
$bunPath = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunPath) {
    info "Installing bun..."
    if ($onWindows) {
        powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
        $env:PATH = "$env:LOCALAPPDATA\bun;$($env:PATH)"
    } else {
        bash -c "curl -fsSL https://bun.sh/install | bash"
        $env:PATH = "$HOME/.bun/bin:$($env:PATH)"
    }
    $bunPath = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $bunPath) { die "bun installation failed. Install manually from https://bun.sh then re-run." }
    ok "bun installed."
} else {
    ok "bun $(bun --version)"
}

# ─── 3. npm dependencies ─────────────────────────────────────────────────────
info "Installing npm dependencies..."
Push-Location $CLI_DIR
bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Pop-Location; die "bun install failed." }
Pop-Location
ok "Dependencies ready."

# ─── 4. Install global "freepi" command ──────────────────────────────────────
info "Installing global 'freepi' command..."

if ($onWindows) {
    # Create a launcher directory in LOCALAPPDATA and drop freepi.cmd there
    $installDir = "$env:LOCALAPPDATA\freepi-plus"
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null

    $cmdContent = "@echo off`r`nbun run `"$ENTRY`" %*`r`n"
    Set-Content -Path "$installDir\freepi.cmd" -Value $cmdContent -Encoding ASCII

    # Add to User PATH if not already present
    $userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$installDir*") {
        [System.Environment]::SetEnvironmentVariable("PATH", "$installDir;$userPath", "User")
        $env:PATH = "$installDir;$($env:PATH)"
        ok "Added $installDir to User PATH."
    }
    ok "Installed: $installDir\freepi.cmd"

} else {
    # Linux / macOS: drop a shell script in ~/.local/bin
    $binDir = "$HOME/.local/bin"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null

    $bunBin = if ($onLinux) { "$HOME/.bun/bin/bun" } else { "$HOME/.bun/bin/bun" }
    # Resolve actual bun path
    $resolvedBun = (Get-Command bun -ErrorAction SilentlyContinue)?.Source
    if (-not $resolvedBun) { $resolvedBun = "$HOME/.bun/bin/bun" }

    $shContent = @"
#!/usr/bin/env bash
export BUN_INSTALL="`$HOME/.bun"
export PATH="`$BUN_INSTALL/bin:`$PATH"
export NVM_DIR="`$HOME/.nvm"
[ -s "`$NVM_DIR/nvm.sh" ] && source "`$NVM_DIR/nvm.sh"
exec bun run "$ENTRY" "`$@"
"@
    Set-Content -Path "$binDir/freepi" -Value $shContent -NoNewline
    bash -c "chmod +x $binDir/freepi"

    # Add ~/.local/bin to PATH in shell rc files if not already present
    $pathLine = 'export PATH="$HOME/.local/bin:$PATH"'
    foreach ($rc in @("$HOME/.bashrc", "$HOME/.zshrc", "$HOME/.profile")) {
        if (Test-Path $rc) {
            $content = Get-Content $rc -Raw
            if ($content -notlike "*freepi-plus*" -and $content -notlike "*.local/bin*") {
                Add-Content -Path $rc -Value "`n# freepi-plus`n$pathLine"
                ok "Updated $rc"
            }
        }
    }
    ok "Installed: $binDir/freepi"
}

# ─── Done ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔══════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║       Setup complete!        ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════╝" -ForegroundColor Green
Write-Host ""
if ($onWindows) {
    Write-Host "  Open a new terminal and run:  " -NoNewline
    Write-Host "freepi" -ForegroundColor Yellow
} else {
    Write-Host "  Reload your shell then run:   " -NoNewline
    Write-Host "freepi" -ForegroundColor Yellow
    Write-Host "  Or right now:                 " -NoNewline
    Write-Host "~/.local/bin/freepi" -ForegroundColor Yellow
}
Write-Host ""
