@echo off
REM ============================================================================
REM  Hybrid Recommendations — local dev orchestrator
REM ----------------------------------------------------------------------------
REM  Brings up Redis + Postgres inside WSL, then starts the Node server and
REM  a Cloudflare tunnel in this terminal.
REM
REM  Prerequisites (install once):
REM    * WSL2 with Ubuntu, and inside it:
REM        sudo apt update
REM        sudo apt install -y redis-server postgresql cloudflared
REM        sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'admin@627';"
REM        sudo -u postgres createdb shopify
REM    * Node 20.6+ on Windows
REM    * `npm install` already run in this directory
REM
REM  Usage:
REM    start.bat              -> bring up services + node + tunnel
REM    start.bat --no-tunnel  -> skip cloudflared (use existing APP_URL)
REM    start.bat --stop       -> stop redis + postgres in WSL
REM ============================================================================

setlocal ENABLEDELAYEDEXPANSION
cd /d "%~dp0"

if /i "%~1"=="--stop" goto :STOP

echo.
echo [1/4] Starting Redis in WSL...
wsl -e bash -lc "sudo service redis-server start >/dev/null 2>&1 || redis-server --daemonize yes" || (
    echo   ! Failed to start redis-server inside WSL. Install it first.
    goto :ERR
)
wsl -e bash -lc "redis-cli ping" || (
    echo   ! redis-cli ping failed.
    goto :ERR
)

echo.
echo [2/4] Starting Postgres in WSL...
wsl -e bash -lc "sudo service postgresql start" || (
    echo   ! Failed to start postgresql inside WSL. Install it first.
    goto :ERR
)
wsl -e bash -lc "pg_isready -h localhost -p 5432" || (
    echo   ! pg_isready reports postgres is not accepting connections yet.
    goto :ERR
)

REM Keepalive: spawn a long-running WSL command in a hidden window so WSL2
REM does not idle-reap the distro and kill redis/postgres. The window can be
REM closed by start.bat --stop or by killing wsl.exe processes.
start "wsl-keepalive" /MIN cmd /c "wsl -e bash -lc 'sleep infinity'"

echo.
echo [2.5/4] Refreshing WSL IP in .env...
powershell -ExecutionPolicy Bypass -File "%~dp0tools\refresh-wsl-ip.ps1" || (
    echo   ! Could not refresh WSL IP. See message above.
    goto :ERR
)

echo.
echo [3/4] Starting Node server (logs in this window)...
echo       APP_URL must match your tunnel and the Partner Dashboard.
echo       Press Ctrl+C to stop the server.

if /i "%~1"=="--no-tunnel" (
    node server.mjs
    goto :END
)

echo.
echo [4/4] Starting cloudflared tunnel in a new window...
echo       Copy the *.trycloudflare.com URL it prints into .env APP_URL
echo       and into Partner Dashboard ^> App setup ^> App URL.
REM Prefer a local cloudflared.exe in the project folder, then PATH, then WSL.
REM WSL cloudflared cannot reach Windows-side localhost:3000, so it is last.
if exist "%~dp0cloudflared.exe" (
    start "cloudflared" /D "%~dp0" cmd /k "cloudflared.exe tunnel --url http://localhost:3000"
) else (
    where cloudflared >nul 2>&1
    if !ERRORLEVEL!==0 (
        start "cloudflared" cmd /k "cloudflared tunnel --url http://localhost:3000"
    ) else (
        echo   ! cloudflared.exe not found in this folder or on PATH.
        echo   ! Download from:
        echo   !   https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
        echo   ! Save as: %~dp0cloudflared.exe
        echo   ! Then re-run start.bat.
        echo   ! Continuing without a tunnel - APP_URL must already be reachable.
    )
)

node server.mjs
goto :END

:STOP
echo Stopping WSL services...
wsl -e bash -lc "sudo service redis-server stop; sudo service postgresql stop"
REM Kill the keepalive so WSL can idle-shutdown cleanly.
taskkill /F /FI "WINDOWTITLE eq wsl-keepalive*" >nul 2>&1
goto :END

:ERR
echo.
echo Aborting. See messages above.
exit /b 1

:END
endlocal
