const https = require('https');

module.exports = async (req, res) => {
  const pat = process.env.GITHUB_PAT;
  if (!pat) return res.status(500).json({ error: 'GITHUB_PAT 未設定' });
  try {
    const data = await new Promise((resolve, reject) => {
      https.get(
        'https://raw.githubusercontent.com/shoppy09/tzlth-threads-dashboard/main/follower-history.json',
        { headers: { Authorization: `token ${pat}`, 'User-Agent': 'tzlth-dashboard' } },
        r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); }
      ).on('error', reject);
    });
    res.json(data);   // 返回 array，格式與原 /api/followers 相同
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
