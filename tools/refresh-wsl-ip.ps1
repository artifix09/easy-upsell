# =============================================================================
# refresh-wsl-ip.ps1 — keep .env's REDIS_URL and PGHOST aligned with the
# current WSL2 IP. Call this from start.bat or by hand before `node server.mjs`.
#
# Why this is needed:
#   WSL2 assigns the distro a new IP on every restart. Windows can't reach
#   WSL services via "localhost" on this user's setup (mirrored networking
#   not supported, localhostForwarding not working), so .env points at the
#   WSL IP directly. This script keeps that pointer fresh.
# =============================================================================

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'

if (-not (Test-Path $envPath)) {
    Write-Host "[refresh-wsl-ip] .env not found at $envPath" -ForegroundColor Red
    exit 1
}

$wslIp = (wsl -e hostname -I).Trim().Split(' ')[0]
if (-not $wslIp) {
    Write-Host "[refresh-wsl-ip] could not determine WSL IP (is WSL running?)" -ForegroundColor Red
    exit 1
}

$envContent = Get-Content $envPath -Raw
$envContent = $envContent -replace "REDIS_URL=redis://[^/\s]+:6379", "REDIS_URL=redis://$wslIp`:6379"
$envContent = $envContent -replace "PGHOST=\S+", "PGHOST=$wslIp"
Set-Content -Path $envPath -Value $envContent -NoNewline

# Quick reachability check so the user knows immediately if WSL is wedged.
$redisOk = Test-NetConnection -ComputerName $wslIp -Port 6379 -InformationLevel Quiet
$pgOk    = Test-NetConnection -ComputerName $wslIp -Port 5432 -InformationLevel Quiet

Write-Host "[refresh-wsl-ip] WSL IP: $wslIp  | Redis: $redisOk  | Postgres: $pgOk"
if (-not ($redisOk -and $pgOk)) {
    Write-Host "[refresh-wsl-ip] One or both services unreachable. Run:" -ForegroundColor Yellow
    Write-Host "    wsl -e bash -c 'sudo systemctl start redis-server postgresql'" -ForegroundColor Yellow
    exit 2
}
