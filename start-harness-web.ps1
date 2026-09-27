$ErrorActionPreference = 'Stop'
trap {
  Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found. Install Node.js 24 or Node.js 22.19+.'
}
if (-not (Test-Path -LiteralPath "$repo\apps\cli\lib\bin.js")) {
  throw 'The built DeepSeek Harness CLI was not found at apps\cli\lib\bin.js.'
}

& "$PSScriptRoot\web-status.ps1" -Mode Preflight
$status = $LASTEXITCODE
if ($status -eq 0) {
  Start-Process 'http://127.0.0.1:3080/'
  exit 0
}
if ($status -eq 2) {
  throw 'Port 3080 is occupied by a Harness Web process without the bridge route. Close that process and retry.'
}

Write-Host 'Starting bridge-enabled DeepSeek Harness Web...'
Write-Host 'Keep this window open while using Harness. Close it to stop the Web host.'
Write-Host ''
& node "$repo\apps\cli\lib\bin.js" web --patch "$PSScriptRoot\web-bridge.patch.yml"
$webExit = $LASTEXITCODE
Write-Host ''
Write-Host "DeepSeek Harness Web exited with code $webExit."
Read-Host 'Press Enter to close'
exit $webExit
