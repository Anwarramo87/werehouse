# Prepared (NOT auto-executed) secret-rotation helper.
# Generates new JWT_SECRET and shows the exact .env lines to update.
# It does NOT touch the database or Neon — DATABASE_URL rotation must be done
# in the Neon console, then paste the new URL below.
#
# Usage:
#   node rotate-secrets.ps1            # dry-run: prints new values + .env snippet
#   node rotate-secrets.ps1 -Apply     # also writes the new JWT_SECRET into .env
#
# SECURITY: run only on a trusted machine. Output contains secrets — do not
# paste into chat or logs. After applying, restart the backend.

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

function New-RandomBase64($bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return [Convert]::ToBase64String($b)
}

$newJwt = New-RandomBase64 48
$newAdmin = New-RandomBase64 12
$newDev = New-RandomBase64 12
$newSuper = New-RandomBase64 12

Write-Host "=== NEW SECRET VALUES (keep these in your secret manager) ===" -ForegroundColor Cyan
Write-Host "JWT_SECRET=""$newJwt"""
Write-Host "ADMIN_BOOTSTRAP_PASSWORD=""$newAdmin"""
Write-Host "DEV_ADMIN_PASSWORD=""$newDev"""
Write-Host "SUPERADMIN_PASSWORD=""$newSuper"""
Write-Host ""

Write-Host "=== .env lines to update ===" -ForegroundColor Cyan
Write-Host "JWT_SECRET=""$newJwt"""
Write-Host "ADMIN_BOOTSTRAP_PASSWORD=""$newAdmin"""
Write-Host "DEV_ADMIN_PASSWORD=""$newDev"""
Write-Host "SUPERADMIN_PASSWORD=""$newSuper"""
Write-Host "DATABASE_URL=""postgresql://neondb_owner:<NEW_NEON_PASSWORD>@ep-solitary-cell-apbzmvgx-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require"""
Write-Host ""

if ($Apply) {
  $envPath = Join-Path $PSScriptRoot '..\.env'
  if (-not (Test-Path $envPath)) { Write-Error ".env not found at $envPath"; exit 1 }
  $lines = Get-Content $envPath
  $updated = $lines | ForEach-Object {
    if ($_ -match '^JWT_SECRET=') { "JWT_SECRET=""$newJwt""" }
    elseif ($_ -match '^ADMIN_BOOTSTRAP_PASSWORD=') { "ADMIN_BOOTSTRAP_PASSWORD=""$newAdmin""" }
    elseif ($_ -match '^DEV_ADMIN_PASSWORD=') { "DEV_ADMIN_PASSWORD=""$newDev""" }
    elseif ($_ -match '^SUPERADMIN_PASSWORD=') { "SUPERADMIN_PASSWORD=""$newSuper""" }
    else { $_ }
  }
  # DATABASE_URL left for manual update (Neon password rotated in console).
  Set-Content -Path $envPath -Value $updated
  Write-Host "Updated JWT_SECRET + admin passwords in $envPath" -ForegroundColor Green
  Write-Host "ACTION REQUIRED: rotate the Neon DB password in the Neon console, then update DATABASE_URL manually." -ForegroundColor Yellow
  Write-Host "Then restart the backend." -ForegroundColor Yellow
} else {
  Write-Host "Dry-run only. Re-run with -Apply to write JWT_SECRET + admin passwords into .env." -ForegroundColor Yellow
  Write-Host "DATABASE_URL must be updated manually after rotating the Neon password." -ForegroundColor Yellow
}
