$ErrorActionPreference = 'Stop'
trap {
  Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo

Write-Host 'Unified DSH bridge'
Write-Host 'Each lane keeps its own DSH Session and Codex thread. Different lanes may run concurrently.'
Write-Host 'ChatGPT UI consultations are serialized only while an agent holds a Web or app lease.'
Write-Host ''

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found. Install Node.js 24 or Node.js 22.19+.'
}
if (-not (Test-Path -LiteralPath "$repo\apps\cli\lib\bin.js")) {
  throw 'The built DeepSeek Harness CLI was not found at apps\cli\lib\bin.js.'
}

& "$PSScriptRoot\web-status.ps1" -Mode Preflight
$webStatus = $LASTEXITCODE
if ($webStatus -eq 2) {
  Write-Host '[ERROR] Port 3080 is occupied by a Harness Web process without the bridge route.' -ForegroundColor Red
  Write-Host 'Close that older Web window and run this launcher again.'
  Read-Host 'Press Enter to close'
  exit 2
}
if ($webStatus -eq 1) {
  $webLauncher = "$PSScriptRoot\start-harness-web.ps1"
  Start-Process -FilePath 'powershell.exe' -WorkingDirectory $repo -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$webLauncher`""
  )
}
Write-Host 'Waiting for bridge-enabled Harness Web...'
& "$PSScriptRoot\web-status.ps1" -Mode Wait -TimeoutSeconds 90
if ($LASTEXITCODE -ne 0) {
  Write-Host '[ERROR] Harness Web did not become ready.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

$lane = (Read-Host 'Agent lane name [main]').Trim()
if (-not $lane) { $lane = 'main' }
if ($lane -notmatch '^[A-Za-z0-9._-]+$') {
  Write-Host '[ERROR] Lane names may use letters, numbers, dot, underscore, and hyphen.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

Write-Host ''
Write-Host 'Advisers may be combined and can be changed on a later launch:'
Write-Host '  1  Codex'
Write-Host '  2  ChatGPT Web'
Write-Host '  3  ChatGPT Windows app'
$selection = (Read-Host 'Choose one or more, for example 1,2,3 [1]').Trim()
if (-not $selection) { $selection = '1' }
$advisors = [System.Collections.Generic.List[string]]::new()
foreach ($item in ($selection -split '[,; ]+' | Where-Object { $_ })) {
  switch ($item.ToLowerInvariant()) {
    '1' { if (-not $advisors.Contains('codex')) { $advisors.Add('codex') } }
    'codex' { if (-not $advisors.Contains('codex')) { $advisors.Add('codex') } }
    '2' { if (-not $advisors.Contains('chatgpt-web')) { $advisors.Add('chatgpt-web') } }
    'web' { if (-not $advisors.Contains('chatgpt-web')) { $advisors.Add('chatgpt-web') } }
    '3' { if (-not $advisors.Contains('chatgpt-app')) { $advisors.Add('chatgpt-app') } }
    'app' { if (-not $advisors.Contains('chatgpt-app')) { $advisors.Add('chatgpt-app') } }
    'all' {
      foreach ($name in @('codex', 'chatgpt-web', 'chatgpt-app')) {
        if (-not $advisors.Contains($name)) { $advisors.Add($name) }
      }
    }
    default {
      Write-Host "[ERROR] Unknown adviser selection: $item" -ForegroundColor Red
      Read-Host 'Press Enter to close'
      exit 1
    }
  }
}
if ($advisors.Count -eq 0) {
  Write-Host '[ERROR] Select at least one adviser.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

if ($advisors.Contains('chatgpt-web')) {
  & "$PSScriptRoot\ensure-chatgpt-browser.ps1"
  if ($LASTEXITCODE -ne 0) {
    Read-Host 'Press Enter to close'
    exit 1
  }
}
if ($advisors.Contains('chatgpt-app')) {
  & "$PSScriptRoot\ensure-chatgpt-app.ps1"
  if ($LASTEXITCODE -ne 0) {
    Write-Error 'The ChatGPT Windows app could not be prepared.'
    exit $LASTEXITCODE
  }
}

$task = Read-Host 'Task (leave blank to resume this lane)'
$arguments = @(
  "$PSScriptRoot\bridge.mjs",
  '--workspace', $repo,
  '--lane', $lane,
  '--advisors', ($advisors -join ','),
  '--web-visible'
)
if ($advisors.Contains('codex')) { $arguments += '--select-codex-thread' }
if ([string]::IsNullOrWhiteSpace($task)) {
  $resumeNote = Read-Host 'Optional resume note or answer for the worker'
  if (-not [string]::IsNullOrWhiteSpace($resumeNote)) {
    $env:DSH_BRIDGE_RESUME_NOTE = $resumeNote
    $arguments += @('--resume-note-env', 'DSH_BRIDGE_RESUME_NOTE')
  }
  $arguments += '--resume'
} else {
  $env:CODEX_DSH_TASK = $task
  $arguments += @('--task-env', 'CODEX_DSH_TASK')
}

& node @arguments
$bridgeExit = $LASTEXITCODE
Write-Host ''
if ($bridgeExit -eq 0) {
  Write-Host 'Bridge finished successfully.'
} elseif ($bridgeExit -eq 4) {
  Write-Host 'Bridge is waiting for user input. Run this launcher again with the same lane to resume.'
} else {
  Write-Host "Bridge stopped with exit code $bridgeExit."
}
Read-Host 'Press Enter to close'
exit $bridgeExit
