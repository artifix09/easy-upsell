@echo off
REM ============================================================================
REM  tunnel.bat — open the permanent ngrok tunnel on the reserved static
REM  domain. This URL never changes, so once the .env and Partner Dashboard
REM  point at it, no further config edits are needed across restarts.
REM ============================================================================

cd /d "%~dp0"

if not exist "%~dp0ngrok.exe" (
    echo ngrok.exe not found in %~dp0
    echo Download from https://ngrok.com/download and extract here.
    exit /b 1
)

REM Reserved domain — must match Partner Dashboard config and .env APP_URL.
set NGROK_DOMAIN=mortuary-monday-squatted.ngrok-free.dev

echo Starting tunnel on https://%NGROK_DOMAIN% -> http://localhost:3000
echo Leave this window open while developing.
echo Press Ctrl+C to stop.
echo.

"%~dp0ngrok.exe" http --domain=%NGROK_DOMAIN% 3000
