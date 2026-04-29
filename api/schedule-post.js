const https = require('https');
const crypto = require('crypto');

const GITHUB_TOKEN = process.env.GITHUB_SCHEDULE_TOKEN;
const REPO = 'shoppy09/tzlth-threads-dashboard';
const FILE_PATH = 'data/scheduled-posts.json';
const ALLOWED_ORIGIN = 'https://threads-dashboard-lime.vercel.app';

// ── GitHub Contents API helpers ────────────────────────────────────────────

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

async function readScheduledFile() {
  const result = await githubRequest('GET', FILE_PATH);
  if (result.status === 404) return { posts: [], sha: null };
  if (result.status !== 200) throw new Error(`GitHub read error: ${result.status}`);
  const posts = JSON.parse(Buffer.from(result.body.content, 'base64').toString('utf-8'));
  return { posts, sha: result.body.sha };
}

async function writeScheduledFile(posts, sha, message) {
  const content = Buffer.from(JSON.stringify(posts, null, 2)).toString('base64');
  const body = { message, content };
  if (sha) body.sha = sha; // sha is required for updates; omit only for initial creation
  const result = await githubRequest('PUT', FILE_PATH, body);
  return result.status; // 200 = updated, 201 = created, 409 = SHA conflict
}

// ── Main handler ────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // CORS origin check: reject cross-origin requests from wrong domains
  // (same-origin browser requests may not send Origin; those pass through)
  const origin = req.headers['origin'];
  if (origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_SCHEDULE_TOKEN 未設定' });

  const { content, reply_text, scheduled_at } = req.body || {};

  // ── Input validation ────────────────────────────────────────────────────
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: '缺少貼文內容' });
  }
  if (content.length > 500) {
    return res.status(400).json({ error: '貼文超過 500 字上限' });
  }
  if (!scheduled_at) {
    return res.status(400).json({ error: '缺少排程時間 scheduled_at' });
  }

  const scheduledDate = new Date(scheduled_at);
  if (isNaN(scheduledDate.getTime())) {
    return res.status(400).json({ error: 'scheduled_at 格式錯誤，請使用 ISO 8601' });
  }

  const minTime = new Date(Date.now() + 20 * 60 * 1000); // 20 minutes from now
  if (scheduledDate < minTime) {
    return res.status(400).json({ error: '排程時間必須至少 20 分鐘後（含 cron 等待 + Threads API 處理時間）' });
  }

  // ── Read → append → write with optimistic locking ──────────────────────
  try {
    const { posts, sha } = await readScheduledFile();

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

    const writeStatus = await writeScheduledFile(
      posts,
      sha,
      `chore: schedule post for ${scheduledDate.toISOString().slice(0, 16)}`
    );

    if (writeStatus === 409) {
      return res.status(409).json({ error: '寫入衝突，請稍後再試（並行操作碰撞）' });
    }
    if (![200, 201].includes(writeStatus)) {
      return res.status(500).json({ error: `GitHub 寫入失敗（狀態碼 ${writeStatus}）` });
    }

    res.json({ success: true, id: newPost.id, scheduled_at: newPost.scheduled_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
