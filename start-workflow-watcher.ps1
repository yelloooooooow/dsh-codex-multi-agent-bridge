param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$configPath = (Resolve-Path -LiteralPath $Config).Path
$scriptPath = Join-Path $PSScriptRoot 'workflow.mjs'
$logDir = Join-Path (Split-Path -Parent $configPath) 'workflow-logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')
$process = Start-Process -FilePath $node -WindowStyle Hidden -PassThru -ArgumentList @(
  ('"{0}"' -f $scriptPath), 'watch', '--config', ('"{0}"' -f $configPath)
) -RedirectStandardOutput (Join-Path $logDir "$stamp.out.log") -RedirectStandardError (Join-Path $logDir "$stamp.err.log")
Start-Sleep -Milliseconds 250
if ($process.HasExited) {
  throw "Workflow watcher exited during startup; inspect $logDir/$stamp.err.log"
}
[pscustomobject]@{ pid = $process.Id; startedUtc = $process.StartTime.ToUniversalTime().ToString('o'); config = $configPath; logs = $logDir } | ConvertTo-Json
