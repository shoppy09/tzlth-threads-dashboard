/**
 * HTTP Basic Auth 存取控制（2026-07-01，B 層評估 D1 / RCF-118）
 *
 * WHY：SYS-02 看板 UI（index.html + app.js）公開顯示 Threads 分析儀表板，無存取控制（curl 200）。
 * 屬內部分析工具，補 gate 對齊 SYS-07/SYS-08 存取模型。
 *
 * ⚠️⚠️ 2026-08-05 更正（原設計前提被證偽）
 * 原註解寫：「只 gate UI、排除 /api/*：api/ serverless 有自身 CORS/token 控制」。
 * 該句是**未經驗證的假設**，2026-08-05 逐檔實讀 + live curl 雙重證偽：
 *   - api/publish-single.js  只有 `method !== POST → 405`，零呼叫端認證 → 任何人 POST 即可用
 *                            THREADS_ACCESS_TOKEN 發文到 Tim 的 Threads（live: GET → 405 可達）
 *   - api/nl-convert.js / ai-split-thread.js  同樣零認證 → 可燒 GOOGLE_AI_API_KEY 額度
 *   - api/trigger-sync.js    連 method 檢查都沒有，任何 GET 即觸發 workflow dispatch
 *   - api/scheduled.js       僅 `if (origin && origin !== ALLOWED_ORIGIN)` → 不帶 Origin header
 *                            的 curl 直接通過（live: GET 無 Origin → 200）。CORS 不是認證機制。
 * → 改為 **default-deny**：matcher 涵蓋全站（含 /api），只有下方 PUBLIC_API 精確清單放行。
 *
 * 為什麼那三支唯讀端點可以放行（理由不是「它們有別的保護」）：
 *   (1) 本 repo 是 **public**，同一份 threads-data.json 在 raw.githubusercontent.com 匿名可讀
 *       （2026-08-05 curl 實證 200）→ gate 它們是安全劇場，擋不住任何人。
 *   (2) 唯一的程式呼叫端 `tzlth-hq/.claude/skills/系統驗證.md`（L96 / L120-122）靠它們判斷
 *       Threads cron 新鮮度；gate 了會讓外稽 SKILL 靜默失效。
 * 寫入類／花錢類端點沒有這兩個豁免理由，一律 gate。
 * 詳見 tzlth-hq/dev/audit-log.md 2026-08-05 + knowledge/decisions/RCF-118.md 補記。
 *
 * Vercel Edge Middleware（非 Next 專案，framework:null 靜態站亦適用，root middleware.js）。
 * 設定：Vercel Environment Variables 設 BASIC_AUTH_USER + BASIC_AUTH_PASSWORD（Tim 自設）。
 * Fail-closed：未設定 → 503。可逆：移除本檔即還原。
 * ⚠️ 上線前於 preview URL 先驗（非 Next Edge middleware 生效確認）。
 */

export const config = {
  // 保護全站（含 /api）；只排除 favicon 與靜態圖示。
  // ⚠️ 刻意與 SYS-07 儀表板 / SYS-08 知識庫 / SYS-09 財務採同一款已驗證寫法（只排靜態資產），
  //    不在 matcher 裡做 /api 白名單——負向 lookahead 是「前綴比對」，未來新增
  //    /api/threads-data-write 之類的端點會被靜默放行，等於重演本次的 default-open 缺陷。
  //    放行清單改為下方 PUBLIC_API 的**精確路徑比對**。
  matcher: ['/((?!favicon|.*\\.(?:png|jpg|jpeg|svg|ico)$).*)'],
};

// 放行清單：唯讀、且同一份資料已由 public repo 匿名可讀（gate 無實益）＋「系統驗證」SKILL 依賴。
// ⛔ 精確比對，非前綴。新增端點預設受保護；要放行必須在此顯式加入（default-deny）。
const PUBLIC_API = new Set([
  '/api/threads-data',
  '/api/followers',
  '/api/token-check',
]);

export default function middleware(request) {
  // default-deny 的唯一出口
  if (PUBLIC_API.has(new URL(request.url).pathname)) return;

  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPass = process.env.BASIC_AUTH_PASSWORD;

  // Fail-closed：尚未設定帳密 → 拒絕
  if (!expectedUser || !expectedPass) {
    return new Response('存取控制尚未設定（BASIC_AUTH_USER / BASIC_AUTH_PASSWORD）', {
      status: 503,
    });
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);
      const sep = decoded.indexOf(':');
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (user === expectedUser && pass === expectedPass) {
        return; // 通過 → 放行（undefined = 繼續處理請求）
      }
    }
  }

  return new Response('需要登入', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="TZLTH Threads Dashboard", charset="UTF-8"' },
  });
}
