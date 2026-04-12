@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo [%date% %time%] Start fetching Threads data... >> auto-fetch.log

node fetch-threads.js >> auto-fetch.log 2>&1

if %ERRORLEVEL% EQU 0 (
    echo [%date% %time%] Fetch completed successfully >> auto-fetch.log
) else (
    echo [%date% %time%] Fetch failed, error code: %ERRORLEVEL% >> auto-fetch.log
)

echo. >> auto-fetch.log
