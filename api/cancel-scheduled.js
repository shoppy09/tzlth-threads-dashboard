const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_SCHEDULE_TOKEN;
const REPO = 'shoppy09/tzlth-threads-dashboard';
const FILE_PATH = 'data/scheduled-posts.json';
const ALLOWED_ORIGIN = 'https://threads-dashboard-lime.vercel.app';

function githubRequest(method, filePath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/contents/${filePath}`,
      method,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'tzlth-threads-dashboard',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {})
      }
    };
    const req = https.request(options, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(d) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const origin = req.headers['origin'];
  if (origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_SCHEDULE_TOKEN 未設定' });

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: '缺少 id' });

  try {
    // Read
    const getResult = await githubRequest('GET', FILE_PATH);
    if (getResult.status !== 200) return res.status(500).json({ error: 'GitHub read error' });

    const sha = getResult.body.sha;
    const posts = JSON.parse(Buffer.from(getResult.body.content, 'base64').toString('utf-8'));

    const post = posts.find(p => p.id === id);
    if (!post) return res.status(404).json({ error: '找不到此排程' });
    if (post.status !== 'pending') return res.status(400).json({ error: `無法取消（目前狀態：${post.status}）` });

    post.status = 'cancelled';
    post.cancelled_at = new Date().toISOString();

    // Write back
    const content = Buffer.from(JSON.stringify(posts, null, 2)).toString('base64');
    const putResult = await githubRequest('PUT', FILE_PATH, {
      message: `chore: cancel scheduled post ${id.slice(0, 8)}`,
      content,
      sha
    });

    if (putResult.status === 409) return res.status(409).json({ error: '寫入衝突，請稍後再試' });
    if (![200, 201].includes(putResult.status)) return res.status(500).json({ error: `GitHub 寫入失敗（${putResult.status}）` });

    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
