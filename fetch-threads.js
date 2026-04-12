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

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ThreadsDashboard/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.substring(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getUserProfile() {
  const url = `${BASE}/me?fields=id,username,name,threads_profile_picture_url,threads_biography&access_token=${TOKEN}`;
  return get(url);
}

async function getAllThreads() {
  let all = [];
  let url = `${BASE}/me/threads?fields=id,text,username,permalink,timestamp,media_type,media_url,shortcode,is_quote_post&limit=50&access_token=${TOKEN}`;

  while (url) {
    const res = await get(url);
    if (res.error) {
      console.error('❌ API 錯誤:', res.error.message);
      break;
    }
    all = all.concat(res.data || []);
    console.log(`  已載入 ${all.length} 篇貼文...`);
    url = res.paging?.next || null;
    if (url) await sleep(500);
  }
  return all;
}

async function getPostInsights(postId) {
  const url = `${BASE}/${postId}/insights?metric=views,likes,replies,reposts,quotes&access_token=${TOKEN}`;
  try {
    const res = await get(url);
    if (res.error) return { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0 };
    const m = {};
    for (const item of (res.data || [])) {
      m[item.name] = item.values?.[0]?.value || 0;
    }
    return m;
  } catch {
    return { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0 };
  }
}

async function main() {
  console.log('🔄 Threads API 數據抓取開始\n');

  // 1. 個人資料
  console.log('📋 取得使用者資料...');
  const profile = await getUserProfile();
  if (profile.error) {
    console.error('❌ Token 無效或已過期:', profile.error.message);
    console.error('   請重新產生 Access Token');
    process.exit(1);
  }
  console.log(`   ✅ ${profile.name} (@${profile.username})\n`);

  // 2. 所有貼文
  console.log('📄 取得所有貼文...');
  const threads = await getAllThreads();
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
      shares: insights.quotes || 0,
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
}

main().catch(err => {
  console.error('❌ 發生錯誤:', err.message);
});
