// server.js — Threads 儀表板本地伺服器
// 功能：靜態檔案 + /api/sync 即時抓取端點
// 啟動：node server.js 或雙擊 start-dashboard.bat

require('dotenv').config();
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3939;
const HOST = '0.0.0.0'; // Render 需要 0.0.0.0，本機也相容
const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const BASE = 'https://graph.threads.net/v1.0';

// ===== 安全：封鎖敏感檔案直接存取 =====
const BLOCKED_FILES = ['.env', 'server.js', 'fetch-threads.js', 'package.json', 'package-lock.json'];
app.use((req, res, next) => {
  const urlPath = req.path.toLowerCase();
  // 封鎖 node_modules 目錄
  if (urlPath.startsWith('/node_modules')) return res.status(403).end('Forbidden');
  // 封鎖敏感檔案
  const filename = path.basename(urlPath);
  if (BLOCKED_FILES.some(f => filename === f || urlPath.endsWith('/' + f))) {
    return res.status(403).end('Forbidden');
  }
  // 封鎖隱藏檔（.開頭）
  if (filename.startsWith('.') && filename !== '.') {
    return res.status(403).end('Forbidden');
  }
  next();
});

// ===== 簡易速率限制（newsletter API 防濫用）=====
const _rateMap = new Map();
function rateLimit(maxPerMin) {
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = _rateMap.get(key) || { count: 0, start: now };
    if (now - entry.start > 60000) { entry.count = 0; entry.start = now; }
    entry.count++;
    _rateMap.set(key, entry);
    if (entry.count > maxPerMin) return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    next();
  };
}

// ===== API Helper =====
function apiGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ThreadsDashboard/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== /api/sync — 即時同步 =====
let isSyncing = false;
let lastSyncResult = null;
let syncProgress = { stage: '', current: 0, total: 0, message: '' };

app.get('/api/sync', async (req, res) => {
  if (!TOKEN) return res.status(500).json({ error: 'Missing THREADS_ACCESS_TOKEN in .env' });
  if (isSyncing) return res.json({ status: 'syncing', message: '同步進行中，請稍候...' });

  isSyncing = true;
  const startTime = Date.now();
  const mode = req.query.mode || 'full'; // 'full' 或 'incremental'
  const dataPath = path.join(__dirname, 'threads-data.json');

  // 增量模式：讀取現有資料，取得最新貼文時間戳
  let existingPosts = [];
  let lastKnownTimestamp = null;
  if (mode === 'incremental') {
    try {
      const existing = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      existingPosts = existing.posts || [];
      if (existingPosts.length > 0) {
        const sorted = [...existingPosts].sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || ''));
        const newest = sorted[0];
        lastKnownTimestamp = newest.date + 'T' + (newest.time || '00:00') + ':00+00:00';
      }
    } catch {}
  }

  syncProgress = { stage: 'profile', current: 0, total: 0, message: '正在驗證 Token...' };

  try {
    // 1. Profile
    const profile = await apiGet(`${BASE}/me?fields=id,username,name,threads_profile_picture_url,threads_biography&access_token=${TOKEN}`);
    if (profile.error) {
      isSyncing = false;
      syncProgress = { stage: 'error', current: 0, total: 0, message: 'Token 驗證失敗' };
      return res.status(401).json({ error: 'Token 無效或已過期', detail: profile.error.message });
    }

    // 2. All posts (paginated)
    let allThreads = [];
    let url = `${BASE}/me/threads?fields=id,text,username,permalink,timestamp,media_type,media_url,shortcode,is_quote_post&limit=50&access_token=${TOKEN}`;
    syncProgress = { stage: 'posts', current: 0, total: -1, message: '正在載入貼文...' };
    while (url) {
      const r = await apiGet(url);
      if (r.error) break;
      const batch = r.data || [];

      if (mode === 'incremental' && lastKnownTimestamp) {
        // 過濾出比 lastKnownTimestamp 更新的貼文
        const newOnes = batch.filter(t => t.timestamp > lastKnownTimestamp);
        allThreads = allThreads.concat(newOnes);
        syncProgress = { stage: 'posts', current: allThreads.length, total: -1, message: `已載入 ${allThreads.length} 篇新貼文...` };
        // 如果這批裡有舊的，就不用繼續翻頁了
        if (newOnes.length < batch.length) { url = null; break; }
      } else {
        allThreads = allThreads.concat(batch);
        syncProgress = { stage: 'posts', current: allThreads.length, total: -1, message: `已載入 ${allThreads.length} 篇貼文...` };
      }

      url = r.paging?.next || null;
      if (url) await sleep(300);
    }

    // 3. Insights per post
    const posts = [];
    for (let i = 0; i < allThreads.length; i++) {
      const t = allThreads[i];
      let insights = { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0 };
      try {
        const insRes = await apiGet(`${BASE}/${t.id}/insights?metric=views,likes,replies,reposts,quotes&access_token=${TOKEN}`);
        if (!insRes.error && insRes.data) {
          for (const item of insRes.data) {
            insights[item.name] = item.values?.[0]?.value || 0;
          }
        }
      } catch {}

      posts.push({
        id: t.id,
        date: t.timestamp ? t.timestamp.split('T')[0] : '',
        time: t.timestamp ? t.timestamp.split('T')[1]?.substring(0, 5) : '00:00',
        type: t.media_type === 'TEXT_POST' ? '純文字' : t.media_type === 'IMAGE' ? '圖片' : t.media_type === 'VIDEO' ? '影片' : t.media_type || '純文字',
        media: t.media_type === 'TEXT_POST' ? '純文字' : t.media_type === 'IMAGE' ? '圖片' : t.media_type === 'VIDEO' ? '影片' : t.media_type || '純文字',
        title: (t.text || '').substring(0, 80).replace(/\n/g, ' '),
        fullText: t.text || '',
        isQuotePost: t.is_quote_post || false,
        likes: insights.likes || 0,
        comments: insights.replies || 0,
        reposts: insights.reposts || 0,
        shares: insights.quotes || 0,
        views: insights.views || 0,
        hashtags: '',
        notes: '',
        permalink: t.permalink || '',
      });

      // Rate limit control + progress update
      if ((i + 1) % 10 === 0) {
        syncProgress = { stage: 'insights', current: i + 1, total: allThreads.length, message: `正在取得互動數據 ${i + 1}/${allThreads.length}...` };
        await sleep(1000);
      }
    }

    // 4. 增量模式：合併新舊貼文；全量模式直接用新資料
    let finalPosts;
    if (mode === 'incremental' && existingPosts.length > 0) {
      const existingIds = new Set(existingPosts.map(p => p.id));
      const trulyNew = posts.filter(p => !existingIds.has(p.id));
      finalPosts = [...trulyNew, ...existingPosts];
      finalPosts.sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || ''));
    } else {
      finalPosts = posts;
    }

    // 5. Save to file
    const output = {
      profile: {
        username: profile.username,
        name: profile.name,
        bio: profile.threads_biography || '',
        picture: profile.threads_profile_picture_url || '',
      },
      posts: finalPosts,
      fetchedAt: new Date().toISOString(),
    };
    fs.writeFileSync(dataPath, JSON.stringify(output, null, 2), 'utf-8');

    // Track follower count history
    const followerLogPath = path.join(__dirname, 'follower-history.json');
    let followerHistory = [];
    try { followerHistory = JSON.parse(fs.readFileSync(followerLogPath, 'utf-8')); } catch {}
    const todayStr = new Date().toISOString().split('T')[0];
    // Try to get follower count from threads_insights
    try {
      const fcRes = await apiGet(`${BASE}/me/threads_insights?metric=followers_count&access_token=${TOKEN}`);
      const fcData = fcRes.data?.find(d => d.name === 'followers_count');
      const count = fcData?.total_value?.value || fcData?.values?.[0]?.value || 0;
      if (count > 0) {
        const existing = followerHistory.findIndex(h => h.date === todayStr);
        if (existing >= 0) followerHistory[existing].followers = count;
        else followerHistory.push({ date: todayStr, followers: count });
        fs.writeFileSync(followerLogPath, JSON.stringify(followerHistory, null, 2), 'utf-8');
      }
    } catch {}

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    lastSyncResult = { posts: finalPosts.length, elapsed, fetchedAt: output.fetchedAt };
    syncProgress = { stage: 'done', current: finalPosts.length, total: finalPosts.length, message: '同步完成！' };

    isSyncing = false;
    res.json({
      status: 'success',
      mode: mode,
      newPosts: mode === 'incremental' ? posts.length : finalPosts.length,
      totalPosts: finalPosts.length,
      posts: finalPosts.length,
      elapsed: elapsed + 's',
      fetchedAt: output.fetchedAt,
      data: output,
    });

  } catch (err) {
    isSyncing = false;
    syncProgress = { stage: 'error', current: 0, total: 0, message: '同步失敗：' + err.message };
    res.status(500).json({ error: err.message });
  }
});

// ===== /api/status — 同步狀態 =====
app.get('/api/status', (req, res) => {
  res.json({
    syncing: isSyncing,
    lastSync: lastSyncResult,
    tokenSet: !!TOKEN,
  });
});

// ===== /api/sync-progress — 同步進度查詢 =====
app.get('/api/sync-progress', (req, res) => {
  res.json({
    syncing: isSyncing,
    ...syncProgress,
  });
});

// ===== /api/token-check — Token 到期檢查 =====
app.get('/api/token-check', (req, res) => {
  const createdAt = process.env.TOKEN_CREATED_AT;
  if (!createdAt) return res.json({ valid: !!TOKEN, daysRemaining: null, message: 'TOKEN_CREATED_AT not set in .env' });
  const created = new Date(createdAt);
  const now = new Date();
  const daysPassed = Math.floor((now - created) / 86400000);
  const daysRemaining = 60 - daysPassed;
  res.json({ valid: daysRemaining > 0, daysRemaining, createdAt, expiresAt: new Date(created.getTime() + 60*86400000).toISOString().split('T')[0] });
});

// ===== /api/fetch-log — 自動抓取日誌 =====
app.get('/api/fetch-log', (req, res) => {
  const logPath = path.join(__dirname, 'auto-fetch.log');
  try {
    if (!fs.existsSync(logPath)) return res.json({ exists: false, lines: [] });
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim()).slice(-10);
    const lastSuccess = lines.findLast(l => l.includes('successfully') || l.includes('成功'));
    const lastFail = lines.findLast(l => l.includes('failed') || l.includes('失敗'));
    res.json({ exists: true, lines, lastSuccess: lastSuccess || null, lastFail: lastFail || null });
  } catch (err) {
    res.json({ exists: false, error: err.message });
  }
});

// ===== /api/followers — 粉絲成長歷史 =====
app.get('/api/followers', (req, res) => {
  const logPath = path.join(__dirname, 'follower-history.json');
  try {
    const data = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    res.json(data);
  } catch {
    res.json([]);
  }
});

// ===== /api/weekly-report — 週報 =====
app.get('/api/weekly-report', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'threads-data.json'), 'utf-8'));
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);

    const thisWeek = data.posts.filter(p => new Date(p.date) >= weekAgo);
    const lastWeek = data.posts.filter(p => { const d = new Date(p.date); return d >= twoWeeksAgo && d < weekAgo; });

    const calcStats = (arr) => ({
      count: arr.length,
      totalLikes: arr.reduce((s,p) => s + (p.likes||0), 0),
      totalComments: arr.reduce((s,p) => s + (p.comments||0), 0),
      totalReposts: arr.reduce((s,p) => s + (p.reposts||0), 0),
      totalViews: arr.reduce((s,p) => s + (p.views||0), 0),
      totalEngagement: arr.reduce((s,p) => s + (p.likes||0) + (p.comments||0) + (p.reposts||0) + (p.shares||0), 0),
      topPost: [...arr].sort((a,b) => ((b.likes||0)+(b.comments||0)+(b.reposts||0)) - ((a.likes||0)+(a.comments||0)+(a.reposts||0)))[0] || null,
    });

    res.json({
      period: { from: weekAgo.toISOString().split('T')[0], to: now.toISOString().split('T')[0] },
      thisWeek: calcStats(thisWeek),
      lastWeek: calcStats(lastWeek),
      profile: data.profile,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Newsletter: Google Gemini API 轉換 =====
app.use('/api/nl-convert', rateLimit(20), async (req, res, next) => {
  if (req.method !== 'POST') return next();
  // 手動讀取 body，避免 express.json 中介軟體干擾
  let bodyStr = '';
  try {
    await new Promise((resolve, reject) => {
      req.on('data', chunk => { bodyStr += chunk.toString(); });
      req.on('end', resolve);
      req.on('error', reject);
    });
  } catch (e) {
    return res.status(400).json({ error: '讀取請求失敗: ' + e.message });
  }

  console.log('[newsletter] POST received, raw body length:', bodyStr.length);

  let body;
  try { body = JSON.parse(bodyStr); }
  catch { return res.status(400).json({ error: 'JSON 解析失敗' }); }

  const { prompt } = body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt 參數必填' });
  }
  if (prompt.length > 10000) {
    return res.status(400).json({ error: '輸入內容過長（上限 10000 字元）' });
  }

  console.log('[newsletter] prompt length:', prompt.length);

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey || apiKey.includes('請自己')) {
    return res.status(503).json({ error: 'GOOGLE_AI_API_KEY 尚未設定，請在 .env 填入新的 Google AI API Key 後重啟伺服器' });
  }
  try {
    const postData = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.7 }
    });
    const apiRes = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      }, (r) => {
        const chunks = [];
        r.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        r.on('end', () => {
          try {
            const data = Buffer.concat(chunks).toString('utf-8');
            resolve({ status: r.statusCode, body: JSON.parse(data) });
          } catch { reject(new Error('API response parse error')); }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
    console.log('[newsletter] API status:', apiRes.status);
    if (apiRes.status !== 200) {
      const msg = apiRes.body?.error?.message || `HTTP ${apiRes.status}`;
      throw new Error(msg);
    }
    const text = apiRes.body.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) throw new Error('AI 未返回任何文字');
    console.log('[newsletter] AI response length:', text.length);
    return res.json({ success: true, result: text });
  } catch (err) {
    console.error('[newsletter] AI Error:', err.message);
    return res.status(500).json({ error: 'AI 轉換失敗', detail: err.message });
  }
});

// ===== 列出可用 Gemini 模型（debug 用）=====
app.get('/api/list-models', async (req, res) => {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey || apiKey.includes('請自己')) return res.status(503).json({ error: 'API Key 未設定' });
  const result = await new Promise((resolve, reject) => {
    https.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { headers: { 'User-Agent': 'ThreadsDashboard/1.0' } },
      (r) => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('parse error')); } });
      }
    ).on('error', reject);
  });
  const names = (result.models || []).map(m => m.name).filter(n => n.includes('flash') || n.includes('pro'));
  res.json({ total: result.models?.length || 0, filtered: names });
});

// ===== /api/ai-split-thread — 長文串文 AI 切割 =====
app.use('/api/ai-split-thread', rateLimit(10), async (req, res, next) => {
  if (req.method !== 'POST') return next();
  let bodyStr = '';
  try {
    await new Promise((resolve, reject) => {
      req.on('data', chunk => { bodyStr += chunk.toString(); });
      req.on('end', resolve);
      req.on('error', reject);
    });
  } catch (e) {
    return res.status(400).json({ error: '讀取請求失敗: ' + e.message });
  }

  let body;
  try { body = JSON.parse(bodyStr); }
  catch { return res.status(400).json({ error: 'JSON 解析失敗' }); }

  const { text, targetLen = 300, maxParts = 5, style = 'hook', authorTone = '' } = body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text 參數必填' });
  if (text.length > 6000) return res.status(400).json({ error: '輸入文章過長（上限 6000 字）' });

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey || apiKey.includes('請自己')) {
    return res.status(503).json({ error: 'GOOGLE_AI_API_KEY 尚未設定' });
  }

  const styleGuide = style === 'hook'
    ? '第 1 篇必須是強力鉤子：用反常識觀點、震驚事實或直接問句開頭，讓人一定想繼續看下去。'
    : style === 'natural'
    ? '維持原文的自然起始，不刻意改寫開頭。'
    : '第 1 篇用懸念式開頭，讓讀者好奇結局或答案。';

  const toneGuide = authorTone ? `作者語氣風格參考：${authorTone}` : '';

  const prompt = `你是 Threads 串文編輯專家。請將以下長文切割為 Threads 串文，讓讀者可以在同一個串文內連續閱讀。

規則：
1. 切割為最多 ${maxParts} 篇，每篇不超過 ${targetLen} 字（含標點）
2. ${styleGuide}
3. 中間每篇：聚焦一個論點，結尾自然銜接下篇（可留懸念，但不要硬加「欲知後事...」等老套語）
4. 最後一篇：收斂核心觀點，加上一句自然的行動呼籲（邀請留言、分享感受等）
5. 每篇結尾加上篇號，格式為「（N/總篇數）」，例如「（1/4）」
6. 完整保留作者的原有觀點，不增加原文沒有的論點
7. 保留作者語氣，不要過度精煉或學術化
8. 輸出純文字，不使用任何 Markdown 符號（不用 #、**、* 等）
${toneGuide}

原文：
${text}

請嚴格輸出以下 JSON 格式（不要有任何說明文字，直接輸出 JSON）：
{
  "totalParts": 數字,
  "posts": [
    { "seq": 1, "role": "hook", "text": "完整的貼文內容..." },
    { "seq": 2, "role": "body", "text": "完整的貼文內容..." },
    { "seq": N, "role": "cta", "text": "完整的貼文內容..." }
  ]
}

role 只能是：hook（第一篇）、body（中間篇）、cta（最後一篇）`;

  try {
    const postData = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.6 }
    });
    const apiRes = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      }, (r) => {
        const chunks = [];
        r.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        r.on('end', () => {
          try {
            const data = Buffer.concat(chunks).toString('utf-8');
            resolve({ status: r.statusCode, body: JSON.parse(data) });
          } catch { reject(new Error('API response parse error')); }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    if (apiRes.status !== 200) {
      const msg = apiRes.body?.error?.message || `HTTP ${apiRes.status}`;
      throw new Error(msg);
    }

    let rawText = apiRes.body.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) throw new Error('AI 未返回任何文字');

    // 清除可能的 markdown code block 包裝
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch {
      // 嘗試抽取 JSON
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('AI 回傳格式無法解析，請重試');
    }

    if (!parsed.posts || !Array.isArray(parsed.posts)) throw new Error('AI 回傳結構異常');

    // 補充字數資訊
    parsed.posts = parsed.posts.map(p => ({ ...p, charCount: (p.text || '').length }));
    return res.json({ success: true, result: parsed });

  } catch (err) {
    console.error('[split-thread] AI Error:', err.message);
    return res.status(500).json({ error: '切割失敗', detail: err.message });
  }
});

// ===== /api/test-publish — 測試發文權限 =====
app.get('/api/test-publish', async (req, res) => {
  if (!TOKEN) return res.status(500).json({ error: 'Missing THREADS_ACCESS_TOKEN in .env' });
  try {
    // 先取得 user id
    const profile = await apiGet(`${BASE}/me?fields=id,username&access_token=${TOKEN}`);
    if (profile.error) return res.status(401).json({ error: 'Token 無效', detail: profile.error.message });
    const userId = profile.id;

    // 嘗試建立一個測試 container（不實際發布）
    // 用 POST 到 /{userId}/threads 測試有無 publish 權限
    const testResult = await new Promise((resolve, reject) => {
      const postData = new URLSearchParams({
        media_type: 'TEXT',
        text: '【系統測試】這是一則測試訊息，不會實際發布。',
        access_token: TOKEN
      }).toString();

      const req2 = require('https').request({
        hostname: 'graph.threads.net',
        path: `/v1.0/${userId}/threads`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (r) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          try { resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) }); }
          catch { reject(new Error('parse error')); }
        });
      });
      req2.on('error', reject);
      req2.write(postData);
      req2.end();
    });

    if (testResult.status === 200 && testResult.body.id) {
      // 有 container id，代表有發文權限。不呼叫 publish，只回傳成功
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
    return res.status(500).json({ error: err.message });
  }
});

// ===== /api/publish-thread — 發布串文 =====
let isPublishing = false;
let publishProgress = { current: 0, total: 0, status: 'idle', message: '', lastPostId: null, permalinks: [] };

app.get('/api/publish-progress', (req, res) => {
  res.json({ isPublishing, ...publishProgress });
});

app.use('/api/publish-thread', async (req, res, next) => {
  if (req.method !== 'POST') return next();
  if (isPublishing) return res.status(429).json({ error: '目前正在發布中，請等待完成' });
  if (!TOKEN) return res.status(500).json({ error: 'Missing THREADS_ACCESS_TOKEN in .env' });

  let bodyStr = '';
  try {
    await new Promise((resolve, reject) => {
      req.on('data', chunk => { bodyStr += chunk.toString(); });
      req.on('end', resolve);
      req.on('error', reject);
    });
  } catch (e) {
    return res.status(400).json({ error: '讀取請求失敗' });
  }

  let body;
  try { body = JSON.parse(bodyStr); }
  catch { return res.status(400).json({ error: 'JSON 解析失敗' }); }

  const { posts } = body;
  if (!posts || !Array.isArray(posts) || posts.length === 0) {
    return res.status(400).json({ error: 'posts 陣列必填' });
  }
  if (posts.length > 10) {
    return res.status(400).json({ error: '每次最多發布 10 篇' });
  }
  for (const p of posts) {
    if (!p.text || typeof p.text !== 'string') return res.status(400).json({ error: '每篇必須有 text 欄位' });
    if (p.text.length > 500) return res.status(400).json({ error: `第 ${p.seq || '?'} 篇超過 500 字上限` });
  }

  // 取得 user id
  let userId;
  try {
    const profile = await apiGet(`${BASE}/me?fields=id&access_token=${TOKEN}`);
    if (profile.error) return res.status(401).json({ error: 'Token 無效', detail: profile.error.message });
    userId = profile.id;
  } catch (err) {
    return res.status(500).json({ error: '無法取得用戶資料：' + err.message });
  }

  // 先回應 202，讓前端開始 polling
  res.status(202).json({ status: 'started', total: posts.length, message: '開始發布串文...' });

  // 非同步發布
  isPublishing = true;
  publishProgress = { current: 0, total: posts.length, status: 'publishing', message: '準備中...', lastPostId: null, permalinks: [] };

  (async () => {
    let replyToId = null;
    const results = [];

    try {
      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        publishProgress.message = `正在發布第 ${i + 1}/${posts.length} 篇...`;
        publishProgress.current = i;

        // Step 1: 建立 container
        const containerParams = new URLSearchParams({
          media_type: 'TEXT',
          text: post.text,
          access_token: TOKEN
        });
        if (replyToId) containerParams.set('reply_to_id', replyToId);

        const containerRes = await new Promise((resolve, reject) => {
          const pd = containerParams.toString();
          const r2 = require('https').request({
            hostname: 'graph.threads.net',
            path: `/v1.0/${userId}/threads`,
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(pd) }
          }, (r) => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { reject(new Error('parse error')); } });
          });
          r2.on('error', reject);
          r2.write(pd);
          r2.end();
        });

        if (containerRes.error) throw new Error(`第 ${i + 1} 篇 container 建立失敗：${containerRes.error.message}`);
        const containerId = containerRes.id;

        // Step 2: 等待 30 秒（API 需要處理時間）
        publishProgress.message = `第 ${i + 1}/${posts.length} 篇準備中，等待 30 秒...`;
        await sleep(30000);

        // Step 3: 發布
        const publishParams = new URLSearchParams({ creation_id: containerId, access_token: TOKEN }).toString();
        const publishRes = await new Promise((resolve, reject) => {
          const r2 = require('https').request({
            hostname: 'graph.threads.net',
            path: `/v1.0/${userId}/threads_publish`,
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(publishParams) }
          }, (r) => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { reject(new Error('parse error')); } });
          });
          r2.on('error', reject);
          r2.write(publishParams);
          r2.end();
        });

        if (publishRes.error) throw new Error(`第 ${i + 1} 篇發布失敗：${publishRes.error.message}`);

        replyToId = publishRes.id;
        results.push({ seq: i + 1, postId: publishRes.id });
        publishProgress.lastPostId = publishRes.id;
        publishProgress.current = i + 1;
        publishProgress.message = `✅ 第 ${i + 1}/${posts.length} 篇發布成功`;

        // 取得 permalink（不影響主流程，失敗也沒關係）
        try {
          const detail = await apiGet(`${BASE}/${publishRes.id}?fields=permalink&access_token=${TOKEN}`);
          if (detail.permalink) publishProgress.permalinks.push(detail.permalink);
        } catch {}

        // 篇與篇之間短暫等待（避免觸發速率限制）
        if (i < posts.length - 1) await sleep(2000);
      }

      publishProgress.status = 'done';
      publishProgress.message = `🎉 全部 ${posts.length} 篇串文發布完成！`;
      publishProgress.firstPermalink = publishProgress.permalinks[0] || null;

      // 寫入發布歷史
      const histPath = path.join(__dirname, 'pub-history.json');
      let history = [];
      try { history = JSON.parse(fs.readFileSync(histPath, 'utf-8')); } catch {}
      history.unshift({
        id: 'pub_' + Date.now(),
        publishedAt: new Date().toISOString(),
        type: 'thread',
        totalParts: posts.length,
        firstText: posts[0].text.substring(0, 80),
        postIds: results.map(r => r.postId),
        permalink: publishProgress.permalinks[0] || null
      });
      if (history.length > 50) history = history.slice(0, 50);
      try { fs.writeFileSync(histPath, JSON.stringify(history, null, 2), 'utf-8'); } catch {}

    } catch (err) {
      publishProgress.status = 'error';
      publishProgress.message = '❌ 發布失敗：' + err.message;
      console.error('[publish-thread] error:', err.message);
    } finally {
      isPublishing = false;
    }
  })();
});

// ===== 靜態檔案（必須放在所有 API 路由之後）=====
app.use(express.static(__dirname));

// ===== Start =====
app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════╗');
  console.log('  ║  Threads 儀表板伺服器已啟動               ║');
  console.log(`  ║  http://localhost:${PORT}                     ║`);
  console.log('  ║                                           ║');
  console.log('  ║  按 Ctrl+C 停止伺服器                     ║');
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log('');
});
