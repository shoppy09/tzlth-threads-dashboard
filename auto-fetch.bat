@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo [%date% %time%] Start fetching Threads data... >> auto-fetch.log

node fetch-threads.js >> auto-fetch.log 2>&1

if %ERRORLEVEL% EQU 0 (
    echo [%date% %time%] Fetch completed successfully >> auto-fetch.log

    REM 自動推送到 GitHub，讓總部儀表板能讀到最新數據
    git add follower-history.json threads-data.json >> auto-fetch.log 2>&1
    git commit -m "auto: sync Threads data [%date%]" >> auto-fetch.log 2>&1
    git push >> auto-fetch.log 2>&1

    if %ERRORLEVEL% EQU 0 (
        echo [%date% %time%] GitHub push completed >> auto-fetch.log
    ) else (
        echo [%date% %time%] GitHub push failed, data saved locally only >> auto-fetch.log
    )
) else (
    echo [%date% %time%] Fetch failed, error code: %ERRORLEVEL% >> auto-fetch.log
)

echo. >> auto-fetch.log
