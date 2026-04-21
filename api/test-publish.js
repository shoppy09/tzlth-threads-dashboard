const https = require('https');

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
  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'THREADS_ACCESS_TOKEN 未設定' });

  try {
    // Step 1: 取得 userId + username
    const profile = await new Promise((resolve, reject) => {
      https.get(
        `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${token}`,
        r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); }
      ).on('error', reject);
    });
    if (profile.error) return res.status(401).json({ error: 'Token 無效', detail: profile.error.message });
    const userId = profile.id;

    // Step 2: 嘗試建立測試 container（不實際發布）
    const testResult = await httpsPost('graph.threads.net', `/v1.0/${userId}/threads`, {
      media_type: 'TEXT',
      text: '【系統測試】這是一則測試訊息，不會實際發布。',
      access_token: token
    });

    if (testResult.status === 200 && testResult.body.id) {
      return res.json({
        success: true,
        hasPublishPermission: true,
        userId,
        username: profile.username,
        containerId: testResult.body.id,
        message: '✅ Token 具有發文權限！測試 container 已建立（未實際發布）'
      });
    } else {
      const errMsg = testResult.body?.error?.message || `HTTP ${testResult.status}`;
      const isPermission = errMsg.includes('permission') || errMsg.includes('scope') || testResult.status === 403;
      return res.json({
        success: false,
        hasPublishPermission: false,
        userId,
        username: profile.username,
        error: errMsg,
        message: isPermission
          ? '❌ Token 沒有發文權限（缺少 threads_content_publish scope），請重新申請 Token'
          : '❌ 建立 container 失敗：' + errMsg
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
