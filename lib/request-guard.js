// 寫入／花錢類 API 的跨站請求防護（2026-10-18 HQ 批次:B38，資安稽核 10-17 C-6）
//
// WHY：全站有 Basic Auth（middleware.js），但瀏覽器登入過後，別的網站的表單也能讓瀏覽器
//      帶著登入狀態送請求進來（用品牌 Threads 帳號發文、燒 Gemini 額度、觸發 Actions）。
// 兩道：
//   ① 同源：帶了 Origin 就必須等於本次請求的主機（Host 或 x-forwarded-host）。不寫死網址，
//      任何 Vercel 網址開看板都能用。不帶 Origin（curl、同源 GET）放行——仍要先過登入。
//   ② 只收 JSON：跨站表單只能送 urlencoded／multipart／text/plain（Fetch 標準 CORS-safelisted
//      Content-Type），送 application/json 一定要先預檢，而本站不回應跨站預檢 ⇒ 表單進不來。
// ⚠️ 放 lib/ 而不是 api/：api/ 每個檔都算一個函式，免費方案上限 12（目前 11）。

function requestHosts(req) {
  return [req.headers.host, req.headers['x-forwarded-host']]
    .filter(Boolean)
    .flatMap(h => String(h).split(',').map(s => s.trim().toLowerCase()));
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; } // 含 "null"
  return requestHosts(req).includes(host);
}

function isJson(req) {
  return /^application\/json\b/i.test(req.headers['content-type'] || '');
}

// 通過回 true；不通過已回應 403／415，呼叫端直接 return
function guard(req, res, { json = true } = {}) {
  if (!isSameOrigin(req)) {
    res.status(403).json({ error: 'Forbidden（跨站請求）' });
    return false;
  }
  if (json && !isJson(req)) {
    res.status(415).json({ error: '只接受 application/json' });
    return false;
  }
  return true;
}

module.exports = { guard, isSameOrigin, isJson };
