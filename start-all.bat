@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "NAPCAT_DIR=%~dp0napcat\NapCat.Shell"
set "APP_DIR=%~dp0qqbot"
if not exist "%APP_DIR%\dist\standalone\main.js" set "APP_DIR=%~dp0dsh-onebot"
set "CONFIG=%~dp0config.json"
set "NAPCAT_DISABLE_MULTI_PROCESS=1"

if not exist "%CONFIG%" (
  echo [qqbot] config.json not found in project root.
  pause
  exit /b 1
)
if not exist "%APP_DIR%\dist\standalone\main.js" (
  echo [qqbot] %APP_DIR%\dist\standalone\main.js not found.
  echo [qqbot] Run these once in %APP_DIR%:
  echo [qqbot]   npm install --include=dev --legacy-peer-deps
  echo [qqbot]   npm run build:standalone
  pause
  exit /b 1
)
if not exist "%NAPCAT_DIR%\launcher-user.bat" (
  echo [qqbot] NapCat not found at %NAPCAT_DIR%
  echo [qqbot] Edit NAPCAT_DIR at the top of this script.
  pause
  exit /b 1
)
if not exist "%~dp0data" mkdir "%~dp0data"
if not exist "%~dp0data\logs" mkdir "%~dp0data\logs"

set "NAPCAT_RUNNING="
netstat -ano | findstr ":6099" | findstr "LISTENING" >nul
if not errorlevel 1 set "NAPCAT_RUNNING=1"

if defined NAPCAT_RUNNING (
  echo [1/2] NapCat is already running on port 6099, skipped.
) else (
  echo [1/2] Starting NapCat and the QQ small account...
  start "NapCat" "%~dp0start-napcat.bat"
  ping -n 4 127.0.0.1 >nul
)

set "BOT_RUNNING="
netstat -ano | findstr ":8643" | findstr "LISTENING" >nul
if not errorlevel 1 set "BOT_RUNNING=1"

if defined BOT_RUNNING (
  echo [2/2] QQ bot is already running on port 8643, skipped.
) else (
  echo [2/2] Starting QQ bot...
  start "QQBot" "%~dp0start-bot.bat"
)

echo.
echo ============================================================
echo  Project root : %~dp0
echo  Bot log      : %~dp0data\logs\bot.log
echo  NapCat WebUI : http://127.0.0.1:6099/webui
echo.
echo  If the small account asks for a QR login, open the WebUI
echo  and scan with the small account.
echo ============================================================
ping -n 6 127.0.0.1 >nul
exit /b 0
