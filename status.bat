@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo === QQ bot (port 8643) ===
netstat -ano | findstr ":8643" | findstr "LISTENING"

echo.
echo === NapCat WebUI (port 6099) ===
netstat -ano | findstr ":6099" | findstr "LISTENING"

echo.
echo === Processes ===
tasklist | findstr /I "NapCatWinBootMain.exe"
tasklist | findstr /I "QQ.exe"

echo.
echo === Recent bot log ===
if exist "data\logs\bot.log" (
  powershell -NoProfile -Command "Get-Content -Path 'data\logs\bot.log' -Tail 12 -Encoding UTF8"
) else (
  echo data\logs\bot.log not found
)
exit /b 0
