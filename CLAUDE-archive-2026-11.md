# CLAUDE.md 最近修改記錄——完整敘事封存（2026-11）

> RCF-175 雙層制：主檔只留摘要列（≤300 字元），全文在此，newest-first。

| 日期 | 修改內容 | 執行視窗 | 狀態 |
|------|---------|---------|------|
| 2026-11-06 | 【DEV/SOC】**11:00 原創 PUBLISH_MODE 改 live（HQ 2026-11-06 Tim「從哪天開始自動發？→11/8」「按照你的建議，執行」，查照 2 版，RCF-278 補記）**：① `scripts/publish_scheduled.py` run_preflight 原只挑 source=hq-fb-cross，週 10 原創 38 格從沒預跑 → 改全部 pending、未來 10 天；測試加「11:00 原創也預跑」「已取消／超過 10 天不挑」，66→67 項，HEAD 舊程式跑新測試 2 項失敗 ② HQ `threads_queue.py retire-past --through 2026-11-07` 取消 11 筆（含 11-06 已手發、11-07 Tim 最後一次手發）③ 預跑 run 42170095013：14 則 61 格（11:00 38、19:00 23）全 FINISHED、未發布 ④ publish-scheduled.yml、publish-followup.yml PUBLISH_MODE: live，檔頭加切換紀錄；gh api 讀回兩檔 live，面板 /api/scheduled?view=status 讀回 scheduled／followup／cross 皆 live、errors 空。⚠️ 佇列從沒有 published：11-08 11:00 是第一次真發、第一次用回覆接串文 | HQ 分組場 5b64e28c | ✅ |
