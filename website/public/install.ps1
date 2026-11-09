# Installs FliskOS on Windows: downloads the latest release, adds it to the Start menu and opens it.
#   irm https://os.flisk.si/install.ps1 | iex
# The app is not code-signed, so Windows warns about a copy downloaded in a browser. A file PowerShell saves carries no
# such mark, so this installs the same release zip with nothing to click through. It needs no administrator rights.
# Source: https://github.com/flisk-sh/fliskos (website/public/install.ps1)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Windows PowerShell 5.1 can default to TLS 1.0/1.1, which GitHub refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$dir = if ($env:FLISKOS_INSTALL_DIR) { $env:FLISKOS_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\FliskOS' }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('fliskos-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null

try {
    $zip = Join-Path $temp 'app.zip'
    Write-Host 'Downloading FliskOS...'
    if ($env:FLISKOS_ZIP) {
        Copy-Item $env:FLISKOS_ZIP $zip
    } else {
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/flisk-sh/fliskos/releases/latest/download/FliskOS-windows.zip' -OutFile $zip
    }
    $unpacked = Join-Path $temp 'app'
    Expand-Archive -Path $zip -DestinationPath $unpacked
    if (-not (Test-Path (Join-Path $unpacked 'FliskOS.exe'))) { throw 'The download did not contain FliskOS.exe.' }

    # A running copy has to close before it can be replaced.
    $exe = Join-Path $dir 'FliskOS.exe'
    Get-Process -Name FliskOS -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
    Start-Sleep -Milliseconds 500
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $dir) -Force | Out-Null
    Move-Item $unpacked $dir

    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'FliskOS.lnk'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($menu)
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = $dir
    $shortcut.Description = 'FliskOS'
    $shortcut.Save()

    Write-Host "Installed $dir"
    if (-not ((Get-Command node -ErrorAction SilentlyContinue) -or (Get-Command bun -ErrorAction SilentlyContinue))) {
        Write-Host 'FliskOS also needs Node.js 22.12+ or Bun: https://nodejs.org'
    }
    if (-not (Get-Command flisk -ErrorAction SilentlyContinue)) {
        Write-Host 'To run your projects, install the Flisk CLI: irm https://flisk.sh/install.ps1 | iex'
    }
    if (-not $env:FLISKOS_NO_OPEN) { Start-Process $exe }
} finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
