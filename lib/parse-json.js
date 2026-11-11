// 上游回應解析（2026-11-11，HQ tasks L174「看板 API 回應解析加防護」，Tim「按照你的建議，執行」）
//
// WHY：nl-convert／publish-single／test-publish 原本在 https 回應的 'end' 回呼裡直接 JSON.parse。
//   對方回 HTML 錯誤頁、空字串或被截斷時，例外丟在回呼裡、傳不回外層的 await
//   ⇒ Promise 永遠不 resolve／reject，函式掛到平台上限（同型問題 lib/public-raw.js 10-28 實測 90 秒無回應）。
// 做法：解析失敗丟出帶 upstream 標記的錯誤，呼叫端在回呼裡用 try/catch 轉成 reject，
//   外層 catch 看到 upstream 就回 502（上游回應有問題），其他錯誤照舊 500。
// ⚠️ 放 lib/ 而不是 api/：api/ 每個檔都算一個函式，免費方案上限 12（目前 11）。

function parseUpstream(text, label, status) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const head = String(text || '').slice(0, 60).replace(/\s+/g, ' ');
    const err = new Error(`${label} 回應不是合法 JSON（HTTP ${status ?? '?'}）：${head || '（空白）'}`);
    err.upstream = true;
    err.status = status;
    throw err;
  }
}

// 'end' 回呼用：解析成功 resolve、失敗 reject（不讓例外留在回呼裡）
function settleJson(resolve, reject, text, label, status) {
  try { resolve(parseUpstream(text, label, status)); } catch (e) { reject(e); }
}

// 外層 catch 用：上游回應壞掉 → 502，其他 → 500；兩種都帶 error 與 message（看板「測試發文權限」畫面讀 message）
function errorStatus(e) {
  return e && e.upstream ? 502 : 500;
}

module.exports = { parseUpstream, settleJson, errorStatus };
