const https = require('https');

module.exports = async (req, res) => {
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    return res.json({
      triggered: false,
      message: '資料每日 10:00 / 22:00（台灣時間）自動更新，無需手動觸發'
    });
  }

  try {
    const body = JSON.stringify({ ref: 'main' });
    await new Promise((resolve, reject) => {
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
      const req2 = https.request(options, r => { r.resume(); r.on('end', resolve); });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });
    res.json({ triggered: true, message: '已觸發 GitHub Actions，約 3-5 分鐘後資料更新' });
  } catch (e) {
    res.status(500).json({ triggered: false, message: e.message });
  }
};
