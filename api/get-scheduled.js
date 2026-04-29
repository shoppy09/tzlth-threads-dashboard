const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_SCHEDULE_TOKEN;
const REPO = 'shoppy09/tzlth-threads-dashboard';
const FILE_PATH = 'data/scheduled-posts.json';

function githubGet(filePath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${filePath}`,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'tzlth-threads-dashboard'
      }
    };
    https.get(options, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(d) }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_SCHEDULE_TOKEN 未設定' });

  try {
    const result = await githubGet(FILE_PATH);
    if (result.status === 404) return res.json([]);
    if (result.status !== 200) return res.status(500).json({ error: 'GitHub API 錯誤', detail: result.body });

    const posts = JSON.parse(Buffer.from(result.body.content, 'base64').toString('utf-8'));
    // Sort: pending first (by scheduled_at asc), history by published_at desc
    const pending = posts.filter(p => p.status === 'pending')
      .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
    const history = posts.filter(p => p.status !== 'pending')
      .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));

    res.json([...pending, ...history]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
