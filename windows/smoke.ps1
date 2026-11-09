# Installs the built zip the way a user would, opens FliskOS, and checks the whole life of the app: its window opens on
# a working server, and closing the window shuts everything down.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$dir = Join-Path $env:RUNNER_TEMP 'FliskOS-install'

$env:FLISKOS_ZIP = Join-Path $root 'dist\FliskOS-windows.zip'
$env:FLISKOS_INSTALL_DIR = $dir
$env:FLISKOS_NO_OPEN = '1'
$env:FLISKOS_STATE = Join-Path $env:RUNNER_TEMP 'fliskos-state.json'
& (Join-Path $root 'website\public\install.ps1')

$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'FliskOS.lnk'
if (-not (Test-Path $menu)) { throw 'The Start menu shortcut was not created.' }

function Get-Window {
    Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" |
        Where-Object { $_.CommandLine -like '*--app=*' -and $_.CommandLine -like '*FliskOS\window*' } |
        Select-Object -First 1
}

$app = Start-Process (Join-Path $dir 'FliskOS.exe') -PassThru
$window = $null
foreach ($attempt in 1..60) {
    $window = Get-Window
    if ($window -or $app.HasExited) { break }
    Start-Sleep -Seconds 1
}
if (-not $window) { throw "No FliskOS window opened (launcher exited: $($app.HasExited))." }

if ($window.CommandLine -notmatch '--app="?(http://127\.0\.0\.1:\d+/\?token=[0-9a-f]+)') { throw 'The window was not opened on the local server.' }
$page = Invoke-WebRequest -UseBasicParsing -Uri $Matches[1]
if ($page.StatusCode -ne 200 -or $page.Content -notmatch 'FliskOS') { throw 'The local server did not serve the app.' }
Write-Host 'The window is open on a working server.'

# Edge must keep the launcher waiting; if its first process handed off and exited, the server would already be gone.
Start-Sleep -Seconds 8
if ($app.HasExited) { throw 'The launcher quit while the window was still open.' }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$image = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
[System.Drawing.Graphics]::FromImage($image).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$image.Save((Join-Path $root 'dist\windows-screen.png'))

Stop-Process -Id $window.ProcessId -Force
Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*FliskOS\window*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (-not $app.WaitForExit(30000)) { throw 'The launcher kept running after its window closed.' }
Start-Sleep -Seconds 2
$left = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$dir*cli.js*" }
if ($left) { throw 'The server kept running after the app closed.' }
Write-Host 'Closing the window shut everything down.'
