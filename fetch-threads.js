// fetch-threads.js — 從 Threads API 拉取所有貼文 + 互動指標
// 用法：node fetch-threads.js

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const BASE = 'https://graph.threads.net/v1.0';

if (!TOKEN) {
  console.error('❌ 請在 .env 檔案中設定 THREADS_ACCESS_TOKEN');
  process.exit(1);
}

function get(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ThreadsDashboard/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error (HTTP ${res.statusCode}): ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    // 每請求 timeout：hung socket 是最常見 transient，無 timeout 會卡到 job 逾時
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Threads/Graph API 錯誤分類：'auth'=token 過期/失效/權限（需重生或刷新，應失敗告警）；'transient'=rate limit/暫時性（可重試）
// 依 Meta 慣例：190=token 過期/失效、102/2500=session、10 及 200-299=權限；4/17/32/613=rate limit、1/2=暫時性
// 不硬信通用訊息（昨日「Token 無效或已過期」對任何錯誤都印＝誤導根因）→ 以 error.code 為準
const AUTH_ERROR_CODES = new Set([190, 102, 2500, 10]);
function classifyApiError(err) {
  if (!err) return 'transient';
  const code = err.code;
  if (AUTH_ERROR_CODES.has(code)) return 'auth';
  if (typeof code === 'number' && code >= 200 && code <= 299) return 'auth'; // 權限類
  return 'transient'; // rate limit / 未知 code → 視為 transient（重試後仍失敗才 exit，且不誤標 token）
}

// 只用於關鍵單發呼叫（profile / 分頁 / followers）：reject（網路/timeout/parse）與 transient API 錯誤 → 指數退避重試
// auth 錯誤不重試（重試無意義）→ 原樣回傳交 caller 判定。getPostInsights 不用本函式（已有 core-5 fallback，避免 706×retry 拖慢）
async function getWithRetry(url, label = '', maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * Math.pow(2, attempt - 1); // 1s / 2s / 4s
      console.warn(`   ⏳ ${label} 第 ${attempt} 次重試（退避 ${backoff}ms）：${lastErr ? lastErr.message : ''}`);
      await sleep(backoff);
    }
    try {
      const res = await get(url);
      if (res.error) {
        if (classifyApiError(res.error) === 'auth') return res; // auth → 不重試
        lastErr = new Error(`API transient (code ${res.error.code}): ${res.error.message}`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e; // 網路 / timeout / JSON parse → 重試
    }
  }
  // 重試耗盡：回帶 transient 標記的錯誤物件（非 auth）→ caller 不誤標 token 過期
  return { error: { code: -1, type: 'TransientExhausted', message: lastErr ? lastErr.message : 'unknown', _transient: true } };
}

async function getUserProfile() {
  const url = `${BASE}/me?fields=id,username,name,threads_profile_picture_url,threads_biography&access_token=${TOKEN}`;
  return getWithRetry(url, 'profile');
}

async function getAllThreads() {
  let all = [];
  let url = `${BASE}/me/threads?fields=id,text,username,permalink,timestamp,media_type,media_url,shortcode,is_quote_post&limit=50&access_token=${TOKEN}`;

  while (url) {
    const res = await getWithRetry(url, `分頁(已 ${all.length} 篇)`);
    if (res.error) {
      // ⛔ 分頁中途出錯 → throw（不回傳部分資料）→ main 不會用殘缺清單覆蓋既有好檔
      const e = new Error(`貼文分頁中斷（已載入 ${all.length} 篇）：${res.error.message}`);
      e.kind = res.error._transient ? 'transient' : classifyApiError(res.error);
      throw e;
    }
    all = all.concat(res.data || []);
    console.log(`  已載入 ${all.length} 篇貼文...`);
    url = res.paging?.next || null;
    if (url) await sleep(500);
  }
  return all;
}

function parseInsights(res) {
  const m = {};
  for (const item of (res.data || [])) {
    m[item.name] = item.values?.[0]?.value || 0;
  }
  return m;
}

async function getPostInsights(postId) {
  // 正常路徑：combined 6-metric 一個 call（含真‧shares 北極星指標）
  // shares 對舊貼文可能不可得 → 失敗時 retry core-5，確保 views/likes 等不歸零
  const zero = { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0 };
  try {
    const res = await get(`${BASE}/${postId}/insights?metric=views,likes,replies,reposts,quotes,shares&access_token=${TOKEN}`);
    if (!res.error) return parseInsights(res);
    const core = await get(`${BASE}/${postId}/insights?metric=views,likes,replies,reposts,quotes&access_token=${TOKEN}`);
    if (!core.error) return parseInsights(core);
    return zero;
  } catch {
    return zero;
  }
}

async function main() {
  console.log('🔄 Threads API 數據抓取開始\n');

  // 1. 個人資料
  console.log('📋 取得使用者資料...');
  const profile = await getUserProfile();
  if (profile.error) {
    if (classifyApiError(profile.error) === 'auth') {
      console.error(`❌ Token 認證失敗 (code ${profile.error.code}): ${profile.error.message}`);
      console.error('   → 需重新產生或刷新 Access Token');
    } else {
      console.error(`❌ 暫時性錯誤，重試後仍失敗: ${profile.error.message}`);
      console.error('   → 非 token 問題，下一班次會自動重試');
    }
    process.exit(1);
  }
  console.log(`   ✅ ${profile.name} (@${profile.username})\n`);

  // 2. 所有貼文（分頁中途出錯 → 不覆蓋既有好檔，exit 1）
  console.log('📄 取得所有貼文...');
  let threads;
  try {
    threads = await getAllThreads();
  } catch (e) {
    if (e.kind === 'auth') {
      console.error(`❌ Token 認證失敗（分頁時）: ${e.message} → 需重生/刷新 token`);
    } else {
      console.error(`❌ 暫時性錯誤（分頁時），重試後仍失敗: ${e.message}`);
      console.error('   → 下班次自動重試，未覆蓋既有 threads-data.json');
    }
    process.exit(1);
  }
  console.log(`   ✅ 共 ${threads.length} 篇\n`);

  // 3. 逐篇取得指標
  console.log('📊 取得每篇貼文的互動指標...');
  const posts = [];

  for (let i = 0; i < threads.length; i++) {
    const t = threads[i];
    const insights = await getPostInsights(t.id);

    const date = t.timestamp ? t.timestamp.split('T')[0] : '';
    const time = t.timestamp ? t.timestamp.split('T')[1]?.substring(0, 5) : '00:00';
    const textPreview = (t.text || '').substring(0, 50);

    posts.push({
      id: t.id,
      date: date,
      time: time,
      type: t.media_type === 'TEXT_POST' ? '純文字' : t.media_type === 'IMAGE' ? '圖片' : t.media_type === 'VIDEO' ? '影片' : t.media_type === 'CAROUSEL_ALBUM' ? '輪播' : t.media_type || '純文字',
      media: t.media_type === 'TEXT_POST' ? '純文字' : t.media_type === 'IMAGE' ? '圖片' : t.media_type === 'VIDEO' ? '影片' : t.media_type || '純文字',
      title: (t.text || '').substring(0, 80).replace(/\n/g, ' '),
      fullText: t.text || '',
      likes: insights.likes || 0,
      comments: insights.replies || 0,
      reposts: insights.reposts || 0,
      shares: insights.shares || 0,
      quotes: insights.quotes || 0,
      views: insights.views || 0,
      hashtags: '',
      notes: '',
      permalink: t.permalink || '',
    });

    if ((i + 1) % 5 === 0) {
      console.log(`   ${i + 1}/${threads.length} 篇已處理...`);
      await sleep(1500); // 避免速率限制
    }
  }

  // 4. 輸出摘要
  console.log(`\n✅ 全部完成！共 ${posts.length} 篇貼文\n`);

  const totalViews = posts.reduce((s, p) => s + p.views, 0);
  const totalLikes = posts.reduce((s, p) => s + p.likes, 0);
  const totalComments = posts.reduce((s, p) => s + p.comments, 0);
  const totalReposts = posts.reduce((s, p) => s + p.reposts, 0);

  console.log('📊 互動總計:');
  console.log(`   瀏覽: ${totalViews.toLocaleString()}`);
  console.log(`   愛心: ${totalLikes.toLocaleString()}`);
  console.log(`   留言: ${totalComments.toLocaleString()}`);
  console.log(`   轉發: ${totalReposts.toLocaleString()}`);

  // 5. 存成 JSON（給儀表板用）
  const output = {
    profile: {
      username: profile.username,
      name: profile.name,
      bio: profile.threads_biography || '',
      picture: profile.threads_profile_picture_url || '',
    },
    posts: posts,
    fetchedAt: new Date().toISOString(),
  };

  const outputPath = path.join(__dirname, 'threads-data.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n💾 數據已儲存到: ${outputPath}`);
  console.log('   請在儀表板中點「匯入 API 數據」載入');

  // 6. 追蹤者數歷史記錄
  console.log('\n👥 取得追蹤者數...');
  try {
    const fcRes = await getWithRetry(`${BASE}/me/threads_insights?metric=followers_count&access_token=${TOKEN}`, 'followers');
    const fcData = (fcRes.data || []).find(d => d.name === 'followers_count');
    const count = fcData?.total_value?.value || fcData?.values?.[0]?.value || 0;

    if (count > 0) {
      const followerLogPath = path.join(__dirname, 'follower-history.json');
      let followerHistory = [];
      try { followerHistory = JSON.parse(fs.readFileSync(followerLogPath, 'utf-8')); } catch {}
      const todayStr = new Date().toISOString().split('T')[0];
      const existing = followerHistory.findIndex(h => h.date === todayStr);
      if (existing >= 0) followerHistory[existing].followers = count;
      else followerHistory.push({ date: todayStr, followers: count });
      fs.writeFileSync(followerLogPath, JSON.stringify(followerHistory, null, 2), 'utf-8');
      console.log(`   ✅ 追蹤者數：${count.toLocaleString()}（已寫入 follower-history.json）`);
    } else {
      console.log('   ⚠️  追蹤者數為 0 或無法取得，跳過寫入');
    }
  } catch (err) {
    console.error(`   ❌ 追蹤者數抓取失敗：${err.message}`);
  }
}

// require.main guard：workflow 直接 `node fetch-threads.js` 時 require.main===module → 照跑；被 require 測試時不自跑
if (require.main === module) {
  main().catch(err => {
    console.error('❌ 發生未預期錯誤:', err.message);
    process.exit(1); // 修假成功：原無 exit → 未捕捉錯誤時 process 回 0＝綠燈無資料（IMP-183）
  });
}

module.exports = { classifyApiError, getWithRetry, get };
