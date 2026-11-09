# Builds dist\FliskOS-windows.zip: the native launcher and the server sources. Needs nothing beyond Windows itself.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$out = 'dist\FliskOS'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path "$out\app" | Out-Null

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /optimize+ "/out:$out\FliskOS.exe" /win32icon:windows\AppIcon.ico /reference:System.Windows.Forms.dll windows\FliskOS.cs
if ($LASTEXITCODE -ne 0) { throw 'The launcher did not compile.' }

Copy-Item src, public, package.json -Destination "$out\app" -Recurse
Compress-Archive -Path "$out\*" -DestinationPath 'dist\FliskOS-windows.zip' -Force
Write-Host "Built dist\FliskOS-windows.zip ($([math]::Round((Get-Item 'dist\FliskOS-windows.zip').Length / 1KB)) KB)"
