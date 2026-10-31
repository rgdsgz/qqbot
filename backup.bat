@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where pwsh >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 ^(pwsh^) is required for encrypted backups.
  echo Install it from https://aka.ms/powershell or run the old plain backup manually.
  pause
  exit /b 1
)

echo Creating an encrypted backup (data without models + config.json).
echo You will be asked for a password twice. It is NOT stored anywhere.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0qqbot\scripts\backup-encrypted.ps1"

echo.
pause
