# Threads 分析儀表板 — 系統說明（供 Claude 讀取）

## 專案概述
為 Threads 帳號 @cda_pu_positive_thinking（職涯停看聽，5126 粉絲）建立的本地分析儀表板。
提供貼文數據分析、帳號健檢、AI 建議、電子報生成等功能。

## 技術架構
- **前端**：純 HTML/CSS/JS（index.html, style.css, app.js）
- **部署平台**：Vercel（Serverless Functions，api/ 目錄）+ GitHub Actions（cron 資料同步）
- **本機開發**：node server.js（port 3939）；server.js 保留供本機除錯，不部署至 Vercel
- **資料同步**：GitHub Actions cron（每日台灣時間 10:00 / 22:00）自動執行 fetch-threads.js，commit threads-data.json + follower-history.json 至 repo
- **資料讀取**：Vercel Functions 透過 GitHub raw URL 讀取（repo 為 public，branch: master；GITHUB_PAT 可選，預防未來轉 private）
- **AI**：Google Gemini API（gemini-2.5-flash），直接 HTTPS 呼叫
- **線上 URL**：https://threads-dashboard-lime.vercel.app

## 重要設定
- **Vercel 環境變數（必填）**：THREADS_ACCESS_TOKEN / GOOGLE_AI_API_KEY / GITHUB_PAT（需要 repo + workflow scope）
- **本機 .env**：THREADS_ACCESS_TOKEN, TOKEN_CREATED_AT, GOOGLE_AI_API_KEY（本機開發用）
- **vercel.json**：maxDuration 60s（publish-single）/ 30s（nl-convert, ai-split-thread）；`"github":{"enabled":false}` 已廢棄被 Vercel 忽略，**git push 仍會觸發自動部署**（2026-04-29 IMP-088 確認）；正確停用方式：Project Settings → Git → Ignored Build Step → `exit 1`（等 Tim 確認後設定）
- **⚠️ Hobby plan 12 函數上限**：目前 api/ 有 11 個檔案 = 11 個 Serverless Functions，剩餘 1 個名額。新增任何 api/*.js 前必須先確認總數不超過 12
- **GitHub Actions secret**：THREADS_ACCESS_TOKEN（Settings → Secrets and variables → Actions）
- Newsletter API 路由：POST /api/nl-convert

## 檔案結構
```
threads-dashboard/
├── server.js          # Express 後端，所有 API 路由
├── app.js             # 前端邏輯（2500+ 行）
├── index.html         # UI 結構，6 個分頁
├── style.css          # 樣式
├── .env               # API Keys（不可外洩）
├── threads-data.json  # 同步後的貼文資料
├── follower-history.json # 粉絲成長記錄
├── CLAUDE.md          # 本檔案
├── start-dashboard.bat    # 啟動伺服器
├── 重啟伺服器.bat         # 強制關閉舊程序後重啟
└── 開啟設定檔.bat         # 用記事本開啟 .env
```

## 分頁功能
1. **儀表板**（dashboard）：KPI 概覽、互動趨勢圖、貼文類型分布、爆文排行
2. **貼文列表**（posts）：可排序篩選的完整貼文表格，支援刪除
3. **深度洞察**（insights）：關鍵字分析、最佳發文時間、互動率分布
4. **AI 建議**（suggest）：根據歷史數據生成下一篇建議
5. **帳號健檢**（health）：整體健康評分、各面向分析
6. **創作工具箱**（input）：草稿分析器、hashtag 工具
7. **電子報工具**（newsletter）：4 步驟電子報生成，含 AI 轉換

## 貼文資料欄位
- id, date, time, type（分類）, media, title（80字截斷）, fullText（完整原文）
- likes, comments, reposts, shares, views, hashtags, notes, permalink
- isQuotePost（是否為引用貼文）

## 貼文分類邏輯（classifyPost）
使用 fullText.length 判斷，不是 title.length：
- isQuotePost → 串文
- fullLen < 120 → 觀點短文
- 關鍵字符合（戳破/陷阱等）→ 長文觀點
- fullLen >= 280 → 長文觀點
- fullLen < 200 → 觀點短文
- 其他 → 長文觀點

## 電子報系統（Newsletter）
### 流程
Step 1：選日期區間 → Step 2：選文章（依互動排序）→ Step 3：AI 設定 → Step 4：預覽匯出

### 關鍵函數
- nlBuildPrompt(inputText, cfg)：建構 Gemini Prompt
- nlParseOutput(raw)：解析 AI 輸出的「件名：」和「內文：」
- stripMarkdown(text)：移除 AI 回傳的 Markdown 符號
- nlBuildHtml / nlBuildText：生成預覽和純文字版本

### 已知問題與解法
- Express 5 不支援 app.post('/api/newsletter/convert')（多層路徑）→ 改用 /api/nl-convert
- IPv6 問題：舊伺服器綁定 127.0.0.1，瀏覽器用 ::1 → 改用 HOST='localhost'
- Gemini 回傳 Markdown → stripMarkdown() 處理
- 輸出截斷 → maxOutputTokens 設為 8192

## 安全設定
- 敏感檔案（.env, server.js 等）被 middleware 封鎖，無法直接從瀏覽器存取
- 速率限制：/api/nl-convert 每分鐘最多 20 次
- node_modules 目錄封鎖

## 常見指令
```bash
# 啟動
node server.js

# 強制重啟（關閉所有 node 程序）
taskkill /F /IM node.exe && node server.js

# 查看可用 Gemini 模型
curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY"
```

## 新增功能（v18 升級）
- **貼文完整內容 Modal**：點擊貼文列表的標題欄位，彈出 modal 顯示 fullText 完整內文 + 互動數字 + 原文連結
- **貼文 CSV 匯出**：貼文列表右上角「匯出 CSV」，含 fullText、permalink、BOM 前綴（Excel 正確顯示中文）
- **電子報模式按鈕**：將閾值滑桿替換為三個模式按鈕（短文擴寫/標準整理/長文精華），隱藏的 nl-thresh1/nl-thresh2 input 保留向後相容
- **nlSetMode(mode)**：app.js 中的函數，對應 short/mid/long 三種模式，更新 thresh 值及 nl-mode-active 樣式
- **資料驗證**：loadPosts() 含 showDataWarning() 提示格式異常數據
- **Token 警告升級**：<14 天顯示黃色警告，≤3 天顯示紅色緊急警告（warning-red class）
- **outlier 偵測**：detectOutliers(postsArr, metricFn) 用 IQR×3 找出爆文，健檢頁顯示 outlier 提示卡片
- **星期幾分析**：insights 頁新增星期幾互動率分析 + mini 橫條圖
- **貼文類型趨勢表**：insights 頁顯示近 3 個月每月各類型貼文數
- **KPI 對比**：compareToggle 按鈕啟用後，KPI 卡片顯示 ▲/▼ 變化百分比（.kpi-up/.kpi-down 樣式）

## 新增功能（v19 升級）
- **貼文關鍵字搜尋**：貼文列表 filter-row 新增搜尋框，即時過濾 title + fullText
- **批量刪除**：貼文列表加 checkbox 多選 + `#batchDeleteBtn`，`selectAllPosts` 全選
- **Modal 筆記**：modal 內 `#modalNotes` textarea，關閉時自動儲存到 post.notes
- **Modal 類型修改**：modal header 加 `#modalTypeEdit` select，即時更新分類並存檔
- **Esc 關閉 Modal**：全域 keydown 監聽，Esc 觸發 saveModalNotes() 後關閉
- **發文空窗提醒**：`#vacancyWarning`，≥3 天黃色，≥5 天紅色緊急警告
- **localStorage 容量監控**：savePosts() 含大小檢查，>4MB 警告，QuotaExceededError 緊急提示
- **電子報歷史記錄**：`nl_history` localStorage key，最多 20 筆，`#nlHistorySection` 可展開/收起
- **增量同步**：`/api/sync?mode=incremental`（預設），只抓上次同步後的新貼文，Shift+點擊為完整同步
- **同步進度回報**：`/api/sync-progress` 端點 + 前端 1.5 秒輪詢，`#syncText` 顯示即時進度
- **Debounce**：所有 filter 事件加 debounce（typeFilter 150ms、periodFilter 200ms、searchFilter 250ms）
- **Error Boundaries**：generateInsights/Health/Suggestions 用 try-catch 包裝，錯誤時顯示友善訊息

## syncBtn 操作說明
- 點擊 → 觸發 GitHub Actions workflow_dispatch（需 GITHUB_PAT env var）
- 若未設定 GITHUB_PAT → 顯示「資料每日 10:00 / 22:00 自動更新」說明訊息
- 資料更新由 cron.yml 每日自動執行，無需手動觸發

## 新增功能（v20 升級）— 長文串文轉換器

### 位置
創作工具箱（`input` 分頁）→ Tool 4：📖 長文串文轉換器

### 功能說明
將 1000–5000 字長文智慧切割成多篇串連的 Threads 串文。
讀者點開第 1 篇，往下滑即可在同一串文內連續讀完全文。

### API 機制（Threads 串文原理）
```
第 1 篇：reply_to_id = null       → post_id = AAA（主帖）
第 2 篇：reply_to_id = AAA        → post_id = BBB（回覆主帖）
第 3 篇：reply_to_id = BBB        → 依此類推
```
Phase 1 只做切割+預覽，實際發文（reply_to_id）在 Phase 2 實作。

### 新增端點
- `POST /api/ai-split-thread`：呼叫 Gemini 切割長文，回傳 JSON 陣列

### 前端關鍵函數（app.js）
- `tsRenderPosts()`：渲染可編輯的串文卡片列表
- `tsUpdatePost(id, value)`：即時更新字數與進度條
- `tsMoveUp/Down(idx)`：調整篇序
- `tsSplitPost(idx)`：在句號/換行處拆成兩篇
- `tsAddPost()`：插入空白篇
- `tsUpdateSeqNumbers()`：重新計算所有篇的 (N/M) 篇號
- `tsAiAdjust(id, mode)`：AI 快速調整單篇（縮短/強化開頭/加強結尾）
- `tsTogglePreview()`：切換手機版串文預覽
- `tsRenderPhonePreview()`：渲染仿 Threads UI 的串文預覽
- `tsSaveDraft()`：儲存到 localStorage `ts_drafts`（最多 30 筆）

### 設定選項
- 每篇目標字數：200 / 300（預設）/ 400 字
- 最多篇數：3 / 4 / 5（預設）/ 6 / 8 篇
- 第一篇風格：強力鉤子（預設）/ 懸念式 / 保留原文

### 字數規則
- 每篇結尾自動附加 (N/總篇數)
- 進度條：綠色（≤380字）→ 橘色（381-450字）→ 紅色（>450字，接近 500 字 API 上限）

## 新增功能（v21 升級）— 串文發布系統（Vercel 版）

### API 端點（api/ 目錄，Vercel Serverless Functions）
- `GET /api/test-publish`：建立測試 container 驗證 Token 是否有 `threads_content_publish` 權限（不實際發布）
- `POST /api/publish-single`：發布單篇貼文（~32s，含 30s sleep）；前端依序呼叫實現串文發布
- `GET /api/token-check`：快速確認 THREADS_ACCESS_TOKEN 是否已設定
- `GET /api/fetch-log`：回傳 GitHub Actions 同步說明（非 filesystem log）
- `GET /api/weekly-report`：從私有 repo 讀取 threads-data.json 計算週報
- `POST /api/nl-convert`：Gemini 自然語言轉換
- `POST /api/ai-split-thread`：Gemini 長文串文切割
- `GET /api/trigger-sync`：觸發 GitHub Actions workflow_dispatch（需 GITHUB_PAT）
- `GET /api/threads-data`：從私有 repo 代理讀取 threads-data.json（GITHUB_PAT auth）
- `GET /api/followers`：從私有 repo 代理讀取 follower-history.json（GITHUB_PAT auth）

### 串文發布流程（Vercel 架構）
```
前端 for loop:
  POST /api/publish-single { text, replyToId, userId }
    → Step 1: GET /me 取 userId（僅第一篇）
    → Step 2: POST /{userId}/threads (container)
    → Step 3: sleep(30000)  ← vercel.json maxDuration:60 確保不 timeout
    → Step 4: POST /{userId}/threads_publish
    → Step 5: GET permalink（選用）
    ← 回傳 { postId, userId, permalink }
  replyToId = postId  ← 傳給下一篇
```

### 前端互動流程（app.js）
- `window.tsPublish()`：同步 textarea 內容、驗證字數、顯示確認摘要
- `window.tsConfirmPublish()`：sequential await loop 呼叫 /api/publish-single，即時更新步驟列表
- `window.tsTestPublish()`：呼叫 GET /api/test-publish，顯示 Token 是否有發文權限

### 注意
- pub-history.json 在 Vercel 無 filesystem，MVP 跳過（不影響核心發文）
- 移除：/api/publish-thread（202 async，Vercel 不支援）
- 移除：/api/publish-progress（SSE，Vercel 不支援長連線）
- 移除：/api/sync（本機 Express 端點）、/api/sync-progress（SSE）

### 使用前提
Token 必須有 `threads_content_publish` scope，可用「測試發文權限」按鈕驗證

## 待改進項目
- 串文（isQuotePost）判斷依賴 Threads API is_quote_post 欄位
- 長文串文 Phase 3：排程串文 + 圖片發文支援
- start-dashboard.bat 可自動遞增 cache 版本號

---
## ⚡ 跨視窗同步協議（最高優先規則）

> 所有對話視窗共用檔案系統。**文件是各視窗之間唯一的共用記憶。**

### ⛔ 每次完成任何修改後，必須執行收尾五件事（新增第 0 步）：
0. **git commit + git push 到 GitHub**（此 repo：shoppy09/tzlth-threads-dashboard）
   - 原因：總部儀表板從 GitHub API 讀取資料，本地修改不 push = 儀表板永遠看不到
   - 必須 push 的檔案：`follower-history.json`、`threads-data.json`、任何 .js/.html/.css 修改
   - auto-fetch.bat 已自動執行 push（2026-04-14 更新）；手動修改 Claude 必須手動 push
1. **更新本文件「最近修改記錄」**（見下表）
2. **更新總部任務清單**：`C:\Users\USER\Desktop\tzlth-hq\dev\tasks.md`
3. **更新每日日誌**：`C:\Users\USER\Desktop\tzlth-hq\reports\daily-log.md`
4. **寫入反思日誌**：`C:\Users\USER\Desktop\tzlth-hq\reports\reflection-log.md`（有實質改善價值才寫）

> 未完成收尾五件事 = 任務未完成。本地修改不 push = 等於沒做。

### 最近修改記錄

| 日期 | 修改內容 | 執行視窗 | 狀態 |
|------|---------|---------|------|
| 2026-04-14 | fetch-threads.js 新增步驟 6：auto-fetch 排程呼叫 threads_insights endpoint 抓取 followers_count，寫入 follower-history.json；修復 6 天未更新問題 | 開發部 | ✅ |
| 2026-04-21 | 遷移至 Vercel + GitHub Actions：新增 12 個 api/*.js（threads-data/followers/weekly-report/nl-convert/ai-split-thread/token-check/fetch-log/test-publish/publish-single/trigger-sync）+ .github/workflows/cron.yml + vercel.json；app.js 移除 SSE polling、改 sequential publish loop、autoLoadApiData 改 /api/threads-data；server.js 保留本機開發用 | 開發部 | ✅ |

---
## 總部連結（TZLTH-HQ）
- 系統代號：SYS-02
- 總部路徑：C:\Users\USER\Desktop\tzlth-hq
- HQ 角色：Threads 內容的數據中心。追蹤發文績效、追蹤者成長、提供 AI 內容建議，支撐行銷部決策。
- 存檔規定：auto-fetch.bat 每次執行後自動 git commit + push（2026-04-14 起）。手動發文時 pub-history.json 自動記錄。Claude 手動修改任何檔案後必須立即 push。
- 拉取欄位：follower-history.json（追蹤者數）、threads-data.json 最後 20 筆（近期貼文績效）、auto-fetch.log 最後幾行（確認抓取正常）
---
