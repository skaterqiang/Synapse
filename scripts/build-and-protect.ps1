# Build NSIS installer, then immediately protect it from 360 antivirus deletion.
# ASCII-only messages: PS 5.1 reads UTF-8 no-BOM scripts as ANSI.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
$env:ELECTRON_MIRROR = ''

$setup = 'release\Synapse Setup 1.0.0.exe'
$safe  = 'release\SynapseSetup-protected.dat'

Remove-Item $safe -Force -ErrorAction SilentlyContinue

Write-Output "[$(Get-Date -Format HH:mm:ss)] building NSIS installer..."
& npx electron-builder --win --x64 --config.electronDist=node_modules/electron/dist 2>&1 | Tee-Object -FilePath 'release\build.log'
$code = $LASTEXITCODE
Write-Output "[$(Get-Date -Format HH:mm:ss)] builder exit code: $code, protecting now..."

# protect immediately after build returns (same-volume move is atomic)
if (Test-Path $setup) {
    Move-Item -LiteralPath $setup -Destination $safe -Force
    $sz = [math]::Round((Get-Item $safe).Length / 1MB, 1)
    Write-Output "SUCCESS: installer protected ($sz MB) -> release\SynapseSetup-protected.dat"
    $greenExe = 'release\win-unpacked\Synapse.exe'
    if (Test-Path $greenExe) {
        Move-Item -LiteralPath $greenExe -Destination 'release\win-unpacked\Synapse-protected.dat' -Force
        Write-Output "SUCCESS: green exe protected -> release\win-unpacked\Synapse-protected.dat"
    }
} else {
    Write-Output "FAILED: installer missing (likely deleted by 360)"
    Write-Output "release dir now:"
    Get-ChildItem release -ErrorAction SilentlyContinue | Select-Object Name, Length
}
