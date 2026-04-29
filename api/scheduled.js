/**
 * api/scheduled.js — 排程發文統一 endpoint（GET / POST / DELETE）
 *
 * GET    /api/scheduled           → 讀取排程佇列（pending 優先排序）
 * POST   /api/scheduled           → 新增排程（content, reply_text, scheduled_at）
 * DELETE /api/scheduled  body:{id}→ 取消排程（pending 才能取消）
 *
 * 安全：CORS Origin 驗證（阻擋跨域攻擊）+ SHA 樂觀鎖（防止並行覆蓋）
 * 環境變數：GITHUB_SCHEDULE_TOKEN（Fine-Grained PAT，僅限本 repo Contents R/W）
 */

const https = require('https');
const crypto = require('crypto');

const GITHUB_TOKEN = process.env.GITHUB_SCHEDULE_TOKEN;
const REPO = 'shoppy09/tzlth-threads-dashboard';
const FILE_PATH = 'data/scheduled-posts.json';
const ALLOWED_ORIGIN = 'https://threads-dashboard-lime.vercel.app';

// ── GitHub Contents API helpers ───────────────────────────────────────────────

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

async function readFile() {
  const result = await githubRequest('GET', FILE_PATH);
  if (result.status === 404) return { posts: [], sha: null };
  if (result.status !== 200) throw new Error(`GitHub read error: ${result.status}`);
  const posts = JSON.parse(Buffer.from(result.body.content, 'base64').toString('utf-8'));
  return { posts, sha: result.body.sha };
}

async function writeFile(posts, sha, message) {
  const content = Buffer.from(JSON.stringify(posts, null, 2)).toString('base64');
  const body = { message, content };
  if (sha) body.sha = sha;
  const result = await githubRequest('PUT', FILE_PATH, body);
  return result.status; // 200/201 = ok, 409 = SHA conflict
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // CORS: reject cross-origin requests from wrong domains
  const origin = req.headers['origin'];
  if (origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_SCHEDULE_TOKEN 未設定' });

  // ── GET: list scheduled posts ───────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { posts } = await readFile();
      const pending = posts.filter(p => p.status === 'pending')
        .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
      const history = posts.filter(p => p.status !== 'pending')
        .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
      return res.json([...pending, ...history]);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: create new scheduled post ────────────────────────────────────────
  if (req.method === 'POST') {
    const { content, reply_text, scheduled_at } = req.body || {};

    if (!content || typeof content !== 'string' || !content.trim())
      return res.status(400).json({ error: '缺少貼文內容' });
    if (content.length > 500)
      return res.status(400).json({ error: '貼文超過 500 字上限' });
    if (!scheduled_at)
      return res.status(400).json({ error: '缺少排程時間 scheduled_at' });

    const scheduledDate = new Date(scheduled_at);
    if (isNaN(scheduledDate.getTime()))
      return res.status(400).json({ error: 'scheduled_at 格式錯誤，請使用 ISO 8601' });

    const minTime = new Date(Date.now() + 20 * 60 * 1000);
    if (scheduledDate < minTime)
      return res.status(400).json({ error: '排程時間必須至少 20 分鐘後（含 cron 等待 + Threads API 處理時間）' });

    try {
      const { posts, sha } = await readFile();
      const newPost = {
        id: crypto.randomUUID(),
        content: content.trim(),
        reply_text: reply_text ? reply_text.trim() : null,
        scheduled_at: scheduledDate.toISOString(),
        status: 'pending',
        created_at: new Date().toISOString(),
        published_at: null,
        error: null
      };
      posts.push(newPost);

      const writeStatus = await writeFile(
        posts, sha,
        `chore: schedule post for ${scheduledDate.toISOString().slice(0, 16)}`
      );
      if (writeStatus === 409) return res.status(409).json({ error: '寫入衝突，請稍後再試' });
      if (![200, 201].includes(writeStatus)) return res.status(500).json({ error: `GitHub 寫入失敗（${writeStatus}）` });

      return res.json({ success: true, id: newPost.id, scheduled_at: newPost.scheduled_at });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE: cancel scheduled post ──────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: '缺少 id' });

    try {
      const { posts, sha } = await readFile();
      const post = posts.find(p => p.id === id);
      if (!post) return res.status(404).json({ error: '找不到此排程' });
      if (post.status !== 'pending') return res.status(400).json({ error: `無法取消（目前狀態：${post.status}）` });

      post.status = 'cancelled';
      post.cancelled_at = new Date().toISOString();

      const writeStatus = await writeFile(
        posts, sha,
        `chore: cancel scheduled post ${id.slice(0, 8)}`
      );
      if (writeStatus === 409) return res.status(409).json({ error: '寫入衝突，請稍後再試' });
      if (![200, 201].includes(writeStatus)) return res.status(500).json({ error: `GitHub 寫入失敗（${writeStatus}）` });

      return res.json({ success: true, id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
