/**
 * HTTP Basic Auth 存取控制（2026-07-01，B 層評估 D1 / RCF-118）
 *
 * WHY：SYS-02 看板 UI（index.html + app.js）公開顯示 Threads 分析儀表板，無存取控制（curl 200）。
 * 屬內部分析工具，補 gate 對齊 SYS-07/SYS-08 存取模型。
 *
 * ⚠️ 只 gate UI、排除 /api/*：api/ serverless（發文/排程/trigger-sync/threads-data）有自身
 * CORS/token 控制、且可能有程式呼叫端 → 全 gate 會破壞自動化。故 matcher 排除 /api。
 *
 * Vercel Edge Middleware（非 Next 專案，framework:null 靜態站亦適用，root middleware.js）。
 * 設定：Vercel Environment Variables 設 BASIC_AUTH_USER + BASIC_AUTH_PASSWORD（Tim 自設）。
 * Fail-closed：未設定 → 503。可逆：移除本檔即還原。
 * ⚠️ 上線前於 preview URL 先驗（非 Next Edge middleware 生效確認）。
 */

export const config = {
  // 只保護 UI/頁面；排除 /api、favicon、靜態圖示
  matcher: ['/((?!api|favicon|.*\\.(?:png|jpg|jpeg|svg|ico)$).*)'],
};

export default function middleware(request) {
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
