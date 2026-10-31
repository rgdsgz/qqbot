# Restrict sensitive bot files to the current user, SYSTEM and Administrators.
# Run with the bot stopped. Re-runnable.
#
# Important: directories need (OI)(CI) inheritance flags, files need a plain F
# ACE. Applying (OI)(CI) to files recursively can leave them inaccessible, so
# this script walks each item and grants the correct form.

$ErrorActionPreference = 'Stop'
$me = "${env:COMPUTERNAME}\${env:USERNAME}"
$system = '*S-1-5-18'
$admins = '*S-1-5-32-544'
$targets = @(
  'D:\E\programming\config.json',
  'D:\E\programming\data',
  'D:\E\programming\backups',
  'D:\E\programming\napcat\NapCat.Shell\config',
  'D:\E\programming\napcat\NapCat.Shell\logs',
  'D:\E\programming\napcat\NapCat.Shell\cache'
)

function Set-ItemAcl([string]$path, [bool]$isDirectory) {
  if ($isDirectory) {
    & icacls.exe $path /inheritance:r /grant:r "${me}:(OI)(CI)F" "${system}:(OI)(CI)F" "${admins}:(OI)(CI)F" | Out-Null
  } else {
    & icacls.exe $path /inheritance:r /grant:r "${me}:F" "${system}:F" "${admins}:F" | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for $path (exit $LASTEXITCODE)" }
}

foreach ($target in $targets) {
  if (-not (Test-Path $target)) {
    Write-Host "skip missing: $target"
    continue
  }
  $root = Get-Item $target
  Set-ItemAcl $root.FullName $root.PSIsContainer
  if ($root.PSIsContainer) {
    Get-ChildItem -LiteralPath $root.FullName -Recurse -Force | ForEach-Object {
      Set-ItemAcl $_.FullName $_.PSIsContainer
    }
  }
  Write-Host "secured: $target"
}
Write-Host 'Done. Sensitive paths now allow only the current user, SYSTEM and Administrators.'
