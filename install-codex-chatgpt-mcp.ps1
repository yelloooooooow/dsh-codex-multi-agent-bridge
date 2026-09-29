$ErrorActionPreference = 'Stop'

$server = Join-Path $PSScriptRoot 'codex-chatgpt-mcp.mjs'
$package = Join-Path $PSScriptRoot 'package.json'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is not available on PATH.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'npm is not available on PATH.'
}
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  throw 'Codex CLI is not available on PATH.'
}
if (-not (Test-Path -LiteralPath $server) -or -not (Test-Path -LiteralPath $package)) {
  throw 'The Codex ChatGPT MCP files are incomplete.'
}

Push-Location $PSScriptRoot
try {
  npm install --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }

  $configured = codex mcp list 2>&1 | Select-String -SimpleMatch 'dsh_chatgpt_advisor'
  if ($configured) {
    codex mcp remove dsh_chatgpt_advisor
    if ($LASTEXITCODE -ne 0) { throw "codex mcp remove failed with exit code $LASTEXITCODE" }
  }
  codex mcp add dsh_chatgpt_advisor -- node $server
  if ($LASTEXITCODE -ne 0) { throw "codex mcp add failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'Codex -> ChatGPT consultation is installed.' -ForegroundColor Green
Write-Host 'Start a new Codex conversation or restart the Codex app to load the consult_chatgpt tool.'
Write-Host 'The tool requires a stable lane name so parallel Codex conversations do not share messages.'
Write-Host 'Codex app mode uses isolated Web delivery; the same cloud conversation is visible in the Windows app when both use the same account and workspace.'
