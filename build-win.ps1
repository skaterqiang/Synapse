# Synapse Windows build script: produces the NSIS installer (.exe)
# Usage: npm run dist:win  or  powershell -ExecutionPolicy Bypass -File build-win.ps1
#
# Steps:
#   1. Clean stale Windows artifacts under release/ (win-unpacked dir + .exe installers)
#   2. Run electron-builder with the win/nsis config in package.json (target=nsis)
#   3. Verify and report the installer location
#
# Note: The installer is unsigned (no Authenticode certificate). On first run,
# SmartScreen may warn "Windows protected your PC" - click "More info -> Run anyway".
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$App = 'Synapse'
$Version = node -p "require('./package.json').version"
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$Out = 'release'

Write-Host "==> Building $App $Version (Windows $Arch) installer"

Write-Host '==> [1/3] Cleaning stale Windows artifacts'
Remove-Item -Recurse -Force "$Out\win-unpacked" -ErrorAction SilentlyContinue
Get-ChildItem $Out -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.exe$' } |
  Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "==> [2/3] Running electron-builder (--win --$Arch)"
& npx electron-builder --win --$Arch
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed (exit code $LASTEXITCODE)" }

Write-Host '==> [3/3] Verifying artifacts'
$setup = Get-ChildItem $Out -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "$App*" -and $_.Name -match '\.exe$' } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw "No .exe installer found under $Out/, check the build log above" }

Write-Host ''
Write-Host "Build finished. Artifacts in $Out/ :"
Get-ChildItem $Out | Where-Object { $_.Name -match '\.exe$' } |
  ForEach-Object { Write-Host ("  {0,-60} {1,10:N1} MB" -f $_.Name, ($_.Length / 1MB)) }
Write-Host ''
Write-Host 'Install:'
Write-Host ("  Double-click {0} and follow the wizard (install dir is customizable)" -f $setup.Name)
Write-Host '  SmartScreen warning on first run: More info -> Run anyway'
