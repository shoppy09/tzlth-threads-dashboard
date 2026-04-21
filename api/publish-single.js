const https = require('https');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsPost(hostname, path, params) {
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) }); }
        catch { reject(new Error('parse error')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, replyToId, userId: providedUserId } = req.body;
  if (!text) return res.status(400).json({ error: '缺少 text' });
  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'THREADS_ACCESS_TOKEN 未設定' });

  try {
    // Step 0: 取得 userId（只在第一篇取一次，之後 frontend 傳回來重用）
    let userId = providedUserId;
    if (!userId) {
      const me = await new Promise((resolve, reject) => {
        https.get(
          `https://graph.threads.net/v1.0/me?fields=id&access_token=${token}`,
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); }
        ).on('error', reject);
      });
      if (!me.id) return res.status(500).json({ error: '無法取得 userId', detail: me });
      userId = me.id;
    }

    // Step 1: 建立 container
    const containerParams = { text, media_type: 'TEXT', access_token: token };
    if (replyToId) containerParams.reply_to_id = replyToId;
    const container = await httpsPost('graph.threads.net', `/v1.0/${userId}/threads`, containerParams);
    if (!container.body.id) return res.status(500).json({ error: 'Container 建立失敗', detail: container.body });
    const containerId = container.body.id;

    // Step 2: 等待 30s（Threads API 需要處理時間）
    // vercel.json maxDuration: 60 確保此 Function 不會 timeout
    await sleep(30000);

    // Step 3: 發布
    const publish = await httpsPost(
      'graph.threads.net',
      `/v1.0/${userId}/threads_publish`,
      { creation_id: containerId, access_token: token }
    );
    if (!publish.body.id) return res.status(500).json({ error: '發布失敗', detail: publish.body });
    const postId = publish.body.id;

    // Step 4: 取 permalink（選用，失敗不影響主流程）
    let permalink = null;
    try {
      const details = await new Promise((resolve, reject) => {
        https.get(
          `https://graph.threads.net/v1.0/${postId}?fields=permalink&access_token=${token}`,
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); }
        ).on('error', reject);
      });
      permalink = details.permalink || null;
    } catch (_) {}

    res.json({ success: true, postId, userId, permalink });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
