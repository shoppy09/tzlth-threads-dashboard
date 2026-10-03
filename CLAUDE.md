# Threads 分析儀表板 — 系統說明（供 Claude 讀取）

## 專案概述
為 Threads 帳號 @cda_pu_positive_thinking（職涯停看聽）建立的分析儀表板；線上版在 Vercel、全站需登入。追蹤者數不在本檔寫死，見 HQ `social/metrics.json`（2026-10-03 更正，架構全貌見 HQ `projects/SYS-02-threads.md`）。
提供貼文數據分析、帳號健檢、AI 建議、電子報生成等功能。

## 技術架構
- **前端**：純 HTML/CSS/JS（index.html, style.css, app.js）
- **部署平台**：Vercel（Serverless Functions，api/ 目錄）+ GitHub Actions（cron 資料同步）
- **本機開發**：node server.js（port 3939）；server.js 保留供本機除錯，不部署至 Vercel
- **資料同步**：由 **HQ** 的 `fetch-threads.yml` 排定每日台灣 09:00／21:00 執行本 repo 的 fetch-threads.js，commit threads-data.json + follower-history.json 回本 repo（實際到達常晚 5.5-7 小時）。本 repo 的 `cron.yml` **只剩手動觸發**（「立即同步」按鈕用），沒有排程（2026-10-03 更正，架構全貌見 HQ `projects/SYS-02-threads.md`）
- **資料讀取**：Vercel Functions 透過 GitHub raw URL 讀取（repo 為 public，branch: master；GITHUB_PAT 可選，預防未來轉 private）
- **AI**：Google Gemini API（**`gemini-3.1-flash-lite`**，直接 HTTPS 呼叫）。⚠️ 刻意不用 `gemini-flash-latest` 滾動別名——別名會被靜默熱抽換（官方僅承諾 2 週預告），而本站 AI 端點吃 30s 硬砍；釘版另使 soplint I13 能倒數退場日（`shutdown_date=null` 的別名 I13 直接跳過）。⛔ **2026-09-08 由 `gemini-2.5-flash` 遷移**（該版 2026-10-16 退場，RCF-123 補記三）：四個呼叫點（`api/nl-convert.js`／`api/ai-split-thread.js`／`server.js` ×2）同批換版並全數補 `generationConfig.thinkingConfig.thinkingBudget: 0`——其中 `nl-convert` 原本**連 `generationConfig` 都沒有**，等於 thinking 全開跑在 30s 砍線上。選 `3.1-flash-lite` 而非 `3.5-flash-lite`：後者**拒收 `thinkingConfig` 回 HTTP 400**（三次全失敗，照原案施工＝每次呼叫全掛）；亦非 `3.8-flash`（最慢 2.40s 且測試中 503/429 不穩）。實測 3.1-flash-lite 結構化負載中位 0.99s／最慢 1.03s，離散度最小。全文＝tzlth-hq `dev/gemini-migration-benchmark-2026-09-08.md`。⚠️ 原記「2.5-flash 實測 11.7s 正常」為 thinking 開啟時的舊值，換版後不再是本站的延遲基準。
- **線上 URL**：https://threads-dashboard-lime.vercel.app

## 重要設定
- **Vercel 環境變數（必填，6 個）**：THREADS_ACCESS_TOKEN / GOOGLE_AI_API_KEY / GITHUB_PAT（需要 repo + workflow scope）/ BASIC_AUTH_USER / BASIC_AUTH_PASSWORD（`middleware.js` 登入擋門，未設＝全站 503）/ GITHUB_SCHEDULE_TOKEN（`api/scheduled.js`）。2026-10-03 `vercel env ls` 與程式碼逐一對上；原只列前 3 個
- **本機 .env**：THREADS_ACCESS_TOKEN, TOKEN_CREATED_AT, GOOGLE_AI_API_KEY（本機開發用）
- **vercel.json**：maxDuration 60s（publish-single）/ 30s（nl-convert, ai-split-thread）；`"github":{"enabled":false}` 為廢棄設定已無效；**自動部署已透過 Ignored Build Step（Don't build anything / exit 0）正確停用**（2026-04-29 實際設定完成）
- **⚠️ Hobby plan 12 函數上限**：目前 api/ 有 11 個檔案 = 11 個 Serverless Functions，剩餘 1 個名額（2026-09-28 實數：原記 11 時實為 10，加 `version.js` 後才是 11）。新增任何 api/*.js 前必須先確認總數不超過 12
- **GitHub Actions secret**：THREADS_ACCESS_TOKEN（Settings → Secrets and variables → Actions）
- Newsletter API 路由：POST /api/nl-convert

## 檔案結構
```
threads-dashboard/
├── server.js          # Express 後端，所有 API 路由
├── app.js             # 前端邏輯（約 3,600 行，2026-10-03 `wc -l` 3,640）
├── index.html         # UI 結構，8 個分頁
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
8. **設定**（settings）：目前粉絲數、帳號名稱等手動設定（2026-10-03 補列；`index.html` 共 8 個 `data-tab`）

## 貼文資料欄位
- id, date, time, type, media, title（80字截斷）, fullText（串文只有第 1 格）
- likes, comments, reposts, shares, quotes, views, hashtags, notes, permalink
- ⚠️ **date／time 是 UTC**（Graph API 原值）；**type 是媒體類型**（純文字／圖片／影片／輪播／REPOST_FACADE），下方 classifyPost 的「觀點短文／長文觀點／串文」是前端另算的
- ⚠️ **沒有 `isQuotePost`**：2026-10-03 實數 838 篇 0 篇有此欄（fetch-threads.js 有向 API 要 `is_quote_post` 但沒寫進輸出）⇒ 前端分類「串文」目前永遠不會出現（HQ tasks 已立 P3）

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
- **線上（Vercel）**：`middleware.js` 全站預設要登入（Basic Auth），只放行 4 支唯讀端點：`/api/threads-data`、`/api/followers`、`/api/token-check`、`/api/version`；`.env`、`server.js` 等由 `.vercelignore` 排除、根本不部署
- **本機（server.js）**：才有 /api/nl-convert 每分鐘 20 次的速率限制與 node_modules 封鎖；線上 `api/nl-convert.js` 沒有速率限制，靠登入擋門（2026-10-03 更正：原寫「敏感檔案被 middleware 封鎖」「nl-convert 限速」為本機版行為）

## 常見指令
```bash
# 啟動
node server.js

# 強制重啟——⚠️ 下行會砍掉本機「所有」node 程序（含其他專案的開發伺服器），不建議；只停本服務請關掉它自己的視窗
# taskkill /F /IM node.exe && node server.js

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
- 點擊 → `api/trigger-sync.js` 觸發**本 repo** `cron.yml` 的 workflow_dispatch（需 GITHUB_PAT env var；跑的是本 repo GitHub Secrets 裡的 THREADS_ACCESS_TOKEN）
- 若未設定 GITHUB_PAT → 顯示「資料每日 09:00 / 21:00（台灣時間）由 tzlth-hq fetch-threads.yml 自動更新」說明訊息（`app.js`／`api/trigger-sync.js` 實際字串，2026-10-03 對過）
- 定時更新由 **HQ** `fetch-threads.yml` 執行，本 repo `cron.yml` 沒有排程

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
- ~~`GET /api/fetch-log`~~：2026-06-18 已刪除
- `GET /api/weekly-report`：讀本 repo（public）raw 的 threads-data.json 計算週報（需登入）
- `POST /api/nl-convert`：Gemini 自然語言轉換
- `POST /api/ai-split-thread`：Gemini 長文串文切割
- `GET /api/trigger-sync`：觸發 GitHub Actions workflow_dispatch（需 GITHUB_PAT）
- `GET /api/threads-data`：代理讀取本 repo raw 的 threads-data.json（GITHUB_PAT 可選；**免登入**）
- `GET /api/followers`：代理讀取 follower-history.json（**免登入**）
- `GET/POST/DELETE /api/scheduled`：排程貼文清單讀寫 `data/scheduled-posts.json`（GITHUB_SCHEDULE_TOKEN；需登入）
- `GET /api/version`：回報正在服務的部署（commit／deployment／node／region；**免登入**）
- 共 11 支＝11 個函數；免費方案不用框架時上限 12（Vercel 官方 runtimes 頁，2026-10-03 查）

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

### ⛔ 收尾七件事（每次對話結束前必做）
收尾完整規則詳見**總部 tzlth-hq CLAUDE.md →「核心原則零：收尾七件事」**（7 步驟：git push / 最近修改記錄 / tasks.md / inventory.json / daily-log / reflection-log / 品質自查 HARD STOP / 未完成清單 HARD STOP，均對總部檔案執行；2026-07-12 規則盤點指針化，原「五件事」清單為 D6 漏網，reflection-log「有價值才寫」舊語與主檔「每次必寫」矛盾一併修正）。
**本 repo 在地特例（保留）**：
- git push 目標＝shoppy09/tzlth-threads-dashboard；`follower-history.json`/`threads-data.json`/.js/.html 修改必 push（總部儀表板從 GitHub API 讀取，不 push＝看不到）
- 資料抓取由 tzlth-hq `fetch-threads.yml`（canonical，每天 09:00/21:00）自動 fetch+push；手動修改必手動 push
- 前端（.js/.html）改動：push 後 `npx vercel --prod`（auto-deploy 已停用 2026-04-29）
  > ✅ **2026-08-23 dashboard 實查確認**：本 repo Deployments **回溯至 2026-04-29 零 git-source 部署** ⇒ 停用屬實，本欄正確（本專案即 IMP-088 當日的 Ignored Build Step 處置對象）。
  > ⚠️ 但總部主檔規則零原載的**全域**「Vercel 自動部署永久停用」是**把本專案的單點處置寫成通則**——8 專案實查為 **5 開／2 關／1 未連 Git**（RCF-153），掛帳 116 天並衍生三次重複發現。**不可據本 repo 推論其他 repo**。
  > ✅ **憑證已於 2026-08-23 由 Tim 重新登入復原**，並以本 repo 實測部署通過（`npx.cmd vercel --prod` → Ready 11s → alias `threads-dashboard-lime.vercel.app`；7 端點冒煙與 2026-08-05 default-deny 基準零回歸）。⛔ **PowerShell 一律打 `npx.cmd`**（`npx` 被 ExecutionPolicy 擋在 `npx.ps1`；Bash 不受影響。IMP-112）；**不需 `--scope`**（歷史記錄裡的 `--scope team_jvyEytBJ…` 是憑證異常時的症狀）。

> 未完成收尾七件事 = 任務未完成。本地修改不 push = 等於沒做。

### 最近修改記錄

| 日期 | 修改內容 | 執行視窗 | 狀態 |
|------|---------|---------|------|
| 2026-10-03 | 【DEV/HR】常設描述逐條對照實際修 15 處（同步時間、粉絲數、分頁 8、欄位 UTC／無 isQuotePost、安全設定線上 vs 本機、env 6 個、端點清單、taskkill 警告）；本表套雙層制。全文見 `CLAUDE-archive-2026-10.md` | 總部視窗 | ✅ |
| 2026-09-28 | 【DEV/SEC】新增公開端點 `api/version.js`（commit／deployment／node 大版本／region）＋`middleware.js` PUBLIC_API 精確清單 +1。函數數 10→11（上限 12；原記「11 個檔案」為 stale，實為 10）。CLI 部署：commit 可能為 null，deployment 必有（HQ tasks「其餘部署面 repo 無法自報正在服務的是哪一次部署」） | 總部視窗 | ✅ |
| 2026-09-24 | 【DEV】新增 `.gitattributes`：文字檔一律以 LF 存入 repo、二進位檔明列不轉換（總部批次:B28／RCF-198 統一推送）。本 repo renormalize 零檔變動（index 原本即全為 LF）；零程式碼改動 | tzlth-hq（批次:B28） | ✅ |
| 2026-09-08 | 【DEV】Gemini 換模 `2.5-flash`→`3.1-flash-lite`，四個呼叫點補 `thinkingBudget: 0`（3.5-flash-lite 拒收 thinkingConfig）。全文見 `CLAUDE-archive-2026-10.md` | 總部視窗 | ✅ |
| 2026-08-30 | 【DEV】時段功能補 UTC→台灣時區轉換（四個 live 觸點原錯位 8 小時，載入邊界 `utcToTaipei()`）。全文見 `CLAUDE-archive-2026-10.md` | 總部視窗 | ✅ |
| 2026-06-22 | 【DEV】加抓真 shares 指標、分離 quotes（fetch-threads.js＋server.js，舊文 shares 不可得不歸零）。全文見 `CLAUDE-archive-2026-10.md` | 總部視窗 | ✅ |
| 2026-06-18 | 【DEV】auto-fetch.bat 棄用清理（刪 fetch-log 完整鏈）；trigger-sync ref main→master 修 422。全文見 `CLAUDE-archive-2026-10.md` | 開發部 | ✅ |
| 2026-04-21 | 【DEV】遷移至 Vercel＋GitHub Actions：新增 api/*.js、cron.yml、vercel.json；server.js 保留本機用。全文見 `CLAUDE-archive-2026-10.md` | 開發部 | ✅ |

---
## 總部連結（TZLTH-HQ）
- 系統代號：SYS-02
- 總部路徑：C:\Users\USER\Desktop\tzlth-hq
- HQ 角色：Threads 內容的數據中心。追蹤發文績效、追蹤者成長、提供 AI 內容建議，支撐行銷部決策。
- 存檔規定：資料抓取由 tzlth-hq `fetch-threads.yml`（canonical，每天 09:00/21:00 台灣時間）自動 fetch + git commit + push。手動發文時 pub-history.json 自動記錄。Claude 手動修改任何檔案後必須立即 push。
- 拉取欄位：follower-history.json（追蹤者數）、threads-data.json 最後 20 筆（近期貼文績效）、threads-data.json `fetchedAt`（確認 ≤24h，取代已棄用的 auto-fetch.log）
---
