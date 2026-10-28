const https = require('https');

// 讀本 repo（公開）的 JSON 原檔（2026-10-28，HQ 資安稽核 10-17 ⑩ 換 token 時撞出）
// WHY：原本三支 API 讀公開檔時還帶 GITHUB_PAT。2026-10-28 那把 classic token 刪除後，
//   帶失效 token 讀公開原檔會回 404「404: Not Found」，而 JSON.parse 寫在 'end' callback 裡丟例外
//   ⇒ Promise 永遠不 resolve／reject，函式掛到平台逾時（實測 90 秒無回應）。
// 改法：公開檔不帶 token（不再依賴任何 token）；看狀態碼；解析失敗與逾時都回錯誤，不會再掛住。
// GITHUB_PAT 只剩 trigger-sync（觸發 workflow）會用；2026-10-28 已從 Vercel 刪除，trigger-sync 改走「未設定」分支。
const RAW_BASE = 'https://raw.githubusercontent.com/shoppy09/tzlth-threads-dashboard/master/';

function getPublicJson(file, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(RAW_BASE + file, { headers: { 'User-Agent': 'tzlth-dashboard' } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode !== 200) return reject(new Error(`讀取 ${file} 失敗（HTTP ${r.statusCode}）`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`${file} 不是合法 JSON：${e.message}`)); }
      });
      r.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`讀取 ${file} 逾時（${timeoutMs / 1000} 秒）`)));
    req.on('error', reject);
  });
}

module.exports = { getPublicJson };
