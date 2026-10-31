# Encrypted project backup (AES-256-GCM, PBKDF2-SHA256).
# Usage: pwsh -File scripts/backup-encrypted.ps1
# Password is prompted; never stored. QQBOT_BACKUP_PASSWORD is only for tests/automation.

param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$Root = (Resolve-Path $Root).Path
$data = Join-Path $Root 'data'
$config = Join-Path $Root 'config.json'
$backupDir = Join-Path $Root 'backups'

if (-not (Test-Path $data)) { throw "data directory not found: $data" }
if (-not (Test-Path $config)) { throw "config.json not found: $config" }
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

function Read-PlainPassword([string]$Prompt) {
  $secure = Read-Host -AsSecureString $Prompt
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Get-Password {
  if (-not [string]::IsNullOrEmpty($env:QQBOT_BACKUP_PASSWORD)) {
    return $env:QQBOT_BACKUP_PASSWORD
  }
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $first = Read-PlainPassword 'Backup password (min 8 chars)'
    if ($first.Length -lt 8) {
      Write-Host 'Password must be at least 8 characters.' -ForegroundColor Yellow
      continue
    }
    $second = Read-PlainPassword 'Repeat password'
    if ($first -ne $second) {
      Write-Host 'Passwords do not match, try again.' -ForegroundColor Yellow
      continue
    }
    return $first
  }
  throw 'Password was not confirmed after 3 attempts.'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tempZip = Join-Path $env:TEMP ("qqbot-backup-$stamp.zip")
$outFile = Join-Path $backupDir ("qqbot-$stamp.qbak")

try {
  Write-Host 'Creating archive (data without models + config.json)...'
  # Use Windows bsdtar explicitly: Git's GNU tar is often first on PATH and
  # does not support zip output. bsdtar preserves data/ and can exclude models.
  $tar = Join-Path $env:WINDIR 'System32\tar.exe'
  & $tar -a -c -f $tempZip -C $Root --exclude 'data/models' 'data' 'config.json'
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }

  $password = Get-Password
  $plainBytes = [IO.File]::ReadAllBytes($tempZip)

  $salt = New-Object byte[] 16
  $nonce = New-Object byte[] 12
  [Security.Cryptography.RandomNumberGenerator]::Fill($salt)
  [Security.Cryptography.RandomNumberGenerator]::Fill($nonce)
  $magic = [Text.Encoding]::ASCII.GetBytes('QQBAK1')
  $header = New-Object byte[] ($magic.Length + $salt.Length + $nonce.Length)
  [Array]::Copy($magic, 0, $header, 0, $magic.Length)
  [Array]::Copy($salt, 0, $header, $magic.Length, $salt.Length)
  [Array]::Copy($nonce, 0, $header, $magic.Length + $salt.Length, $nonce.Length)

  $key = [Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2(
    $password, $salt, 600000, [Security.Cryptography.HashAlgorithmName]::SHA256, 32)
  $cipher = New-Object byte[] $plainBytes.Length
  $tag = New-Object byte[] 16
  $aes = [Security.Cryptography.AesGcm]::new($key, 16)
  try {
    $aes.Encrypt($nonce, $plainBytes, $cipher, $tag, $header)
  } finally {
    $aes.Dispose()
    [Array]::Clear($key, 0, $key.Length)
  }

  $out = New-Object byte[] ($header.Length + $tag.Length + $cipher.Length)
  [Array]::Copy($header, 0, $out, 0, $header.Length)
  [Array]::Copy($tag, 0, $out, $header.Length, $tag.Length)
  [Array]::Copy($cipher, 0, $out, $header.Length + $tag.Length, $cipher.Length)
  [IO.File]::WriteAllBytes($outFile, $out)

  Write-Host ''
  Write-Host "Encrypted backup written: $outFile" -ForegroundColor Green
  Write-Host 'The password is NOT stored anywhere. Without it the backup cannot be recovered.'
} finally {
  if (Test-Path $tempZip) { Remove-Item $tempZip -Force }
}
