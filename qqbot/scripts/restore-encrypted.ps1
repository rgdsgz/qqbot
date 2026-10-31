# Restore an encrypted .qbak produced by backup-encrypted.ps1.
# Extracts to restore-<timestamp>\ and never overwrites data/ directly.
# Usage: pwsh -File scripts/restore-encrypted.ps1 [-BackupFile path] [-Root path]

param(
  [string]$BackupFile = '',
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$Root = (Resolve-Path $Root).Path
$backupDir = Join-Path $Root 'backups'

if ([string]::IsNullOrWhiteSpace($BackupFile)) {
  $candidates = @(Get-ChildItem $backupDir -Filter '*.qbak' -File | Sort-Object LastWriteTime -Descending)
  if ($candidates.Count -eq 0) { throw "No .qbak backup found in $backupDir" }
  $BackupFile = $candidates[0].FullName
}
$BackupFile = (Resolve-Path $BackupFile).Path

function Read-PlainPassword([string]$Prompt) {
  $secure = Read-Host -AsSecureString $Prompt
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

$password = $env:QQBOT_BACKUP_PASSWORD
if ([string]::IsNullOrEmpty($password)) {
  $password = Read-PlainPassword 'Backup password'
}

$bytes = [IO.File]::ReadAllBytes($BackupFile)
$magic = [Text.Encoding]::ASCII.GetBytes('QQBAK1')
if ($bytes.Length -lt ($magic.Length + 16 + 12 + 16)) { throw 'Not a valid .qbak file (too short).' }
for ($i = 0; $i -lt $magic.Length; $i++) {
  if ($bytes[$i] -ne $magic[$i]) { throw 'Not a valid .qbak file (bad magic).' }
}
$offset = $magic.Length
$salt = New-Object byte[] 16
$nonce = New-Object byte[] 12
[Array]::Copy($bytes, $offset, $salt, 0, 16); $offset += 16
[Array]::Copy($bytes, $offset, $nonce, 0, 12); $offset += 12
$tag = New-Object byte[] 16
[Array]::Copy($bytes, $offset, $tag, 0, 16); $offset += 16
$cipherLength = $bytes.Length - $offset
if ($cipherLength -le 0) { throw 'Not a valid .qbak file (empty payload).' }
$cipher = New-Object byte[] $cipherLength
[Array]::Copy($bytes, $offset, $cipher, 0, $cipherLength)
$header = New-Object byte[] ($magic.Length + 16 + 12)
[Array]::Copy($bytes, 0, $header, 0, $header.Length)

$key = [Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2(
  $password, $salt, 600000, [Security.Cryptography.HashAlgorithmName]::SHA256, 32)
$plain = New-Object byte[] $cipherLength
$aes = [Security.Cryptography.AesGcm]::new($key, 16)
try {
  $aes.Decrypt($nonce, $cipher, $tag, $plain, $header)
} catch {
  throw 'Decryption failed: wrong password or the backup is corrupted/tampered.'
} finally {
  $aes.Dispose()
  [Array]::Clear($key, 0, $key.Length)
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $Root ("restore-$stamp")
$tempZip = Join-Path $env:TEMP ("qqbot-restore-$stamp.zip")
try {
  [IO.File]::WriteAllBytes($tempZip, $plain)
  New-Item -ItemType Directory -Force -Path $target | Out-Null

  # The project root may be readable by other local accounts; the restored
  # copy contains config.json and chat data. Lock the target before extracting
  # so children inherit the private ACL.
  $me = "${env:COMPUTERNAME}\${env:USERNAME}"
  & icacls.exe $target /inheritance:r /grant:r "${me}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  Expand-Archive -Path $tempZip -DestinationPath $target -Force

  Write-Host ''
  Write-Host "Restored to: $target" -ForegroundColor Green
  Write-Host 'Review it, then copy data\ and config.json to the project root while the bot is stopped.'
  Write-Host 'The original files were not overwritten.'
} finally {
  if (Test-Path $tempZip) { Remove-Item $tempZip -Force }
  [Array]::Clear($plain, 0, $plain.Length)
}
