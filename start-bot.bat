@echo off
setlocal EnableExtensions
if exist "%~dp0qqbot\dist\standalone\main.js" (
  cd /d "%~dp0qqbot"
) else (
  cd /d "%~dp0dsh-onebot"
)

echo Starting QQ bot...
echo Keep this window open. Close it only when you want to stop the bot.
echo.
node dist\standalone\main.js --config ..\config.json > ..\data\logs\bot.log 2>&1

echo.
echo Bot exited. Press any key to close this window.
pause
