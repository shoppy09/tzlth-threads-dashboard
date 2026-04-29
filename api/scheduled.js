/**
 * api/scheduled.js — 排程發文統一 endpoint（GET / POST / DELETE）
 *
 * GET    /api/scheduled           → 讀取排程佇列（in_progress 置頂 → pending → 終態）
 * POST   /api/scheduled           → 新增排程
 *   - 串文格式：{ type:'thread', posts:[{seq, content}], scheduled_at }
 *   - 單篇格式（向後相容）：{ content, reply_text, scheduled_at }
 * DELETE /api/scheduled  body:{id}→ 取消排程（pending 才可取消，in_progress 拒絕）
 *
 * 安全：CORS Origin 驗證 + SHA 樂觀鎖
 * 環境變數：GITHUB_SCHEDULE_TOKEN（Fine-Grained PAT，僅限本 repo Contents R/W）
 */

const https = require('https');
const crypto = require('crypto');

const GITHUB_TOKEN = process.env.GITHUB_SCHEDULE_TOKEN;
const REPO = 'shoppy09/tzlth-threads-dashboard';
const FILE_PATH = 'data/scheduled-posts.json';
const ALLOWED_ORIGIN = 'https://threads-dashboard-lime.vercel.app';
const MAX_THREAD_POSTS = 20;
const MAX_POST_CHARS = 500;

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
      // 排序：in_progress 置頂 → pending（asc by scheduled_at）→ 終態（desc by published/created）
      const inProgress = posts.filter(p => p.status === 'in_progress')
        .sort((a, b) => new Date(a.lease_acquired_at || a.scheduled_at) - new Date(b.lease_acquired_at || b.scheduled_at));
      const pending = posts.filter(p => p.status === 'pending')
        .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
      const history = posts.filter(p => !['pending', 'in_progress'].includes(p.status))
        .sort((a, b) => new Date(b.published_at || b.cancelled_at || b.created_at) - new Date(a.published_at || a.cancelled_at || a.created_at));
      return res.json([...inProgress, ...pending, ...history]);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: create new scheduled post ────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const { scheduled_at } = body;

    if (!scheduled_at) return res.status(400).json({ error: '缺少排程時間 scheduled_at' });
    const scheduledDate = new Date(scheduled_at);
    if (isNaN(scheduledDate.getTime()))
      return res.status(400).json({ error: 'scheduled_at 格式錯誤，請使用 ISO 8601' });
    const minTime = new Date(Date.now() + 20 * 60 * 1000);
    if (scheduledDate < minTime)
      return res.status(400).json({ error: '排程時間必須至少 20 分鐘後' });

    // 判斷格式：thread vs single
    const isThread = body.type === 'thread' && Array.isArray(body.posts);
    let newPost;

    if (isThread) {
      if (body.posts.length === 0)
        return res.status(400).json({ error: '串文至少需要 1 篇' });
      if (body.posts.length > MAX_THREAD_POSTS)
        return res.status(400).json({ error: `串文最多 ${MAX_THREAD_POSTS} 篇` });
      for (const p of body.posts) {
        if (!p.content || typeof p.content !== 'string' || !p.content.trim())
          return res.status(400).json({ error: `第 ${p.seq || '?'} 篇內容為空` });
        if (p.content.length > MAX_POST_CHARS)
          return res.status(400).json({ error: `第 ${p.seq || '?'} 篇超過 ${MAX_POST_CHARS} 字` });
      }
      newPost = {
        id: crypto.randomUUID(),
        type: 'thread',
        posts: body.posts.map((p, i) => ({ seq: p.seq || i + 1, content: p.content.trim() })),
        scheduled_at: scheduledDate.toISOString(),
        status: 'pending',
        created_at: new Date().toISOString(),
        published_at: null,
        error: null
      };
    } else {
      // 單篇格式（向後相容，無 UI 入口但 API 仍支援）
      const { content, reply_text } = body;
      if (!content || typeof content !== 'string' || !content.trim())
        return res.status(400).json({ error: '缺少貼文內容' });
      if (content.length > MAX_POST_CHARS)
        return res.status(400).json({ error: `貼文超過 ${MAX_POST_CHARS} 字上限` });
      newPost = {
        id: crypto.randomUUID(),
        type: 'single',
        content: content.trim(),
        reply_text: reply_text ? reply_text.trim() : null,
        scheduled_at: scheduledDate.toISOString(),
        status: 'pending',
        created_at: new Date().toISOString(),
        published_at: null,
        error: null
      };
    }

    try {
      const { posts, sha } = await readFile();
      posts.push(newPost);
      const writeStatus = await writeFile(
        posts, sha,
        `chore: schedule ${isThread ? `${newPost.posts.length}-post thread` : 'single post'} for ${scheduledDate.toISOString().slice(0, 16)}`
      );
      if (writeStatus === 409) return res.status(409).json({ error: '寫入衝突，請稍後再試' });
      if (![200, 201].includes(writeStatus)) return res.status(500).json({ error: `GitHub 寫入失敗（${writeStatus}）` });

      return res.json({
        success: true,
        id: newPost.id,
        type: newPost.type,
        scheduled_at: newPost.scheduled_at,
        ...(isThread ? { post_count: newPost.posts.length } : {})
      });
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
      if (post.status === 'in_progress')
        return res.status(409).json({ error: '此排程正在發送中，無法取消' });
      if (post.status !== 'pending')
        return res.status(400).json({ error: `無法取消（目前狀態：${post.status}）` });

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
