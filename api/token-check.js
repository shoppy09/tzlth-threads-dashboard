// ⚠️ 線上版只回有沒有設定，不回 daysRemaining ⇒ 前端「Token 將在 N 天後過期」警示只在本機版（server.js，讀 .env 的
//    TOKEN_CREATED_AT）出現。線上的到期提醒以總部 inventory `_external_tokens` 為準（soplint＋收尾 hook 會提醒）。
//    2026-10-18 HQ 批次:B38 決定 1(c)：保留前端那段，不在 Vercel 多設一個每次換 token 都要記得改的變數。
//    本端點在 middleware 公開清單、系統驗證 SKILL 依賴它回 200，勿改回應格式。
module.exports = (req, res) => {
  const token = process.env.THREADS_ACCESS_TOKEN;
  res.json({ ok: !!(token && token.length > 10), hint: token ? '已設定' : '未設定' });
};
