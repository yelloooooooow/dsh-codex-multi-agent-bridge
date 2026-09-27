param(
  [int]$Port = 9223,
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$endpoint = "http://127.0.0.1:$Port/json/version"

function Test-DebugEndpoint {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $endpoint -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (Test-DebugEndpoint) {
  Write-Host "ChatGPT browser endpoint is ready on port $Port."
  exit 0
}

$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if ($candidates.Count -eq 0) {
  Write-Error 'Microsoft Edge or Google Chrome was not found.'
  exit 1
}

$profile = Join-Path $env:USERPROFILE '.codex-dsh-bridge\chatgpt-browser-profile'
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$arguments = @(
  "--remote-debugging-port=$Port",
  '--remote-debugging-address=127.0.0.1',
  "--user-data-dir=$profile",
  '--no-first-run',
  '--no-default-browser-check',
  'https://chatgpt.com/'
)
Start-Process -FilePath $candidates[0] -ArgumentList $arguments

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
  if (Test-DebugEndpoint) {
    Write-Host 'ChatGPT browser started. Sign in once in this dedicated window if needed.'
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

Write-Error "The browser opened, but its local debugging endpoint did not become ready at $endpoint."
exit 1
