param(
  [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'release')
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$out = Join-Path $OutDir "backend-nest-$stamp.zip"
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
$argsList = @('-a', '-c', '-f', $out)
$patterns = @('.git','node_modules','dist','release','.env','.env.local','.env.*.local','.env.bak*','cookies.txt','tmp','*.log','*.tsbuildinfo','*.zip')
foreach ($p in $patterns) { $argsList += @('--exclude', $p) }
$argsList += @('-C', $root, '.')
& tar $argsList
if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
Write-Output "release archive: $out"