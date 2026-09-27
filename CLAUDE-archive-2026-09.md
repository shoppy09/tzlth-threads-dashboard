# CLAUDE.md 最近修改記錄——完整敘事封存（2026-09）

> RCF-175 雙層制：主檔只留摘要列（≤300 字元），全文在此，newest-first。

| 日期 | 修改內容 | 執行視窗 | 狀態 |
|------|---------|---------|------|
| 2026-09-28 | 【DEV/SEC】新增公開端點 `api/version.js`（commit／deployment／node 大版本／region）＋`middleware.js` PUBLIC_API 精確清單 +1。函數數 10→11（上限 12；原記「11 個檔案」為 stale，實為 10）。CLI 部署：commit 可能為 null，deployment 必有（HQ tasks「其餘部署面 repo 無法自報正在服務的是哪一次部署」） | 總部視窗 | ✅ |
| 2026-04-14 | fetch-threads.js 新增步驟 6：auto-fetch 排程呼叫 threads_insights endpoint 抓取 followers_count，寫入 follower-history.json；修復 6 天未更新問題 | 開發部 | ✅ |
