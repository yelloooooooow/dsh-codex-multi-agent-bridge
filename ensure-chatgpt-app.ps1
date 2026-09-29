param(
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

$running = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if ($running) {
  Write-Host 'ChatGPT Windows app is ready.'
  exit 0
}

$package = Get-AppxPackage OpenAI.Codex -ErrorAction SilentlyContinue
if (-not $package -or -not $package.InstallLocation) {
  Write-Error 'The ChatGPT Windows application package OpenAI.Codex was not found.'
  exit 1
}

$appId = "$($package.PackageFamilyName)!App"
Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$appId"

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
  $running = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if ($running) {
    Write-Host 'ChatGPT Windows app started.'
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

Write-Error 'The ChatGPT Windows app did not create a visible window before the timeout.'
exit 1
