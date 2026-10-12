@echo off
setlocal EnableDelayedExpansion
:: setup.bat — Windows setup + launcher for freepi-plus
:: First run: installs Node.js and bun, then launches the agent.
:: Subsequent runs: skips installs (already done) and launches directly.

set "REQUIRED_NODE_MAJOR=22"
set "SCRIPT_DIR=%~dp0"

echo.
echo ============================================================
echo   freepi-plus
echo ============================================================
echo.

:: ---------------------------------------------------------------------------
:: 1. Check / install Node.js
:: ---------------------------------------------------------------------------
where node >nul 2>nul
if %errorlevel% neq 0 goto :install_node

for /f "tokens=2 delims=v." %%V in ('node --version 2^>nul') do set "NODE_MAJOR=%%V"
if !NODE_MAJOR! GEQ %REQUIRED_NODE_MAJOR% goto :node_ok

:install_node
echo [setup] Node.js %REQUIRED_NODE_MAJOR%+ not found. Installing via winget...
winget install --id OpenJS.NodeJS.LTS --version 22 --accept-package-agreements --accept-source-agreements --silent
if %errorlevel% neq 0 (
    echo [setup] winget install failed. Install Node.js 22+ from https://nodejs.org then re-run.
    pause
    exit /b 1
)
for /f "delims=" %%P in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\"PATH\",\"Machine\")"') do set "PATH=%%P;%PATH%"

:node_ok
for /f "tokens=*" %%V in ('node --version 2^>nul') do echo [setup] Node.js %%V

:: ---------------------------------------------------------------------------
:: 2. Check / install bun
:: ---------------------------------------------------------------------------
where bun >nul 2>nul
if %errorlevel% equ 0 goto :bun_ok

echo [setup] Installing bun...
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
if %errorlevel% neq 0 (
    echo [setup] bun install failed. Install bun from https://bun.sh then re-run.
    pause
    exit /b 1
)
for /f "delims=" %%P in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\"PATH\",\"User\")"') do set "PATH=%%P;%PATH%"

:bun_ok
for /f "tokens=*" %%V in ('bun --version 2^>nul') do echo [setup] bun %%V

:: ---------------------------------------------------------------------------
:: 3. Install npm dependencies (fast no-op if already installed)
:: ---------------------------------------------------------------------------
echo [setup] Checking dependencies...
cd /d "%SCRIPT_DIR%free-pi-cli"
bun install --frozen-lockfile
if %errorlevel% neq 0 (
    echo [setup] Dependency install failed. See output above.
    pause
    exit /b 1
)

:: ---------------------------------------------------------------------------
:: 4. Launch
:: ---------------------------------------------------------------------------
echo.
bun run src/index.ts %*
