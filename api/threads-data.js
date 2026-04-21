const https = require('https');

module.exports = async (req, res) => {
  try {
    const headers = { 'User-Agent': 'tzlth-dashboard' };
    const pat = process.env.GITHUB_PAT;
    if (pat) headers['Authorization'] = `token ${pat}`;
    const data = await new Promise((resolve, reject) => {
      https.get(
        'https://raw.githubusercontent.com/shoppy09/tzlth-threads-dashboard/master/threads-data.json',
        { headers },
        r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); }
      ).on('error', reject);
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
