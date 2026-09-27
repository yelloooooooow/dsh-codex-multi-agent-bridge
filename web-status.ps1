param(
  [ValidateSet('Preflight', 'Wait')]
  [string]$Mode = 'Preflight',
  [int]$TimeoutSeconds = 90
)

$controlUrl = 'http://127.0.0.1:3080/api/codex-dsh-bridge'
$tokenPath = Join-Path $env:USERPROFILE '.codex-dsh-bridge\web-control-token'

function Test-BridgeControl {
  if (-not (Test-Path -LiteralPath $tokenPath)) { return $false }
  $token = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $controlUrl -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if ($Mode -eq 'Wait') {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-BridgeControl) { exit 0 }
    Start-Sleep -Milliseconds 500
  }
  exit 1
}

if (Test-BridgeControl) { exit 0 }
$client = New-Object System.Net.Sockets.TcpClient
$occupied = $false
try {
  $client.Connect('127.0.0.1', 3080)
  $occupied = $client.Connected
} catch {
} finally {
  $client.Close()
}
if ($occupied) { exit 2 }
exit 1
