# ring-vision panel launcher (ASCII only; Chinese paths come from node-path.txt, read as UTF-8)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$node = $null
$hint = Join-Path $PSScriptRoot "node-path.txt"
if (Test-Path $hint) {
  $p = (Get-Content $hint -Raw -Encoding UTF8).Trim()
  if ($p -and (Test-Path $p)) { $node = $p }
}
if (-not $node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
  Write-Host "node.exe not found."
  Write-Host "Write the FULL path of node.exe into node-path.txt (UTF-8) and retry."
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "Node: $node"
Write-Host ""
& $node src\panel.mjs

Write-Host ""
Write-Host "Panel exited."
Read-Host "Press Enter to close"
