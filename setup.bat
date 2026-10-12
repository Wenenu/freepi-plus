@echo off
setlocal EnableDelayedExpansion
:: setup.bat — Windows first-time setup for freepi-plus
:: Run: setup.bat  (double-click or run in cmd / PowerShell)

set "REQUIRED_NODE_MAJOR=22"
set "SCRIPT_DIR=%~dp0"

echo.
echo ============================================================
echo   freepi-plus setup
echo ============================================================
echo.

:: ---------------------------------------------------------------------------
:: 1. Check / install Node.js
:: ---------------------------------------------------------------------------
where node >nul 2>nul
if %errorlevel% neq 0 goto :install_node

:: Node is present — check major version
for /f "tokens=1 delims=v." %%V in ('node --version 2^>nul') do set "NODE_MAJOR=%%V"
:: node --version prints "v22.x.x" so first token after splitting on v and . is the major
for /f "tokens=2 delims=v." %%V in ('node --version 2^>nul') do set "NODE_MAJOR=%%V"
if !NODE_MAJOR! GEQ %REQUIRED_NODE_MAJOR% goto :node_ok

:install_node
echo [setup] Node.js %REQUIRED_NODE_MAJOR%+ not found. Installing via winget...
winget install --id OpenJS.NodeJS.LTS --version 22 --accept-package-agreements --accept-source-agreements --silent
if %errorlevel% neq 0 (
    echo [setup] winget install failed. Please install Node.js 22+ manually from https://nodejs.org
    echo         then re-run this script.
    pause
    exit /b 1
)
:: Refresh PATH so node is visible in this session
for /f "delims=" %%P in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\"PATH\",\"Machine\")"') do set "PATH=%%P;%PATH%"
echo [setup] Node.js installed successfully.

:node_ok
for /f "tokens=*" %%V in ('node --version 2^>nul') do echo [setup] Node.js %%V — OK

:: ---------------------------------------------------------------------------
:: 2. Check / install bun
:: ---------------------------------------------------------------------------
where bun >nul 2>nul
if %errorlevel% equ 0 goto :bun_ok

echo [setup] bun not found. Installing...
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
if %errorlevel% neq 0 (
    echo [setup] bun install failed. Please install bun manually from https://bun.sh and re-run.
    pause
    exit /b 1
)
:: Refresh PATH
for /f "delims=" %%P in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\"PATH\",\"User\")"') do set "PATH=%%P;%PATH%"
echo [setup] bun installed successfully.

:bun_ok
for /f "tokens=*" %%V in ('bun --version 2^>nul') do echo [setup] bun %%V — OK

:: ---------------------------------------------------------------------------
:: 3. Install npm dependencies
:: ---------------------------------------------------------------------------
echo [setup] Installing npm dependencies...
cd /d "%SCRIPT_DIR%free-pi-cli"
bun install
if %errorlevel% neq 0 (
    echo [setup] Dependency install failed. See output above.
    pause
    exit /b 1
)
echo [setup] Dependencies installed.

:: ---------------------------------------------------------------------------
:: 4. Done
:: ---------------------------------------------------------------------------
cd /d "%SCRIPT_DIR%"
echo.
echo ============================================================
echo   Setup complete!
echo.
echo   Run freepi-plus:  free-pi.bat
echo   Or:               run.bat
echo ============================================================
echo.
pause
