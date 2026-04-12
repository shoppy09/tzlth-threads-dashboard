@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo.
echo   ╔═══════════════════════════════════════╗
echo   ║   Threads Dashboard                   ║
echo   ║   正在啟動儀表板...                    ║
echo   ╚═══════════════════════════════════════╝
echo.

:: 開啟瀏覽器
start "" "http://localhost:3939"

:: 啟動伺服器（視窗保持開啟）
node server.js
