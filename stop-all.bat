@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo [1/2] Stopping the QQ bot...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8643" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
)

echo [2/2] Stopping NapCat and QQ (small account)...
taskkill /IM NapCatWinBootMain.exe /F >nul 2>&1
taskkill /IM QQ.exe /F >nul 2>&1

echo Done. The small account may need a QR login on the next start.
ping -n 4 127.0.0.1 >nul
exit /b 0
