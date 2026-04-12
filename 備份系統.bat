@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

:: 產生時間戳記（格式：20260408_1530）
for /f "tokens=2 delims==" %%a in ('wmic OS Get LocalDateTime /value') do set dt=%%a
set STAMP=%dt:~0,8%_%dt:~8,4%

:: 備份目標資料夾
set BACKUP_DIR=%~dp0..\備份\%STAMP%
mkdir "%BACKUP_DIR%" >nul 2>&1

:: 複製核心檔案（不含 node_modules）
copy "%~dp0server.js"           "%BACKUP_DIR%\" >nul
copy "%~dp0app.js"              "%BACKUP_DIR%\" >nul
copy "%~dp0index.html"          "%BACKUP_DIR%\" >nul
copy "%~dp0style.css"           "%BACKUP_DIR%\" >nul
copy "%~dp0threads-data.json"   "%BACKUP_DIR%\" >nul 2>&1
copy "%~dp0follower-history.json" "%BACKUP_DIR%\" >nul 2>&1
copy "%~dp0package.json"        "%BACKUP_DIR%\" >nul
copy "%~dp0CLAUDE.md"           "%BACKUP_DIR%\" >nul

echo.
echo  備份完成！
echo  位置：%BACKUP_DIR%
echo.
echo  ※ .env 未備份（含敏感資訊），請自行保管 API Key
echo.
echo ============================================
echo  是否需要更新 CLAUDE.md 系統說明文件？
echo  （有新功能 / 改架構時建議更新）
echo  按 Y 開啟 CLAUDE.md，按其他鍵略過
echo ============================================
set /p UPDATE_CLAUDE=請選擇（Y/N）：
if /i "%UPDATE_CLAUDE%"=="Y" (
  notepad "%~dp0CLAUDE.md"
)
echo.
pause
