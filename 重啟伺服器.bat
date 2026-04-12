@echo off
chcp 65001 >nul 2>&1
echo.
echo   正在關閉舊的伺服器...
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

echo   啟動新伺服器...
echo.
cd /d "%~dp0"
node server.js
