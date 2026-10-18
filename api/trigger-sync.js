const https = require('https');
const { guard } = require('../lib/request-guard');

// 2026-10-18（HQ 批次:B38）：① 只收 POST＋JSON——原本 GET 就能觸發，別站放一張圖就能一直燒 Actions 分鐘
// ② 看 GitHub 回應碼——原本不看，PAT 失效照樣回「已觸發」（寫入失敗審查 10-08 ②）
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ triggered: false, message: 'Method not allowed' });
  if (!guard(req, res)) return;
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    return res.json({
      triggered: false,
      message: '資料每日 09:00 / 21:00（台灣時間）由 tzlth-hq fetch-threads.yml 自動更新，無需手動觸發'
    });
  }

  try {
    const body = JSON.stringify({ ref: 'master' });
    const status = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        path: '/repos/shoppy09/tzlth-threads-dashboard/actions/workflows/cron.yml/dispatches',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${pat}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'tzlth-threads-dashboard',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const req2 = https.request(options, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });
    if (status !== 204) {
      return res.status(502).json({ triggered: false, message: `GitHub 回 ${status}（204 才是成功）——PAT 可能失效或權限不足` });
    }
    res.json({ triggered: true, message: '已觸發 GitHub Actions，約 7-9 分鐘後資料更新' });
  } catch (e) {
    res.status(500).json({ triggered: false, message: e.message });
  }
};
