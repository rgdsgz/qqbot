@echo off
setlocal EnableExtensions
cd /d "%~dp0napcat\NapCat.Shell"

set "NAPCAT_DISABLE_MULTI_PROCESS=1"

echo Starting NapCat...
echo Keep this window open. Close it only when you want to stop NapCat.
echo.
launcher-user.bat

echo.
echo NapCat exited. Press any key to close this window.
pause
