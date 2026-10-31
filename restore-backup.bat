@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where pwsh >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 ^(pwsh^) is required to restore encrypted backups.
  pause
  exit /b 1
)

echo Restoring the newest .qbak into a restore-* folder.
echo It will NOT overwrite data\ or config.json.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0qqbot\scripts\restore-encrypted.ps1"

echo.
pause
