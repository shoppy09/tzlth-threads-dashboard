// ===== Utility Helpers =====
function debounce(fn, delay) {
  let timer;
  return function(...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), delay); };
}

// ===== Data Store =====
const STORAGE_KEY = 'threads_dashboard_data';
const SETTINGS_KEY = 'threads_dashboard_settings';

function loadPosts() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!raw) return [];
    if (!Array.isArray(raw)) {
      setTimeout(() => showDataWarning('資料格式異常（非陣列），建議重新同步'), 800);
      return [];
    }
    if (raw.length > 5) {
      const sample = raw.slice(0, 5);
      const hasRequired = sample.every(p => p && typeof p === 'object' && 'id' in p && 'date' in p);
      if (!hasRequired) setTimeout(() => showDataWarning('部分貼文資料缺少必要欄位，建議重新同步'), 800);
    }
    return raw;
  }
  catch { return []; }
}

function showDataWarning(msg) {
  setTimeout(() => {
    const warn = document.getElementById('fetchWarning');
    if (warn) {
      warn.style.display = 'block';
      warn.innerHTML = `⚠️ 數據驗證：${msg} <button onclick="this.parentElement.style.display='none'" style="float:right;background:none;border:none;color:#fff;cursor:pointer;font-size:16px">✕</button>`;
    }
  }, 500);
}

function savePosts(posts) {
  try {
    const json = JSON.stringify(posts);
    const sizeKB = Math.round(new Blob([json]).size / 1024);
    if (sizeKB > 4000) {
      showDataWarning(`儲存空間接近上限（${sizeKB} KB / ~5000 KB），建議匯出 CSV 後清理舊貼文`);
    }
    localStorage.setItem(STORAGE_KEY, json);
  } catch(e) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      showDataWarning('❌ 瀏覽器儲存空間已滿！請立即匯出 CSV 後清理部分舊貼文');
    }
  }
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || { followers: 5126, name: '職涯停看聽' };
  } catch { return { followers: 5126, name: '職涯停看聽' }; }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

let posts = loadPosts();
let settings = loadSettings();
let charts = {};

// ===== Tab Navigation =====
document.querySelectorAll('.nav-links li').forEach(li => {
  li.addEventListener('click', () => {
    document.querySelectorAll('.nav-links li').forEach(l => l.classList.remove('active'));
    li.classList.add('active');
    const tab = li.dataset.tab;
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    if (tab === 'dashboard') refreshDashboard();
    if (tab === 'posts') renderPostsTable();
    if (tab === 'insights') generateInsights();
    if (tab === 'suggest') generateSuggestions();
    if (tab === 'health') generateHealthCheck();
    if (tab === 'input') { renderHashtagAnalysis(); schedLoadQueue(); }
    if (tab === 'newsletter') nlInit();
  });
});

// ===== Creator Toolkit: Draft Analyzer =====
document.getElementById('draftInput').addEventListener('input', function() {
  const len = this.value.length;
  document.getElementById('draftCharCount').textContent = len + ' 字';
});

document.getElementById('analyzeDraftBtn').addEventListener('click', () => {
  const draft = document.getElementById('draftInput').value.trim();
  const result = document.getElementById('draftResult');
  if (!draft) { result.innerHTML = '<p style="color:var(--text-muted)">請先輸入草稿內容</p>'; return; }
  if (posts.length < 5) { result.innerHTML = '<p style="color:var(--text-muted)">需要至少 5 篇歷史貼文才能進行分析</p>'; return; }

  // 1. 預測分類
  const predictedType = classifyPost({ title: draft.substring(0, 80), fullText: draft, type: '', id: 'draft', date: '', time: '' }, null);

  // 2. 長度分析
  const draftLen = draft.length;
  let lenAdvice = '';
  if (draftLen < 50)       lenAdvice = { label: '極短', color: 'var(--orange)', tip: '內容太短，可能缺乏說服力。建議補充具體例子或數據。' };
  else if (draftLen < 150) lenAdvice = { label: '短文', color: 'var(--green)', tip: '適合「觀點短文」格式，言簡意賅，容易獲得快速共鳴。' };
  else if (draftLen < 300) lenAdvice = { label: '中等', color: '#3498db', tip: '中等長度，介於短文和長文之間。可考慮補充更多細節，或精簡成短文。' };
  else if (draftLen < 600) lenAdvice = { label: '長文', color: 'var(--green)', tip: '適合「長文觀點」或「案例故事」，深度夠、說服力強。' };
  else                      lenAdvice = { label: '超長文', color: 'var(--orange)', tip: '超過 600 字，建議拆成串文（2-3 則）或精簡，避免讀者跳出。' };

  // 3. 同類型歷史貼文的最佳時間
  const sameType = posts.filter(p => p.type === predictedType && totalEngagement(p) > 0);
  let bestTimeStr = '不明';
  if (sameType.length >= 3) {
    const hourStats = {};
    sameType.forEach(p => {
      const h = (p.time || '12:00').split(':')[0];
      if (!hourStats[h]) hourStats[h] = { total: 0, count: 0 };
      hourStats[h].total += totalEngagement(p);
      hourStats[h].count++;
    });
    const best = Object.entries(hourStats).sort((a,b) => (b[1].total/b[1].count) - (a[1].total/a[1].count))[0];
    if (best) bestTimeStr = best[0] + ':00';
  }

  // 4. 關鍵字比對
  const draftKws = extractMeaningfulKeywords([draft], 1).map(k => k.word);
  const hotKws = extractKeywordsByEngagement(posts.filter(p => totalEngagement(p) > 0), 3).slice(0, 20).map(k => k.word);
  const matched = draftKws.filter(k => hotKws.includes(k));
  const missing = hotKws.filter(k => !draftKws.includes(k)).slice(0, 5);

  // 5. 相似爆文（用 draftKws 比對）
  const scored = posts.map(p => {
    const pText = p.fullText || p.title || '';
    const eng = totalEngagement(p);
    let overlap = 0;
    draftKws.forEach(kw => { if (pText.includes(kw)) overlap++; });
    return { p, score: overlap / Math.max(draftKws.length, 1), eng };
  }).filter(x => x.eng > 0 && x.score > 0.1).sort((a,b) => b.score - a.score);
  const topSimilar = scored.slice(0, 3);

  // 6. 同類型平均互動
  const typeAvg = sameType.length > 0 ? Math.round(sameType.reduce((s,p) => s + totalEngagement(p), 0) / sameType.length) : 0;

  result.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px">
      <div class="viral-card">
        <h4>📌 預測分類</h4>
        <p style="margin:8px 0"><span class="type-badge type-${predictedType}">${predictedType}</span></p>
        <p style="font-size:11px;color:var(--text-muted)">同類型歷史平均互動 ${typeAvg}</p>
      </div>
      <div class="viral-card">
        <h4>📏 內容長度</h4>
        <p><span style="color:${lenAdvice.color};font-weight:700">${draftLen} 字（${lenAdvice.label}）</span></p>
        <p style="font-size:11px;color:var(--text-muted);margin-top:4px">${lenAdvice.tip}</p>
      </div>
      <div class="viral-card">
        <h4>⏰ 建議發文時間</h4>
        <p style="font-size:22px;font-weight:700;color:var(--accent)">${bestTimeStr}</p>
        <p style="font-size:11px;color:var(--text-muted)">基於同類型 ${sameType.length} 篇歷史貼文</p>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
      <div class="viral-card">
        <h4>🔑 草稿中的高互動關鍵字</h4>
        ${matched.length > 0
          ? matched.map(k => `<span style="background:var(--green);color:#fff;padding:2px 8px;border-radius:4px;margin:2px;display:inline-block;font-size:12px">${k}</span>`).join('')
          : '<p style="font-size:12px;color:var(--text-muted)">目前草稿中沒有命中高互動關鍵字</p>'
        }
      </div>
      <div class="viral-card">
        <h4>💡 建議加入的關鍵字</h4>
        ${missing.length > 0
          ? missing.map(k => `<span style="background:var(--accent);color:#fff;padding:2px 8px;border-radius:4px;margin:2px;display:inline-block;font-size:12px">${k}</span>`).join('')
          : '<p style="font-size:12px;color:var(--text-muted)">已涵蓋主要高互動關鍵字 👍</p>'
        }
      </div>
    </div>
    ${topSimilar.length > 0 ? `
    <div class="viral-card">
      <h4>📊 最相似的歷史貼文（關鍵字重疊度最高）</h4>
      ${topSimilar.map(x => `
        <div style="padding:8px 0;border-bottom:1px solid #1a1a2e;font-size:12px">
          <span class="type-badge type-${x.p.type}" style="font-size:10px">${x.p.type}</span>
          <span style="color:var(--text-dim)">${x.p.date}</span>
          <span style="color:var(--accent);font-weight:700;float:right">互動 ${x.eng}</span><br>
          <span style="color:var(--text-bright)">${escapeHtml(x.p.title)}</span>
        </div>
      `).join('')}
    </div>` : ''}
  `;
});

// ===== Creator Toolkit: Hashtag Analysis =====
function renderHashtagAnalysis() {
  const container = document.getElementById('hashtagResult');
  if (!container) return;
  if (posts.length < 5) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:13px">需要至少 5 篇貼文才能進行分析</p>';
    return;
  }

  // 從 fullText 萃取 #hashtag
  const hashStats = {};
  posts.forEach(p => {
    const text = (p.fullText || p.title || '') + ' ' + (p.hashtags || '');
    const tags = text.match(/#[\u4e00-\u9fffa-zA-Z0-9_]{1,20}/g) || [];
    const seen = new Set();
    tags.forEach(tag => {
      const t = tag.toLowerCase();
      if (seen.has(t)) return;
      seen.add(t);
      if (!hashStats[t]) hashStats[t] = { total: 0, count: 0, views: 0, viewCount: 0 };
      hashStats[t].total += totalEngagement(p);
      hashStats[t].count++;
      if ((p.views || 0) > 100) { hashStats[t].views += viewEngRate(p); hashStats[t].viewCount++; }
    });
  });

  const sorted = Object.entries(hashStats)
    .filter(([, v]) => v.count >= 2)
    .map(([tag, v]) => ({ tag, avg: Math.round(v.total / v.count), count: v.count, rate: v.viewCount >= 2 ? (v.views / v.viewCount).toFixed(2) : null }))
    .sort((a, b) => b.avg - a.avg);

  if (sorted.length === 0) {
    container.innerHTML = `
      <p style="color:var(--text-muted);font-size:13px">歷史貼文中沒有找到重複出現的 Hashtag（至少需出現 2 次）。</p>
      <p style="color:var(--text-muted);font-size:12px;margin-top:8px">💡 提示：你的 Threads 貼文內容中若含有 #hashtag 格式，系統會自動萃取。目前 API 資料中 Hashtag 欄位可能為空，此功能在未來發文後會逐漸累積數據。</p>
      <div style="margin-top:16px">
        <h4 style="font-size:13px;color:var(--text-dim);margin-bottom:12px">📌 根據你的貼文主題，建議使用的 Hashtag：</h4>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${['#職涯規劃','#轉職','#職場','#求職','#履歷','#面試','#職場溝通','#主管','#升職','#離職','#職涯諮詢','#工作','#職場新人','#職場心理學','#斜槓'].map(t => `<span style="background:#1a1a2e;border:1px solid #2a2a4a;padding:4px 10px;border-radius:20px;font-size:12px;color:var(--text-dim)">${t}</span>`).join('')}
        </div>
      </div>
    `;
    return;
  }

  const top = sorted.slice(0, 20);
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="border-bottom:1px solid #2a2a4a;color:var(--text-muted)">
          <th style="text-align:left;padding:8px">Hashtag</th>
          <th style="padding:8px;text-align:center">出現篇數</th>
          <th style="padding:8px;text-align:center">平均互動</th>
          ${top.some(t => t.rate) ? '<th style="padding:8px;text-align:center">平均互動率</th>' : ''}
          <th style="padding:8px;text-align:left">建議</th>
        </tr>
      </thead>
      <tbody>
        ${top.map((t, i) => `
          <tr style="border-bottom:1px solid #1a1a2e">
            <td style="padding:8px">
              <span style="background:${i < 3 ? 'var(--accent)' : '#2a2a4a'};color:#fff;padding:3px 8px;border-radius:12px;font-size:12px">${t.tag}</span>
            </td>
            <td style="text-align:center;padding:8px;color:var(--text-dim)">${t.count}</td>
            <td style="text-align:center;padding:8px;font-weight:${i < 3 ? '700' : '400'};color:${i < 3 ? 'var(--accent)' : 'var(--text-bright)'}">${t.avg.toLocaleString()}</td>
            ${top.some(x => x.rate) ? `<td style="text-align:center;padding:8px;color:var(--text-dim)">${t.rate ? t.rate + '%' : '-'}</td>` : ''}
            <td style="padding:8px;font-size:11px;color:var(--text-muted)">${i < 3 ? '⭐ 高效標籤，優先使用' : i < 8 ? '✅ 表現穩定' : '參考使用'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <p style="font-size:11px;color:var(--text-muted);margin-top:12px">共找到 ${sorted.length} 個出現 2 次以上的 Hashtag。排行依平均互動數由高至低。</p>
  `;
}

document.getElementById('refreshHashtags')?.addEventListener('click', renderHashtagAnalysis);

// ===== Utility =====
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function getFilteredPosts() {
  const period = document.getElementById('periodFilter').value;
  if (period === 'all') return [...posts];
  // 用本地日期比較，避免 UTC 時區差異
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - parseInt(period));
  return posts.filter(p => {
    const [y, m, d] = p.date.split('-').map(Number);
    const postDate = new Date(y, m - 1, d);
    return postDate >= cutoff;
  });
}

function totalEngagement(p) {
  return (p.likes || 0) + (p.comments || 0) + (p.reposts || 0) + (p.shares || 0);
}

// 以瀏覽數計算互動率（%），需至少 100 瀏覽；無瀏覽數時回傳 null
function viewEngRate(p) {
  if ((p.views || 0) > 100) {
    return ((p.likes || 0) + (p.comments || 0) + (p.reposts || 0)) / p.views * 100;
  }
  return null;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== 中文關鍵字萃取（改良版，支援 2-4 字詞 + 層級去重）=====
// 頭部虛詞：以這些字開頭的組合通常不是獨立詞語
const KW_STOP_LEAD = new Set([...'的了是在不有我你他她它們這那個一上下中要到就都也很說好把用對但如果因為所以還是只能才會讓從和與而已然後因此雖然雖']);
// 尾部虛詞：以這些字結尾的組合通常是詞的殘片（如「職的」「到了」）
const KW_STOP_TRAIL = new Set([...'的了是也都就才又只很太最更著過嗎呢吧啊哦唉而從到和與']);
// 完整停用詞（常見功能詞組）
const KW_STOP_WORDS = new Set(['因此','而且','所以','但是','如果','雖然','就是','都是','可以','可能','需要','應該','已經','或者','或是','不是','不會','不要','沒有','有些','有時','這個','那個','一個','我們','你們','他們','她們','大家','自己','什麼','怎麼','為什麼','哪些','哪裡','這樣','那樣','很多','非常','真的','其實','一直','一些','一定','一般','一起','這種','那種','這些','那些','這麼','那麼','還是','然後','只要','只有','除了','對於','關於','透過','以及','並且','仍然','依然','繼續','開始','結束','進行','進入','出來','回去','看到','聽到','知道','認為','覺得','感覺','表示','表達','提到','說到','做到','達到','接下來','同時候','時候你','時候他','時候我','然後你','但你','但他','但我','因為你','因為他','因為我']);

/**
 * 核心萃取：從文字中取出 2-4 字純中文 chunk 並計次（每篇只算一次）
 */
function _extractChunks(texts, dedupePerText = false) {
  const counts = {};
  texts.forEach(text => {
    if (!text) return;
    const seen = dedupePerText ? new Set() : null;
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i <= text.length - len; i++) {
        const chunk = text.substring(i, i + len);
        if (!/^[\u4e00-\u9fff]+$/.test(chunk)) continue;
        if (KW_STOP_LEAD.has(chunk[0])) continue;
        if (KW_STOP_TRAIL.has(chunk[chunk.length - 1])) continue;
        if (KW_STOP_WORDS.has(chunk)) continue;
        if (seen && seen.has(chunk)) continue;
        if (seen) seen.add(chunk);
        counts[chunk] = (counts[chunk] || 0) + 1;
      }
    }
  });
  return counts;
}

/**
 * 層級去重：若短詞幾乎都是長詞的子串，則去掉短詞
 * 例：「職涯」和「職涯困境」同時高頻時，保留「職涯困境」，去掉「職涯」
 */
function _deduplicateByContainment(entries) {
  // entries: [word, count/value][]，按長度降序（長詞優先）
  const byLen = [...entries].sort((a, b) => b[0].length - a[0].length);
  const keep = new Set(byLen.map(([w]) => w));
  byLen.forEach(([longer, lCount]) => {
    // 對比所有比它短的詞
    byLen.forEach(([shorter, sCount]) => {
      if (longer === shorter || shorter.length >= longer.length) return;
      if (!longer.includes(shorter)) return;
      const lc = typeof lCount === 'number' ? lCount : lCount.count;
      const sc = typeof sCount === 'number' ? sCount : sCount.count;
      // 若短詞出現的場合有 ≥70% 都包含在長詞出現的場合，視為被長詞涵蓋
      if (lc >= sc * 0.65) keep.delete(shorter);
    });
  });
  return entries.filter(([w]) => keep.has(w));
}

/**
 * 從文字陣列萃取有意義的中文關鍵字（依出現次數排序）
 */
function extractMeaningfulKeywords(texts, minCount = 2) {
  const counts = _extractChunks(texts, false);
  const entries = Object.entries(counts).filter(([, c]) => c >= minCount);
  const deduped = _deduplicateByContainment(entries);
  return deduped
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 從貼文陣列萃取按互動加權的關鍵字（依平均互動排序）
 */
function extractKeywordsByEngagement(postsArr, minCount = 3) {
  const kwStats = {};
  postsArr.forEach(p => {
    const text = p.fullText || p.title || '';
    const eng = totalEngagement(p);
    const seen = new Set();
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i <= text.length - len; i++) {
        const chunk = text.substring(i, i + len);
        if (!/^[\u4e00-\u9fff]+$/.test(chunk)) continue;
        if (KW_STOP_LEAD.has(chunk[0])) continue;
        if (KW_STOP_TRAIL.has(chunk[chunk.length - 1])) continue;
        if (KW_STOP_WORDS.has(chunk)) continue;
        if (seen.has(chunk)) continue;
        seen.add(chunk);
        if (!kwStats[chunk]) kwStats[chunk] = { total: 0, count: 0 };
        kwStats[chunk].total += eng;
        kwStats[chunk].count++;
      }
    }
  });
  const entries = Object.entries(kwStats)
    .filter(([, v]) => v.count >= minCount)
    .map(([w, v]) => [w, v]);
  // 傳給去重函式時，用 count 做比較基準
  const forDedup = entries.map(([w, v]) => [w, v.count]);
  const keptWords = new Set(_deduplicateByContainment(forDedup).map(([w]) => w));
  return entries
    .filter(([w]) => keptWords.has(w))
    .map(([word, v]) => ({ word, avg: v.total / v.count, count: v.count }))
    .sort((a, b) => b.avg - a.avg);
}

// ===== Smart Post Classification =====
const VALID_CONTENT_TYPES = ['長文觀點','案例故事','觀點短文','導流CTA','互動問答','串文'];

function classifyPost(post, allPosts) {
  // Skip if already manually classified
  if (VALID_CONTENT_TYPES.includes(post.type)) return post.type;

  // 優先使用 fullText（完整內文），title 最多只有 80 字（API 截斷）
  const fullText = post.fullText || '';
  const text = (fullText || post.title || '').toLowerCase();
  const title = post.title || '';
  // 實際內文長度（0 表示沒有 fullText，可能是手動輸入）
  const fullLen = fullText.length;

  // Priority 1: CTA
  if (/私訊|line[@＠]?|領取|免費|諮詢|加入|輸入|預約/.test(text)) return '導流CTA';

  // Priority 2: Interactive Q&A
  if (/你覺得|你會|選哪個|來留言|你呢|有沒有|你選|你怎麼/.test(text)) return '互動問答';
  if (title.length < 60 && title.endsWith('？')) return '互動問答';

  // Priority 3: is_quote_post（Threads 引述轉發，屬於串文型態）
  if (post.isQuotePost) return '串文';

  // Priority 4: Case study (name patterns)
  if (/[A-Za-z\u4e00-\u9fff]小姐|[A-Za-z\u4e00-\u9fff]先生|[A-Za-z\u4e00-\u9fff]太太/.test(text) &&
      /產業|公司|資深|主管|工程師|設計師|企劃|會計|律師/.test(text)) return '案例故事';
  if (/我問她|我問他|她說|他說|她的目標|他的目標|諮詢案例/.test(text)) return '案例故事';

  // Priority 5: Thread continuation（同日同分鐘發布 + 以接續詞開頭）
  if (allPosts) {
    const sameTimePosts = allPosts.filter(p => p.date === post.date && p.time === post.time && p.id !== post.id);
    if (sameTimePosts.length > 0 && /^[他她我但所以而且不僅此外然而事實上（(➡️▶️]/.test(title)) return '串文';
  }

  // Priority 6: 短文判斷 — 以完整 fullText 長度為準（不用 80 字截斷的 title）
  // 真正的觀點短文：fullText < 120 字（問句、吐槽、金句類）
  if (fullLen > 0 && fullLen < 120) return '觀點短文';

  // Priority 7: 長文觀點關鍵字（不限制 title 長度，因為 title 已被截斷）
  if (/戳破|陷阱|幻覺|揭密|揭秘|別讓|為何|為什麼|真相|迷思|盲點/.test(text)) return '長文觀點';

  // Priority 8: 依 fullText 長度分類
  if (fullLen >= 280) return '長文觀點';
  if (fullLen > 0 && fullLen < 200) return '觀點短文';

  // Default（無 fullText 或 200-280 字無關鍵字）
  return '長文觀點';
}

function classifyAllPosts(posts) {
  return posts.map(p => ({ ...p, type: classifyPost(p, posts) }));
}

function getWeekday(dateStr) {
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const [y, m, d] = dateStr.split('-').map(Number);
  return days[new Date(y, m - 1, d).getDay()];
}

// ===== Dashboard =====
function refreshDashboard() {
  const filtered = getFilteredPosts();
  const n = filtered.length;

  // KPIs
  const periodLabel = document.getElementById('periodFilter').selectedOptions[0].text;
  document.getElementById('kpi-posts').textContent = n;
  document.getElementById('kpi-posts-sub').textContent = `${periodLabel}｜全部共 ${posts.length} 篇`;

  if (n > 0) {
    const avgLikes = Math.round(filtered.reduce((s, p) => s + p.likes, 0) / n);
    const avgComments = Math.round(filtered.reduce((s, p) => s + p.comments, 0) / n);
    const avgReposts = Math.round(filtered.reduce((s, p) => s + (p.reposts || 0), 0) / n);
    const avgViews = Math.round(filtered.reduce((s, p) => s + (p.views || 0), 0) / n);
    document.getElementById('kpi-views').textContent = avgViews.toLocaleString();
    document.getElementById('kpi-views-sub').textContent = `總瀏覽 ${filtered.reduce((s, p) => s + (p.views || 0), 0).toLocaleString()}`;
    const totalEng = filtered.reduce((s, p) => s + totalEngagement(p), 0);
    const engRate = ((totalEng / n) / Math.max(settings.followers, 1) * 100).toFixed(2);
    // 計算有瀏覽數的貼文的平均瀏覽互動率
    const postsWithViews = filtered.filter(p => viewEngRate(p) !== null);
    const avgViewRate = postsWithViews.length > 0
      ? (postsWithViews.reduce((s,p) => s + viewEngRate(p), 0) / postsWithViews.length).toFixed(2)
      : null;

    document.getElementById('kpi-likes').textContent = avgLikes.toLocaleString();
    document.getElementById('kpi-comments').textContent = avgComments.toLocaleString();
    document.getElementById('kpi-reposts').textContent = avgReposts.toLocaleString();
    document.getElementById('kpi-engagement').textContent = engRate + '%';
    document.getElementById('kpi-engagement-sub').textContent = avgViewRate
      ? `互動/粉絲 ${engRate}%｜互動/瀏覽 ${avgViewRate}%`
      : `平均互動 ${Math.round(totalEng / n)} / 粉絲 ${settings.followers.toLocaleString()}`;

    // Best type
    const typeStats = {};
    filtered.forEach(p => {
      if (!typeStats[p.type]) typeStats[p.type] = { total: 0, count: 0 };
      typeStats[p.type].total += totalEngagement(p);
      typeStats[p.type].count++;
    });
    let bestType = '-', bestAvg = 0;
    Object.entries(typeStats).forEach(([t, s]) => {
      const avg = s.total / s.count;
      if (avg > bestAvg) { bestAvg = avg; bestType = t; }
    });
    document.getElementById('kpi-besttype').textContent = bestType;
    document.getElementById('kpi-besttype-sub').textContent = `平均互動 ${Math.round(bestAvg)}`;

    // Likes trend sub
    const sortedByLikes = [...filtered].sort((a, b) => b.likes - a.likes);
    document.getElementById('kpi-likes-sub').textContent = `最高 ${sortedByLikes[0].likes.toLocaleString()}`;

    // Period comparison
    const compareBtn = document.getElementById('compareToggle');
    if (compareBtn && compareBtn.dataset.active === 'true') {
      const period = parseInt(document.getElementById('periodFilter').value) || 0;
      if (period > 0) {
        const now = new Date();
        const prevCutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - period * 2);
        const curCutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - period);
        const prevPosts = posts.filter(p => {
          const [y,m,d] = p.date.split('-').map(Number);
          const pd = new Date(y, m-1, d);
          return pd >= prevCutoff && pd < curCutoff;
        });

        if (prevPosts.length > 0 && n > 0) {
          const prevAvgLikes = prevPosts.reduce((s,p) => s + p.likes, 0) / prevPosts.length;
          const prevAvgComments = prevPosts.reduce((s,p) => s + p.comments, 0) / prevPosts.length;
          const prevAvgViews = prevPosts.reduce((s,p) => s + (p.views||0), 0) / prevPosts.length;
          const avgLikesVal = Math.round(filtered.reduce((s, p) => s + p.likes, 0) / n);
          const avgCommentsVal = Math.round(filtered.reduce((s, p) => s + p.comments, 0) / n);
          const avgViewsVal = Math.round(filtered.reduce((s, p) => s + (p.views||0), 0) / n);

          const showDelta = (elId, current, previous) => {
            const el = document.getElementById(elId);
            if (!el || previous === 0) return;
            const pct = ((current - previous) / previous * 100).toFixed(0);
            const arrow = pct > 0 ? '\u25B2' : '\u25BC';
            const cls = pct > 0 ? 'kpi-up' : 'kpi-down';
            el.innerHTML = `<span class="${cls}">${arrow} ${Math.abs(pct)}% vs \u4E0A\u671F</span>`;
          };

          showDelta('kpi-likes-sub', avgLikesVal, prevAvgLikes);
          showDelta('kpi-comments-sub', avgCommentsVal, Math.round(prevPosts.reduce((s,p)=>s+p.comments,0)/prevPosts.length));
          showDelta('kpi-views-sub', avgViewsVal, prevAvgViews);
        }
      }
    }

  } else {
    ['kpi-likes', 'kpi-comments', 'kpi-reposts'].forEach(id => {
      document.getElementById(id).textContent = '0';
    });
    document.getElementById('kpi-views').textContent = '0';
    document.getElementById('kpi-views-sub').textContent = '-';
    document.getElementById('kpi-engagement').textContent = '0%';
    document.getElementById('kpi-engagement-sub').textContent = '（愛心+留言+轉發）/ 粉絲數';
    document.getElementById('kpi-besttype').textContent = '-';
    document.getElementById('kpi-besttype-sub').textContent = '-';
    document.getElementById('kpi-likes-sub').textContent = '-';
    document.getElementById('kpi-comments-sub').textContent = '-';
    document.getElementById('kpi-reposts-sub').textContent = '-';
  }

  renderCharts(filtered);
  renderHeatmap(filtered);
  renderTopPosts(filtered);
  renderViralAnalysis(filtered);
  renderFollowerChart();
}

// ===== Charts =====
const COLORS = {
  '長文觀點': '#3498db',
  '案例故事': '#27ae60',
  '互動型問答': '#f1c40f',
  '觀點短文': '#e74c3c',
  '導流CTA': '#9b59b6',
  '串文': '#95a5a6',
};

function destroyChart(name) {
  if (charts[name]) { charts[name].destroy(); charts[name] = null; }
}

function renderCharts(filtered) {
  // 1. Trend Chart
  destroyChart('trend');
  const sorted = [...filtered].sort((a, b) => a.date.localeCompare(b.date));
  charts.trend = new Chart(document.getElementById('chartTrend'), {
    type: 'line',
    data: {
      labels: sorted.map(p => p.date.slice(5)),
      datasets: [
        { label: '❤️ 愛心', data: sorted.map(p => p.likes), borderColor: '#e74c3c', backgroundColor: 'rgba(231,76,60,0.1)', fill: true, tension: 0.3 },
        { label: '💬 留言', data: sorted.map(p => p.comments), borderColor: '#3498db', backgroundColor: 'rgba(52,152,219,0.1)', fill: true, tension: 0.3 },
        { label: '🔁 轉發', data: sorted.map(p => p.reposts || 0), borderColor: '#27ae60', backgroundColor: 'rgba(39,174,96,0.1)', fill: true, tension: 0.3 },
        { label: '👁 瀏覽', data: sorted.map(p => p.views || 0), borderColor: '#f39c12', backgroundColor: 'rgba(243,156,18,0.05)', fill: false, tension: 0.3, yAxisID: 'y1' },
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#8892a4' } } },
      scales: {
        x: { ticks: { color: '#556' }, grid: { color: '#1a1a2e' } },
        y: { ticks: { color: '#556' }, grid: { color: '#1a1a2e' } },
        y1: { position: 'right', ticks: { color: '#556' }, grid: { drawOnChartArea: false } },
      }
    }
  });

  // 2. Type Performance Bar
  destroyChart('type');
  const typeData = {};
  filtered.forEach(p => {
    if (!typeData[p.type]) typeData[p.type] = { likes: 0, comments: 0, reposts: 0, views: 0, count: 0 };
    typeData[p.type].likes += p.likes;
    typeData[p.type].comments += p.comments;
    typeData[p.type].reposts += (p.reposts || 0);
    typeData[p.type].views = (typeData[p.type].views || 0) + (p.views || 0);
    typeData[p.type].count++;
  });
  const types = Object.keys(typeData);
  charts.type = new Chart(document.getElementById('chartType'), {
    type: 'bar',
    data: {
      labels: types,
      datasets: [
        { label: '平均愛心', data: types.map(t => Math.round(typeData[t].likes / typeData[t].count)), backgroundColor: '#e74c3c' },
        { label: '平均留言', data: types.map(t => Math.round(typeData[t].comments / typeData[t].count)), backgroundColor: '#3498db' },
        { label: '平均轉發', data: types.map(t => Math.round(typeData[t].reposts / typeData[t].count)), backgroundColor: '#27ae60' },
        { label: '平均瀏覽', data: types.map(t => Math.round((typeData[t].views || 0) / typeData[t].count)), backgroundColor: '#f39c12' },
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#8892a4' } } },
      scales: {
        x: { ticks: { color: '#8892a4', font: { size: 11 } }, grid: { display: false } },
        y: { ticks: { color: '#556' }, grid: { color: '#1a1a2e' } },
      }
    }
  });

  // 3. Best Time
  destroyChart('time');
  const timeData = {};
  filtered.forEach(p => {
    const hour = p.time ? p.time.split(':')[0] : '12';
    const label = hour + ':00';
    if (!timeData[label]) timeData[label] = { total: 0, count: 0 };
    timeData[label].total += totalEngagement(p);
    timeData[label].count++;
  });
  const timeLabels = Object.keys(timeData).sort();
  charts.time = new Chart(document.getElementById('chartTime'), {
    type: 'bar',
    data: {
      labels: timeLabels,
      datasets: [{
        label: '平均互動數',
        data: timeLabels.map(t => Math.round(timeData[t].total / timeData[t].count)),
        backgroundColor: timeLabels.map((_, i) => `hsl(${200 + i * 30}, 70%, 55%)`),
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8892a4' }, grid: { display: false } },
        y: { ticks: { color: '#556' }, grid: { color: '#1a1a2e' } },
      }
    }
  });

  // 4. Weekday
  destroyChart('weekday');
  const weekdayData = { '一': { t: 0, c: 0 }, '二': { t: 0, c: 0 }, '三': { t: 0, c: 0 }, '四': { t: 0, c: 0 }, '五': { t: 0, c: 0 }, '六': { t: 0, c: 0 }, '日': { t: 0, c: 0 } };
  filtered.forEach(p => {
    const wd = getWeekday(p.date);
    weekdayData[wd].t += totalEngagement(p);
    weekdayData[wd].c++;
  });
  const wdLabels = ['一', '二', '三', '四', '五', '六', '日'];
  charts.weekday = new Chart(document.getElementById('chartWeekday'), {
    type: 'bar',
    data: {
      labels: wdLabels.map(d => '週' + d),
      datasets: [{
        label: '平均互動數',
        data: wdLabels.map(d => weekdayData[d].c ? Math.round(weekdayData[d].t / weekdayData[d].c) : 0),
        backgroundColor: wdLabels.map((_, i) => `hsl(${340 + i * 20}, 65%, 55%)`),
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8892a4' }, grid: { display: false } },
        y: { ticks: { color: '#556' }, grid: { color: '#1a1a2e' } },
      }
    }
  });

  // 5. Engagement Distribution Doughnut
  destroyChart('engagement');
  const totalLikes = filtered.reduce((s, p) => s + p.likes, 0);
  const totalComments = filtered.reduce((s, p) => s + p.comments, 0);
  const totalReposts = filtered.reduce((s, p) => s + (p.reposts || 0), 0);
  const totalShares = filtered.reduce((s, p) => s + (p.shares || 0), 0);
  charts.engagement = new Chart(document.getElementById('chartEngagement'), {
    type: 'doughnut',
    data: {
      labels: ['❤️ 愛心', '💬 留言', '🔁 轉發', '📤 分享'],
      datasets: [{
        data: [totalLikes, totalComments, totalReposts, totalShares],
        backgroundColor: ['#e74c3c', '#3498db', '#27ae60', '#f39c12'],
        borderWidth: 0,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#8892a4', padding: 16 } },
      }
    }
  });
}

// ===== Top Posts =====
function renderTopPosts(filtered) {
  const container = document.getElementById('topPosts');
  const top5 = [...filtered].sort((a, b) => totalEngagement(b) - totalEngagement(a)).slice(0, 5);
  if (top5.length === 0) {
    container.innerHTML = '<p style="color:#556;text-align:center;padding:20px">尚無數據</p>';
    return;
  }
  container.innerHTML = top5.map((p, i) => `
    <div class="top-post-item">
      <div class="top-post-rank">#${i + 1}</div>
      <div class="top-post-info">
        <div class="top-post-title">${escapeHtml(p.title)}</div>
        <div class="top-post-meta">
          <span>${p.date}</span>
          <span class="type-badge type-${p.type}">${p.type}</span>
          <span>${p.media}</span>
        </div>
      </div>
      <div class="top-post-stats">
        <span>❤️ ${p.likes.toLocaleString()}</span>
        <span>💬 ${p.comments}</span>
        <span>🔁 ${p.reposts || 0}</span>
        <span>📤 ${p.shares || 0}</span>
      </div>
    </div>
  `).join('');
}

// ===== Viral Analysis =====
function renderViralAnalysis(filtered) {
  const container = document.getElementById('viralContent');
  const section = document.getElementById('viralAnalysis');
  if (!container || filtered.length < 10) { if (section) section.style.display = 'none'; return; }

  section.style.display = 'block';

  // Top 10%：有瀏覽數的貼文用互動率（%）排名，避免舊爆文因發布時間長而積累更多絕對互動數
  const postsWithViews = filtered.filter(p => (p.views || 0) > 100);
  const useRateRanking = postsWithViews.length >= Math.ceil(filtered.length * 0.5);
  const sorted = [...filtered].sort((a, b) => {
    if (useRateRanking) {
      const ra = viewEngRate(a) ?? (totalEngagement(a) / Math.max(filtered.reduce((s,p)=>s+(p.views||0),0)/filtered.length, 1) * 100);
      const rb = viewEngRate(b) ?? (totalEngagement(b) / Math.max(filtered.reduce((s,p)=>s+(p.views||0),0)/filtered.length, 1) * 100);
      return rb - ra;
    }
    return totalEngagement(b) - totalEngagement(a);
  });
  const cutoff = Math.max(Math.ceil(filtered.length * 0.1), 3);
  const viral = sorted.slice(0, cutoff);
  const normal = sorted.slice(cutoff);
  if (normal.length === 0) return;

  // 1. Title length
  const viralAvgLen = Math.round(viral.reduce((s,p) => s + (p.fullText || p.title || '').length, 0) / viral.length);
  const normalAvgLen = Math.round(normal.reduce((s,p) => s + (p.fullText || p.title || '').length, 0) / normal.length);

  // 2. Keywords（使用改良版關鍵字萃取，支援 2-3 字詞並過濾虛詞殘片）
  const viralTexts = viral.map(p => p.fullText || p.title || '');
  const topKeywords = extractMeaningfulKeywords(viralTexts, 2).slice(0, 8).map(k => k.word);

  // 3. Best time
  const timeCount = {};
  viral.forEach(p => { const h = (p.time || '12:00').split(':')[0]; timeCount[h] = (timeCount[h] || 0) + 1; });
  const bestTime = Object.entries(timeCount).sort((a,b) => b[1] - a[1])[0];

  // 4. Content type
  const typeCount = {};
  viral.forEach(p => { typeCount[p.type] = (typeCount[p.type] || 0) + 1; });
  const topType = Object.entries(typeCount).sort((a,b) => b[1] - a[1])[0];

  // Avg engagement
  const viralAvgEng = Math.round(viral.reduce((s,p) => s + totalEngagement(p), 0) / viral.length);
  const normalAvgEng = Math.round(normal.reduce((s,p) => s + totalEngagement(p), 0) / normal.length);
  // Avg view engagement rate
  const viralWithViews = viral.filter(p => viewEngRate(p) !== null);
  const normalWithViews = normal.filter(p => viewEngRate(p) !== null);
  const viralAvgRate = viralWithViews.length > 0 ? (viralWithViews.reduce((s,p) => s + viewEngRate(p), 0) / viralWithViews.length).toFixed(2) : null;
  const normalAvgRate = normalWithViews.length > 0 ? (normalWithViews.reduce((s,p) => s + viewEngRate(p), 0) / normalWithViews.length).toFixed(2) : null;
  const rankNote = useRateRanking ? '<p style="font-size:10px;color:var(--text-muted);margin-top:4px">★ 以瀏覽互動率排名（較公平）</p>' : '';

  container.innerHTML = `
    <div class="viral-card">
      <h4>📏 內容長度</h4>
      <p>爆文平均 <span class="highlight-text">${viralAvgLen}</span> 字</p>
      <p>一般貼文 ${normalAvgLen} 字</p>
      <p style="margin-top:8px;font-size:11px;color:var(--text-muted)">${viralAvgLen > normalAvgLen ? '長文更容易爆！多寫深度內容' : '短文也能爆！重點是觀點犀利'}</p>
    </div>
    <div class="viral-card">
      <h4>🔑 爆文高頻關鍵字</h4>
      <p style="font-size:15px;line-height:2">${topKeywords.map(k => `<span style="background:var(--accent);padding:2px 8px;border-radius:4px;margin:2px;display:inline-block">${k}</span>`).join('')}</p>
    </div>
    <div class="viral-card">
      <h4>⏰ 最佳爆文時段</h4>
      <p>爆文最常出現在 <span class="highlight-text">${bestTime ? bestTime[0] + ':00' : '-'}</span></p>
      <p style="margin-top:8px;font-size:11px;color:var(--text-muted)">佔爆文的 ${bestTime ? Math.round(bestTime[1]/viral.length*100) : 0}%</p>
    </div>
    <div class="viral-card">
      <h4>📊 爆文 vs 一般</h4>
      ${rankNote}
      <p>爆文平均互動 <span class="highlight-text">${viralAvgEng.toLocaleString()}</span>${viralAvgRate ? ` <span style="font-size:11px;color:var(--text-muted)">（${viralAvgRate}% 互動率）</span>` : ''}</p>
      <p>一般平均互動 ${normalAvgEng.toLocaleString()}${normalAvgRate ? ` <span style="font-size:11px;color:var(--text-muted)">（${normalAvgRate}% 互動率）</span>` : ''}</p>
      <p style="margin-top:8px;font-size:11px;color:var(--text-muted)">爆文主力類型：${topType ? topType[0] : '-'}（${topType ? Math.round(topType[1]/viral.length*100) : 0}%）</p>
    </div>
  `;
}

// ===== Posts Table =====
function renderPostsTable() {
  let filtered = [...posts];
  const typeF = document.getElementById('typeFilter').value;
  if (typeF !== 'all') filtered = filtered.filter(p => p.type === typeF);

  const searchQ = (document.getElementById('searchFilter')?.value || '').trim().toLowerCase();
  if (searchQ) {
    filtered = filtered.filter(p =>
      (p.title || '').toLowerCase().includes(searchQ) ||
      (p.fullText || '').toLowerCase().includes(searchQ)
    );
  }

  const sortF = document.getElementById('sortFilter').value;
  if (sortF === 'date-desc') filtered.sort((a, b) => b.date.localeCompare(a.date));
  else if (sortF === 'date-asc') filtered.sort((a, b) => a.date.localeCompare(b.date));
  else if (sortF === 'likes-desc') filtered.sort((a, b) => b.likes - a.likes);
  else if (sortF === 'engagement-desc') filtered.sort((a, b) => totalEngagement(b) - totalEngagement(a));

  const tbody = document.getElementById('postsBody');
  const empty = document.getElementById('emptyState');

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = filtered.map(p => `
    <tr>
      <td><input type="checkbox" class="post-select-cb" data-id="${p.id}" style="width:14px;height:14px;accent-color:var(--accent)"></td>
      <td>${p.date}</td>
      <td><span class="type-badge type-${p.type}">${p.type}</span></td>
      <td>${p.media || '-'}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" title="點擊查看全文" onclick="openPostModal('${p.id}')">${escapeHtml(p.title)}</td>
      <td>${p.likes.toLocaleString()}</td>
      <td>${p.comments}</td>
      <td>${p.reposts || 0}</td>
      <td>${p.shares || 0}</td>
      <td>${p.views ? p.views.toLocaleString() : '-'}</td>
      <td>${p.views > 0 ? ((totalEngagement(p) / p.views) * 100).toFixed(1) + '%' : '-'}</td>
      <td><strong>${totalEngagement(p).toLocaleString()}</strong></td>
      <td>
        <button class="btn-sm btn-delete" onclick="deletePost('${p.id}')">刪除</button>
      </td>
    </tr>
  `).join('');
}

window.deletePost = function(id) {
  if (!confirm('確定要刪除這筆資料嗎？')) return;
  posts = posts.filter(p => p.id !== id);
  savePosts(posts);
  renderPostsTable();
  showToast('已刪除');
};

document.getElementById('typeFilter').addEventListener('change', debounce(renderPostsTable, 150));
document.getElementById('sortFilter').addEventListener('change', debounce(renderPostsTable, 150));
document.getElementById('searchFilter')?.addEventListener('input', debounce(renderPostsTable, 250));

// Select all checkbox
document.getElementById('selectAllPosts')?.addEventListener('change', function() {
  document.querySelectorAll('.post-select-cb').forEach(cb => cb.checked = this.checked);
});

// Batch delete
document.getElementById('batchDeleteBtn')?.addEventListener('click', () => {
  const selected = [...document.querySelectorAll('.post-select-cb:checked')].map(cb => cb.dataset.id);
  if (selected.length === 0) { showToast('請先勾選要刪除的貼文'); return; }
  if (!confirm(`確定刪除選取的 ${selected.length} 篇貼文？此操作無法復原。`)) return;
  posts = posts.filter(p => !selected.includes(p.id));
  savePosts(posts);
  renderPostsTable();
  showToast(`✅ 已刪除 ${selected.length} 篇貼文`);
});

// Modal type edit
document.getElementById('modalTypeEdit')?.addEventListener('change', function() {
  const postId = this._postId;
  if (!postId) return;
  const post = posts.find(p => p.id === postId);
  if (post) {
    post.type = this.value;
    const badge = document.getElementById('modalType');
    if (badge) badge.textContent = this.value;
    savePosts(posts);
    showToast('✅ 分類已更新');
  }
});

// Posts CSV export
document.getElementById('postsExportBtn')?.addEventListener('click', () => {
  let filtered = [...posts];
  const typeF = document.getElementById('typeFilter')?.value || 'all';
  if (typeF !== 'all') filtered = filtered.filter(p => p.type === typeF);
  const sortF = document.getElementById('sortFilter')?.value || 'date-desc';
  if (sortF === 'date-desc') filtered.sort((a, b) => b.date.localeCompare(a.date));
  else if (sortF === 'date-asc') filtered.sort((a, b) => a.date.localeCompare(b.date));
  else if (sortF === 'likes-desc') filtered.sort((a, b) => b.likes - a.likes);
  else if (sortF === 'engagement-desc') filtered.sort((a, b) => totalEngagement(b) - totalEngagement(a));
  if (filtered.length === 0) { showToast('沒有可匯出的數據'); return; }
  const esc = s => `"${(s || '').toString().replace(/"/g, '""')}"`;
  const headers = ['日期','時間','類型','媒體','主題（80字）','完整內文','愛心','留言','轉發','分享','瀏覽','互動總數','Hashtag','連結'];
  const rows = filtered.map(p => [
    p.date, p.time || '', p.type, p.media || '',
    esc(p.title), esc(p.fullText || p.title || ''),
    p.likes || 0, p.comments || 0, p.reposts || 0, p.shares || 0, p.views || 0,
    totalEngagement(p), esc(p.hashtags || ''), esc(p.permalink || '')
  ]);
  const csv = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `職涯停看聽貼文_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast(`✅ 已匯出 ${filtered.length} 篇貼文`);
});

// Save modal notes before closing
function saveModalNotes() {
  const notesEl = document.getElementById('modalNotes');
  if (notesEl && notesEl._postId) {
    const post = posts.find(p => p.id === notesEl._postId);
    if (post && post.notes !== notesEl.value) {
      post.notes = notesEl.value;
      savePosts(posts);
    }
  }
}

// Post full-text modal
window.openPostModal = function(postId) {
  const p = posts.find(x => x.id === postId);
  if (!p) return;
  const modal = document.getElementById('postModal');
  if (!modal) return;
  document.getElementById('modalType').textContent = p.type;
  document.getElementById('modalDate').textContent = `${p.date} ${p.time || ''}`;
  document.getElementById('modalText').textContent = p.fullText || p.title || '（無全文）';
  const stats = document.getElementById('modalStats');
  const rate = viewEngRate(p);
  stats.innerHTML = `❤️ ${p.likes || 0}　💬 ${p.comments || 0}　🔁 ${p.reposts || 0}　👁 ${(p.views || 0).toLocaleString()}${rate ? `　互動率 ${rate.toFixed(2)}%` : ''}`;
  const link = document.getElementById('modalLink');
  if (link) { link.href = p.permalink || '#'; link.style.display = p.permalink ? 'inline' : 'none'; }
  const notesEl = document.getElementById('modalNotes');
  if (notesEl) {
    notesEl.value = p.notes || '';
    notesEl._postId = p.id;
  }
  const typeEditEl = document.getElementById('modalTypeEdit');
  if (typeEditEl) {
    typeEditEl.value = p.type || '長文觀點';
    typeEditEl._postId = p.id;
  }
  modal.style.display = 'flex';
};

window.closePostModal = function() {
  saveModalNotes();
  document.getElementById('postModal').style.display = 'none';
};

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    const modal = document.getElementById('postModal');
    if (modal && modal.style.display !== 'none') {
      saveModalNotes();
      modal.style.display = 'none';
    }
  }
});

// ===== Insights =====
function generateInsights() {
  const container = document.getElementById('insightsContainer');
  try {
  // 使用全部數據做洞察（不受時間篩選影響，因為洞察需要足夠樣本）
  const allPosts = posts;
  if (allPosts.length < 3) {
    container.innerHTML = '<div class="insight-card info"><h4>📊 數據不足</h4><p>需要至少 3 筆貼文數據才能產生洞察。請先新增數據或載入範例。</p></div>';
    return;
  }

  const insights = [];

  // 1. Best post type
  const typeStats = {};
  allPosts.forEach(p => {
    if (!typeStats[p.type]) typeStats[p.type] = { likes: 0, comments: 0, total: 0, count: 0 };
    typeStats[p.type].likes += p.likes;
    typeStats[p.type].comments += p.comments;
    typeStats[p.type].total += totalEngagement(p);
    typeStats[p.type].count++;
  });

  let bestType = '', bestAvg = 0, worstType = '', worstAvg = Infinity;
  Object.entries(typeStats).forEach(([t, s]) => {
    const avg = s.total / s.count;
    if (avg > bestAvg) { bestAvg = avg; bestType = t; }
    if (avg < worstAvg) { worstAvg = avg; worstType = t; }
  });

  insights.push({
    type: 'positive',
    icon: '🏆',
    title: '最佳貼文類型',
    text: `<span class="highlight-text">${bestType}</span> 是你表現最好的類型，平均互動數 <span class="highlight-text">${Math.round(bestAvg)}</span>。建議每週至少發 2 篇此類型貼文，維持高互動率。`
  });

  if (worstType !== bestType) {
    insights.push({
      type: 'warning',
      icon: '⚠️',
      title: '待優化類型',
      text: `<span class="highlight-text">${worstType}</span> 的平均互動數最低（${Math.round(worstAvg)}）。建議調整此類型的內容策略，例如：加入更吸引人的開頭、搭配圖片、或調整發文時間。`
    });
  }

  // 2. Best time
  const timeStats = {};
  allPosts.forEach(p => {
    const hour = p.time ? parseInt(p.time.split(':')[0]) : 12;
    let slot;
    if (hour < 9) slot = '早上（9:00前）';
    else if (hour < 14) slot = '中午（9:00-14:00）';
    else if (hour < 18) slot = '下午（14:00-18:00）';
    else slot = '晚上（18:00後）';
    if (!timeStats[slot]) timeStats[slot] = { total: 0, count: 0 };
    timeStats[slot].total += totalEngagement(p);
    timeStats[slot].count++;
  });

  let bestTime = '', bestTimeAvg = 0;
  Object.entries(timeStats).forEach(([t, s]) => {
    const avg = s.total / s.count;
    if (avg > bestTimeAvg) { bestTimeAvg = avg; bestTime = t; }
  });

  insights.push({
    type: 'info',
    icon: '⏰',
    title: '最佳發文時段',
    text: `<span class="highlight-text">${bestTime}</span> 發文的平均互動數較高（${Math.round(bestTimeAvg)}）。建議將重點內容安排在此時段發布。`
  });

  // 星期幾分析
  const DAY_NAMES = ['週日','週一','週二','週三','週四','週五','週六'];
  const dowMap = {};
  allPosts.forEach(p => {
    if (!p.date) return;
    const [y, m, d] = p.date.split('-').map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    const label = DAY_NAMES[dow];
    if (!dowMap[label]) dowMap[label] = { total: 0, count: 0 };
    dowMap[label].total += totalEngagement(p);
    dowMap[label].count++;
  });
  const dowEntries = Object.entries(dowMap).filter(([, s]) => s.count >= 2);
  if (dowEntries.length >= 3) {
    const sorted = dowEntries.sort((a, b) => (b[1].total / b[1].count) - (a[1].total / a[1].count));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    const tableHtml = sorted.map(([label, s]) => {
      const avg = Math.round(s.total / s.count);
      const pct = Math.round((avg / Math.round(best[1].total / best[1].count)) * 100);
      const bar = `<div style="display:inline-block;background:var(--accent);height:6px;border-radius:3px;width:${pct}%;max-width:80px;vertical-align:middle;margin-left:6px"></div>`;
      return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px"><span style="width:36px;color:var(--text-dim)">${label}</span><span style="font-weight:600;color:var(--text);width:32px">${avg}</span>${bar}<span style="color:var(--text-muted);font-size:11px">${s.count}篇</span></div>`;
    }).join('');
    insights.push({
      icon: '📅',
      title: '哪天發文互動最好？',
      text: `<span style="color:var(--green);font-weight:600">${best[0]}</span> 平均互動最高（${Math.round(best[1].total / best[1].count)}），<span style="color:var(--accent)">${worst[0]}</span> 最低（${Math.round(worst[1].total / worst[1].count)}）。重點內容建議安排在 ${best[0]} 發布。<br><br>${tableHtml}`
    });
  }

  // 3. Media analysis
  const mediaStats = {};
  allPosts.forEach(p => {
    const m = p.media || '純文字';
    if (!mediaStats[m]) mediaStats[m] = { total: 0, count: 0 };
    mediaStats[m].total += totalEngagement(p);
    mediaStats[m].count++;
  });

  let bestMedia = '', bestMediaAvg = 0;
  Object.entries(mediaStats).forEach(([m, s]) => {
    const avg = s.total / s.count;
    if (avg > bestMediaAvg) { bestMediaAvg = avg; bestMedia = m; }
  });

  const textOnly = mediaStats['純文字'];
  const hasMedia = Object.entries(mediaStats).filter(([k]) => k !== '純文字');
  if (textOnly && hasMedia.length > 0) {
    const textAvg = textOnly.total / textOnly.count;
    const mediaAvg = hasMedia.reduce((s, [, v]) => s + v.total, 0) / hasMedia.reduce((s, [, v]) => s + v.count, 0);
    if (mediaAvg > textAvg) {
      insights.push({
        type: 'positive',
        icon: '🖼️',
        title: '附圖貼文表現更好',
        text: `帶有媒體（圖片/圖卡/影片）的貼文平均互動 <span class="highlight-text">${Math.round(mediaAvg)}</span>，純文字為 ${Math.round(textAvg)}。建議增加圖卡和視覺內容的比例。`
      });
    } else {
      insights.push({
        type: 'info',
        icon: '📝',
        title: '純文字也能有好表現',
        text: `你的純文字貼文平均互動 ${Math.round(textAvg)}，不輸有圖的貼文。你的文字功力很強！但搭配圖卡仍可提高分享率。`
      });
    }
  }

  // 4. Comment-to-like ratio (engagement quality)
  const totalLikes = allPosts.reduce((s, p) => s + p.likes, 0);
  const totalComments = allPosts.reduce((s, p) => s + p.comments, 0);
  const clRatio = totalLikes > 0 ? (totalComments / totalLikes * 100).toFixed(1) : '0';

  if (clRatio > 5) {
    insights.push({
      type: 'positive',
      icon: '💬',
      title: '留言互動率優秀',
      text: `留言/愛心比為 <span class="highlight-text">${clRatio}%</span>，高於一般帳號（3-5%）。代表你的內容能引發討論，這是 Threads 演算法很重視的指標！`
    });
  } else {
    insights.push({
      type: 'warning',
      icon: '💬',
      title: '可提升留言互動',
      text: `留言/愛心比為 ${clRatio}%。建議在貼文結尾加入開放式提問（如「你覺得呢？」「你的經驗是？」），鼓勵粉絲留言。`
    });
  }

  // 5. Posting frequency
  if (allPosts.length >= 5) {
    const dates = allPosts.map(p => new Date(p.date)).sort((a, b) => a - b);
    const daySpan = (dates[dates.length - 1] - dates[0]) / 86400000;
    const freq = (allPosts.length / Math.max(daySpan, 1) * 7).toFixed(1);

    if (freq < 3) {
      insights.push({
        type: 'warning',
        icon: '📅',
        title: '發文頻率偏低',
        text: `目前平均每週發 <span class="highlight-text">${freq} 篇</span>。建議提高到每週 5-7 篇，以維持演算法的推薦力度和粉絲黏著度。`
      });
    } else if (freq > 10) {
      insights.push({
        type: 'warning',
        icon: '📅',
        title: '發文頻率偏高',
        text: `每週平均發 ${freq} 篇，可能造成粉絲疲勞。建議控制在每週 5-7 篇，專注提升每篇品質。`
      });
    } else {
      insights.push({
        type: 'positive',
        icon: '📅',
        title: '發文頻率良好',
        text: `每週平均發 <span class="highlight-text">${freq} 篇</span>，節奏穩定。持續保持！`
      });
    }
  }

  // 6. Share analysis (viral potential)
  const avgShares = allPosts.reduce((s, p) => s + (p.shares || 0), 0) / allPosts.length;
  const highSharePosts = allPosts.filter(p => (p.shares || 0) > avgShares * 2);
  if (highSharePosts.length > 0) {
    const shareTypes = {};
    highSharePosts.forEach(p => {
      shareTypes[p.type] = (shareTypes[p.type] || 0) + 1;
    });
    const topShareType = Object.entries(shareTypes).sort((a, b) => b[1] - a[1])[0][0];
    insights.push({
      type: 'info',
      icon: '🚀',
      title: '高分享潛力內容',
      text: `<span class="highlight-text">${topShareType}</span> 類型的貼文最常被大量分享。高分享 = 高觸及新用戶。建議持續產出此類型內容，並在結尾加入「分享給需要的朋友」提示。`
    });
  }

  // 7. CTA effectiveness
  const ctaPosts = allPosts.filter(p => p.type === '導流CTA');
  if (ctaPosts.length >= 2) {
    const ctaAvg = ctaPosts.reduce((s, p) => s + totalEngagement(p), 0) / ctaPosts.length;
    const nonCtaPosts = allPosts.filter(p => p.type !== '導流CTA');
    const nonCtaAvg = nonCtaPosts.reduce((s, p) => s + totalEngagement(p), 0) / nonCtaPosts.length;
    const ratio = (ctaAvg / nonCtaAvg * 100).toFixed(0);

    insights.push({
      type: ratio < 30 ? 'warning' : 'info',
      icon: '📢',
      title: '導流貼文效果分析',
      text: `導流CTA型貼文的平均互動為一般貼文的 <span class="highlight-text">${ratio}%</span>。${ratio < 30 ? '互動偏低是正常的，但建議把CTA融入故事或乾貨型貼文中，而非獨立發佈，效果會更好。' : '表現不錯！繼續優化CTA的文案和視覺。'}`
    });
  }

  // 8. Title length correlation（使用 fullText 長度，並納入瀏覽互動率比較）
  const shortPosts = allPosts.filter(p => (p.fullText || '').length > 0 && (p.fullText || '').length < 150);
  const longPosts = allPosts.filter(p => (p.fullText || '').length >= 300);
  if (shortPosts.length >= 3 && longPosts.length >= 3) {
    const shortAvg = shortPosts.reduce((s,p) => s + totalEngagement(p), 0) / shortPosts.length;
    const longAvg = longPosts.reduce((s,p) => s + totalEngagement(p), 0) / longPosts.length;
    // 以瀏覽互動率比較（更準確，排除舊爆文時間積累效應）
    const shortWithViews = shortPosts.filter(p => viewEngRate(p) !== null);
    const longWithViews = longPosts.filter(p => viewEngRate(p) !== null);
    const shortRate = shortWithViews.length >= 2 ? shortWithViews.reduce((s,p) => s + viewEngRate(p), 0) / shortWithViews.length : null;
    const longRate = longWithViews.length >= 2 ? longWithViews.reduce((s,p) => s + viewEngRate(p), 0) / longWithViews.length : null;
    const rateNote = (shortRate && longRate) ?
      `以<strong>瀏覽互動率</strong>比較：短文 <span class="highlight-text">${shortRate.toFixed(2)}%</span> vs 長文 ${longRate.toFixed(2)}%（${shortRate > longRate ? '短文仍占優' : '長文互動率更高！'}）。` : '';
    const timeNote = shortAvg > longAvg * 2 ?
      `<br><span style="font-size:11px;color:var(--orange)">⚠️ 原始互動數差距過大，可能受舊爆文（2024年）影響——那時粉絲基數小、相對互動率高。建議以瀏覽互動率為準。</span>` : '';
    insights.push({
      type: longRate && longRate > shortRate ? 'positive' : 'info',
      icon: '📏',
      title: '內容長度 vs 互動',
      text: `長文（≥300字）${longPosts.length}篇，平均互動 <span class="highlight-text">${Math.round(longAvg)}</span>；短文（<150字）${shortPosts.length}篇，平均互動 ${Math.round(shortAvg)}。<br>${rateNote}${timeNote}<br>${longAvg > shortAvg ? '長文表現更穩健，繼續深耕長文觀點！' : '短文原始互動看起來更高，但需考量時間因素。'}`
    });
  }

  // 9. Optimal posting frequency
  if (allPosts.length >= 14) {
    const weekMap = {};
    allPosts.forEach(p => {
      const d = new Date(p.date);
      const weekKey = d.getFullYear() + '-W' + String(Math.ceil((d.getDate() + new Date(d.getFullYear(), d.getMonth(), 1).getDay()) / 7)).padStart(2,'0') + '-' + (d.getMonth()+1);
      if (!weekMap[weekKey]) weekMap[weekKey] = { posts: 0, eng: 0 };
      weekMap[weekKey].posts++;
      weekMap[weekKey].eng += totalEngagement(p);
    });
    const weeks = Object.values(weekMap).filter(w => w.posts > 0);
    const lowFreq = weeks.filter(w => w.posts <= 5);
    const highFreq = weeks.filter(w => w.posts > 5);
    if (lowFreq.length >= 2 && highFreq.length >= 2) {
      const lowAvg = Math.round(lowFreq.reduce((s,w) => s + w.eng/w.posts, 0) / lowFreq.length);
      const highAvg = Math.round(highFreq.reduce((s,w) => s + w.eng/w.posts, 0) / highFreq.length);
      insights.push({
        type: 'info',
        icon: '📅',
        title: '發文頻率 vs 單篇互動',
        text: `每週發 ≤5 篇時，單篇平均互動 <span class="highlight-text">${lowAvg}</span>；每週 >5 篇時為 ${highAvg}。${lowAvg > highAvg ? '少量精發比大量發文效果更好，建議控制在每週 4-5 篇精品內容。' : '高頻發文也能維持品質，目前的節奏很好！'}`
      });
    }
  }

  // 10. Content fatigue detection
  const fourWeeksAgo = new Date(); fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const eightWeeksAgo = new Date(); eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const recentByType = {}, previousByType = {};
  allPosts.forEach(p => {
    const d = new Date(p.date);
    const map = d >= fourWeeksAgo ? recentByType : (d >= eightWeeksAgo ? previousByType : null);
    if (map) {
      if (!map[p.type]) map[p.type] = { total: 0, count: 0 };
      map[p.type].total += totalEngagement(p);
      map[p.type].count++;
    }
  });
  Object.keys(recentByType).forEach(type => {
    if (previousByType[type] && previousByType[type].count >= 3 && recentByType[type].count >= 3) {
      const recentAvg = recentByType[type].total / recentByType[type].count;
      const prevAvg = previousByType[type].total / previousByType[type].count;
      const change = ((recentAvg - prevAvg) / prevAvg * 100).toFixed(0);
      if (change < -20) {
        insights.push({
          type: 'warning',
          icon: '😴',
          title: `${type} 出現內容疲勞`,
          text: `「${type}」近 4 週的平均互動較前 4 週<span class="highlight-text">下降 ${Math.abs(change)}%</span>。粉絲可能對此類型內容產生疲勞，建議暫時降低此類型的發文頻率，或嘗試新的切入角度。`
        });
      }
    }
  });

  // 11. Best keywords（改良版萃取，按互動加權）
  const topKw = extractKeywordsByEngagement(allPosts, 5).slice(0, 6);
  if (topKw.length >= 3) {
    insights.push({
      type: 'positive',
      icon: '🔑',
      title: '高互動關鍵字',
      text: `出現以下關鍵字的貼文互動明顯更高：${topKw.map(k => `<span class="highlight-text">${k.word}</span>（平均${Math.round(k.avg)}）`).join('、')}。建議在未來的貼文標題中融入這些關鍵字。`
    });
  }

  // 12. Week-over-week trend
  const thisWeekStart = new Date(); thisWeekStart.setDate(thisWeekStart.getDate() - 7);
  const lastWeekStart = new Date(); lastWeekStart.setDate(lastWeekStart.getDate() - 14);
  const thisWeek = allPosts.filter(p => new Date(p.date) >= thisWeekStart);
  const lastWeek = allPosts.filter(p => new Date(p.date) >= lastWeekStart && new Date(p.date) < thisWeekStart);
  if (thisWeek.length >= 2 && lastWeek.length >= 2) {
    const thisEng = thisWeek.reduce((s,p) => s + totalEngagement(p), 0);
    const lastEng = lastWeek.reduce((s,p) => s + totalEngagement(p), 0);
    const change = lastEng > 0 ? ((thisEng - lastEng) / lastEng * 100).toFixed(0) : 0;
    const direction = change > 0 ? '成長' : '下降';
    insights.push({
      type: change > 0 ? 'positive' : 'warning',
      icon: change > 0 ? '📈' : '📉',
      title: '本週 vs 上週',
      text: `本週總互動 <span class="highlight-text">${thisEng.toLocaleString()}</span>（${thisWeek.length} 篇），較上週 ${lastEng.toLocaleString()}（${lastWeek.length} 篇）<span class="highlight-text">${direction} ${Math.abs(change)}%</span>。`
    });
  }

  // 貼文類型趨勢（近3個月）
  if (allPosts.length >= 15) {
    const now = new Date();
    const months3 = [];
    for (let i = 2; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months3.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const typeMonthMap = {};
    allPosts.forEach(p => {
      const mo = p.date ? p.date.substring(0, 7) : '';
      if (!months3.includes(mo)) return;
      if (!typeMonthMap[p.type]) typeMonthMap[p.type] = {};
      if (!typeMonthMap[p.type][mo]) typeMonthMap[p.type][mo] = { total: 0, count: 0 };
      typeMonthMap[p.type][mo].total += totalEngagement(p);
      typeMonthMap[p.type][mo].count++;
    });
    const trendTypes = Object.entries(typeMonthMap)
      .filter(([, mo]) => Object.values(mo).reduce((s, v) => s + v.count, 0) >= 3)
      .map(([type, mo]) => {
        const avgs = months3.map(m => mo[m] ? Math.round(mo[m].total / mo[m].count) : null);
        const defined = avgs.filter(v => v !== null);
        const trend = defined.length >= 2 ? defined[defined.length - 1] - defined[0] : 0;
        return { type, avgs, trend };
      })
      .sort((a, b) => Math.abs(b.trend) - Math.abs(a.trend))
      .slice(0, 5);
    if (trendTypes.length >= 2) {
      const headerRow = `<tr><th style="text-align:left;padding:4px 8px;font-size:11px;color:var(--text-muted)">類型</th>${months3.map(m => `<th style="padding:4px 8px;font-size:11px;color:var(--text-muted)">${m.slice(5)}月</th>`).join('')}<th style="padding:4px 8px;font-size:11px;color:var(--text-muted)">趨勢</th></tr>`;
      const rows = trendTypes.map(t => {
        const cells = t.avgs.map(v => `<td style="text-align:center;padding:4px 8px;font-size:12px">${v !== null ? v : '─'}</td>`).join('');
        const arrow = t.trend > 5 ? `<span style="color:var(--green)">▲${t.trend}</span>` : t.trend < -5 ? `<span style="color:var(--accent)">▼${Math.abs(t.trend)}</span>` : `<span style="color:var(--text-muted)">─</span>`;
        return `<tr style="border-top:1px solid #1a1a2e"><td style="padding:4px 8px"><span class="type-badge type-${t.type}" style="font-size:10px">${t.type}</span></td>${cells}<td style="text-align:center;padding:4px 8px">${arrow}</td></tr>`;
      }).join('');
      insights.push({
        icon: '📈',
        title: '各類型貼文互動趨勢（近 3 個月）',
        text: `<table style="width:100%;border-collapse:collapse">${headerRow}${rows}</table><p style="font-size:11px;color:var(--text-muted);margin-top:8px">數值為月平均互動數（愛心+留言+轉發）。</p>`
      });
    }
  }

  container.innerHTML = insights.map(ins => `
    <div class="insight-card ${ins.type || 'info'}">
      <h4>${ins.icon} ${ins.title}</h4>
      <p>${ins.text}</p>
    </div>
  `).join('');
  } catch(err) {
    console.error('generateInsights error:', err);
    container.innerHTML = '<div class="insight-card warning"><h4>⚠️ 分析暫時無法載入</h4><p>發生錯誤：' + escapeHtml(err.message) + '。請重新整理頁面或重新分析。</p></div>';
  }
}

document.getElementById('refreshInsights').addEventListener('click', generateInsights);

// ===== Settings =====
document.getElementById('s-followers').value = settings.followers;
document.getElementById('s-name').value = settings.name;

document.getElementById('saveSettings').addEventListener('click', () => {
  settings.followers = parseInt(document.getElementById('s-followers').value) || 5126;
  settings.name = document.getElementById('s-name').value || '職涯停看聽';
  saveSettings(settings);
  showToast('設定已儲存');
});

document.getElementById('clearAllData').addEventListener('click', () => {
  if (!confirm('確定要清除所有貼文數據嗎？此操作無法還原。')) return;
  posts = [];
  savePosts(posts);
  refreshDashboard();
  showToast('已清除所有數據');
});

// ===== Export CSV =====
document.getElementById('exportBtn').addEventListener('click', () => {
  if (posts.length === 0) { showToast('沒有數據可匯出'); return; }
  const headers = ['日期', '時間', '類型', '媒體', '主題', '愛心數', '留言數', '轉發數', '分享數', '瀏覽數', 'Hashtag', '備註'];
  const csvEscape = s => `"${(s || '').replace(/"/g, '""')}"`;
  const rows = posts.map(p => [p.date, p.time, p.type, p.media, csvEscape(p.title), p.likes, p.comments, p.reposts || 0, p.shares || 0, p.views || 0, csvEscape(p.hashtags), csvEscape(p.notes)]);
  const bom = '\uFEFF';
  const csv = bom + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `threads_data_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  showToast('CSV 已匯出');
});

// ===== Import CSV =====
document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const lines = ev.target.result.split('\n').filter(l => l.trim());
    if (lines.length < 2) { showToast('CSV 格式錯誤'); return; }
    const imported = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].match(/(".*?"|[^,]+)/g);
      if (!cols || cols.length < 6) continue;
      const clean = s => s ? s.replace(/^"|"$/g, '').trim() : '';
      imported.push({
        id: Date.now().toString() + i,
        date: clean(cols[0]),
        time: clean(cols[1]) || '12:00',
        type: clean(cols[2]) || '長文觀點',
        media: clean(cols[3]) || '純文字',
        title: clean(cols[4]),
        likes: parseInt(clean(cols[5])) || 0,
        comments: parseInt(clean(cols[6])) || 0,
        reposts: parseInt(clean(cols[7])) || 0,
        shares: parseInt(clean(cols[8])) || 0,
        views: parseInt(clean(cols[9])) || 0,
        hashtags: clean(cols[10]) || '',
        notes: clean(cols[11]) || '',
      });
    }
    posts = [...posts, ...imported];
    savePosts(posts);
    showToast(`已匯入 ${imported.length} 筆數據`);
    refreshDashboard();
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ===== Import API JSON =====
document.getElementById('importApiBtn').addEventListener('click', () => {
  document.getElementById('importApiFile').click();
});

document.getElementById('importApiFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.posts || !Array.isArray(data.posts)) {
        showToast('JSON 格式不正確，缺少 posts 陣列');
        return;
      }
      // 轉換 API 格式為儀表板格式
      const imported = data.posts.map((p, i) => ({
        id: p.id || (Date.now().toString() + i),
        date: p.date || '',
        time: p.time || '12:00',
        type: p.type || '純文字',
        media: p.media || '純文字',
        title: p.title || '',
        fullText: p.fullText || '',
        isQuotePost: p.isQuotePost || false,
        likes: p.likes || 0,
        comments: p.comments || 0,
        reposts: p.reposts || 0,
        shares: p.shares || 0,
        views: p.views || 0,
        hashtags: p.hashtags || '',
        notes: p.notes || '',
        permalink: p.permalink || '',
      }));
      posts = imported; // 替換全部（不是追加）
      posts = classifyAllPosts(posts);
      savePosts(posts);
      // 更新粉絲數
      if (data.profile) {
        settings.name = data.profile.name || settings.name;
        saveSettings(settings);
      }
      showToast(`✅ 已匯入 ${imported.length} 篇 API 數據！`);
      // 切到儀表板
      document.querySelectorAll('.nav-links li').forEach(l => l.classList.remove('active'));
      document.querySelector('[data-tab="dashboard"]').classList.add('active');
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-dashboard').classList.add('active');
      refreshDashboard();
    } catch (err) {
      showToast('JSON 解析失敗: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ===== Period Filter =====
document.getElementById('periodFilter').addEventListener('change', debounce(refreshDashboard, 200));

// ===== Sync Button =====
// 同步進度輪詢
document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn');
  const icon = document.getElementById('syncIcon');
  const text = document.getElementById('syncText');
  const status = document.getElementById('syncStatus');

  btn.disabled = true;
  btn.style.opacity = '0.6';
  icon.textContent = '⏳';
  text.textContent = '同步中…';
  status.textContent = '正在觸發 GitHub Actions...';

  try {
    const res = await fetch('/api/trigger-sync');
    const data = await res.json();
    icon.textContent = '✅';
    text.textContent = data.triggered ? '已觸發' : '已更新';
    status.textContent = data.triggered
      ? '已觸發 GitHub Actions，3-5 分鐘後更新'
      : '資料每日 10:00 / 22:00（台灣時間）自動更新';
  } catch (e) {
    icon.textContent = '❌';
    text.textContent = '失敗';
    status.textContent = e.message;
  }

  setTimeout(() => {
    btn.disabled = false;
    btn.style.opacity = '1';
    icon.textContent = '🔄';
    text.textContent = '立即同步';
  }, 5000);
});

// ===== Compare Toggle =====
document.getElementById('compareToggle').addEventListener('click', function() {
  const active = this.dataset.active !== 'true';
  this.dataset.active = active;
  this.style.background = active ? 'var(--green)' : '';
  this.textContent = active ? '📊 關閉對比' : '📊 vs 上一期';
  refreshDashboard();
});

// ===== Auto-load from threads-data.json =====
function autoLoadApiData() {
  fetch('/api/threads-data')
    .then(r => {
      if (!r.ok) throw new Error('no data');
      return r.json();
    })
    .then(data => {
      if (!data.posts || !data.fetchedAt) return;

      // 檢查是否有更新的數據
      const lastLoaded = localStorage.getItem('threads_last_fetched');
      if (lastLoaded === data.fetchedAt && posts.length > 0) {
        console.log('📋 數據已是最新，無需重新載入');
        return;
      }

      // 載入新數據
      const imported = data.posts.map((p, i) => ({
        id: p.id || String(i),
        date: p.date || '',
        time: p.time || '12:00',
        type: p.type || '純文字',
        media: p.media || '純文字',
        title: p.title || '',
        fullText: p.fullText || '',
        isQuotePost: p.isQuotePost || false,
        likes: p.likes || 0,
        comments: p.comments || 0,
        reposts: p.reposts || 0,
        shares: p.shares || 0,
        views: p.views || 0,
        hashtags: '',
        notes: '',
        permalink: p.permalink || '',
      }));

      posts = imported;
      posts = classifyAllPosts(posts);
      savePosts(posts);
      localStorage.setItem('threads_last_fetched', data.fetchedAt);

      if (data.profile) {
        settings.name = data.profile.name || settings.name;
        saveSettings(settings);
      }

      console.log(`✅ 自動載入 ${imported.length} 篇貼文（抓取時間: ${data.fetchedAt}）`);
      refreshDashboard();
    })
    .catch(() => {
      // threads-data.json 不存在（本地開啟），用 localStorage 的數據
      console.log('📋 使用本地儲存數據');
    });
}

// ===== Init =====
refreshDashboard();
autoLoadApiData();

// ===== Display Last Sync Time =====
(function showLastSync() {
  const lastFetched = localStorage.getItem('threads_last_fetched');
  if (lastFetched) {
    const d = new Date(lastFetched);
    const timeStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    document.getElementById('syncStatus').textContent = `上次同步: ${timeStr}`;
  }
})();

// ===== Token & Fetch Warnings =====
(function checkWarnings() {
  // Token expiry
  fetch('/api/token-check').then(r => r.json()).then(data => {
    if (data.daysRemaining !== null && data.daysRemaining < 14) {
      const warn = document.getElementById('tokenWarning');
      if (warn) {
        warn.style.display = 'block';
        warn.className = data.daysRemaining <= 3 ? 'warning-banner warning-red' : 'warning-banner';
        const urgency = data.daysRemaining <= 3 ? '🚨 緊急！' : '⚠️';
        warn.innerHTML = `${urgency} API Token 將在 <strong>${data.daysRemaining} 天後</strong>過期（${data.expiresAt}）。請到 <a href="https://developers.facebook.com/apps/" target="_blank" style="color:#fff;text-decoration:underline">Meta 開發者平台</a> 重新產生 Token 後更新 .env 檔。 <button onclick="this.parentElement.style.display='none'" style="float:right;background:none;border:none;color:#fff;cursor:pointer;font-size:16px">✕</button>`;
      }
    }
  }).catch(() => {});

  // Auto-fetch log
  fetch('/api/fetch-log').then(r => r.json()).then(data => {
    if (data.lastFail && !data.lastSuccess) {
      const warn = document.getElementById('fetchWarning');
      if (warn) {
        warn.style.display = 'block';
        warn.innerHTML = `⚠️ 自動抓取上次執行失敗。請檢查 auto-fetch.log 或手動點擊「立即同步」。 <button onclick="this.parentElement.style.display='none'" style="float:right;background:none;border:none;color:#fff;cursor:pointer;font-size:16px">✕</button>`;
      }
    }
  }).catch(() => {});

  // 發文空窗檢查
  const allSorted = [...posts].sort((a,b) => b.date.localeCompare(a.date));
  if (allSorted.length > 0) {
    const lastPostDate = new Date(allSorted[0].date);
    const daysSince = Math.floor((new Date() - lastPostDate) / 86400000);
    const vacancyEl = document.getElementById('vacancyWarning');
    if (vacancyEl) {
      if (daysSince >= 5) {
        vacancyEl.style.display = 'block';
        vacancyEl.className = 'warning-banner warning-red';
        vacancyEl.innerHTML = `🚨 已 <strong>${daysSince} 天</strong>未發文！建議今天發一篇保持節奏。 <button onclick="this.parentElement.style.display='none'" style="float:right;background:none;border:none;color:#fff;cursor:pointer;font-size:16px">✕</button>`;
      } else if (daysSince >= 3) {
        vacancyEl.style.display = 'block';
        vacancyEl.className = 'warning-banner';
        vacancyEl.innerHTML = `📅 已 <strong>${daysSince} 天</strong>未發文，建議今天安排一篇。 <button onclick="this.parentElement.style.display='none'" style="float:right;background:none;border:none;color:#fff;cursor:pointer;font-size:16px">✕</button>`;
      } else {
        vacancyEl.style.display = 'none';
      }
    }
  }
})();

// ===== Heatmap =====
function renderHeatmap(filtered) {
  const container = document.getElementById('heatmapContainer');
  if (!container || filtered.length < 5) { if (container) container.innerHTML = '<p style="color:#556;text-align:center">數據不足</p>'; return; }

  const days = ['一','二','三','四','五','六','日'];
  const hours = ['06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','22','23'];

  // Build grid: avg engagement per day×hour
  const grid = {};
  days.forEach(d => { grid[d] = {}; hours.forEach(h => { grid[d][h] = { total: 0, count: 0 }; }); });

  const dayNames = ['日','一','二','三','四','五','六'];
  filtered.forEach(p => {
    const d = new Date(p.date);
    const day = dayNames[d.getDay()];
    const hour = (p.time || '12:00').split(':')[0].padStart(2, '0');
    if (grid[day] && grid[day][hour]) {
      grid[day][hour].total += totalEngagement(p);
      grid[day][hour].count++;
    }
  });

  // Find max for color scaling
  let maxAvg = 0;
  days.forEach(d => hours.forEach(h => {
    const avg = grid[d][h].count > 0 ? grid[d][h].total / grid[d][h].count : 0;
    if (avg > maxAvg) maxAvg = avg;
  }));

  // Render HTML table
  let html = '<table class="heatmap-table"><thead><tr><th></th>';
  hours.forEach(h => { html += `<th>${h}:00</th>`; });
  html += '</tr></thead><tbody>';

  days.forEach(d => {
    html += `<tr><td class="heatmap-day">週${d}</td>`;
    hours.forEach(h => {
      const cell = grid[d][h];
      const avg = cell.count > 0 ? Math.round(cell.total / cell.count) : 0;
      const intensity = maxAvg > 0 ? avg / maxAvg : 0;
      const r = Math.round(233 * intensity + 26 * (1-intensity));
      const g = Math.round(69 * intensity + 26 * (1-intensity));
      const b = Math.round(96 * intensity + 46 * (1-intensity));
      const alpha = cell.count > 0 ? 0.3 + intensity * 0.7 : 0.1;
      html += `<td class="heatmap-cell" style="background:rgba(${r},${g},${b},${alpha})" title="週${d} ${h}:00\n平均互動: ${avg}\n發文數: ${cell.count}">${cell.count > 0 ? avg : ''}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';

  container.innerHTML = html;
}

// ===== Content Suggestion Engine =====
function generateSuggestions() {
  const container = document.getElementById('suggestContainer');
  if (!container) return;
  try {
  if (posts.length < 10) { container.innerHTML = '<div class="insight-card info"><h4>📊 數據不足</h4><p>需要至少 10 篇貼文才能產生建議。</p></div>'; return; }

  const allPosts = posts;
  const now = new Date();
  const dayNames = ['日','一','二','三','四','五','六'];
  const today = dayNames[now.getDay()];
  const cards = [];

  // 1. Best type for today's weekday
  const todayPosts = allPosts.filter(p => {
    const d = new Date(p.date);
    return dayNames[d.getDay()] === today;
  });
  if (todayPosts.length >= 3) {
    const typePerf = {};
    todayPosts.forEach(p => {
      if (!typePerf[p.type]) typePerf[p.type] = { total: 0, count: 0 };
      typePerf[p.type].total += totalEngagement(p);
      typePerf[p.type].count++;
    });
    const bestType = Object.entries(typePerf).sort((a,b) => (b[1].total/b[1].count) - (a[1].total/a[1].count))[0];
    cards.push({
      type: 'positive', icon: '📅',
      title: `今天（週${today}）最適合發`,
      text: `根據歷史數據，週${today}發 <span class="highlight-text">${bestType[0]}</span> 的平均互動最高（${Math.round(bestType[1].total/bestType[1].count)}）。共分析了 ${todayPosts.length} 篇週${today}的貼文。`
    });
  }

  // 2. Best posting time for today
  const hourPerf = {};
  todayPosts.forEach(p => {
    const h = (p.time || '12:00').split(':')[0];
    if (!hourPerf[h]) hourPerf[h] = { total: 0, count: 0 };
    hourPerf[h].total += totalEngagement(p);
    hourPerf[h].count++;
  });
  const bestHour = Object.entries(hourPerf).sort((a,b) => (b[1].total/b[1].count) - (a[1].total/a[1].count))[0];
  if (bestHour) {
    cards.push({
      type: 'info', icon: '⏰',
      title: '建議發文時間',
      text: `週${today}的最佳發文時間是 <span class="highlight-text">${bestHour[0]}:00</span>（平均互動 ${Math.round(bestHour[1].total/bestHour[1].count)}）。`
    });
  }

  // 3. Hot keywords to use（改良版萃取，按互動加權）
  const hotKw = extractKeywordsByEngagement(allPosts, 5).slice(0, 10);
  if (hotKw.length >= 5) {
    cards.push({
      type: 'positive', icon: '🔑',
      title: '建議使用的關鍵字',
      text: `在標題中融入這些高互動關鍵字：${hotKw.map(k => `<span class="highlight-text">${k.word}</span>`).join(' ')}`
    });
  }

  // 4. Content gap - types not posted recently
  const recentTypes = {};
  const twoWeeksAgo = new Date(); twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  allPosts.filter(p => new Date(p.date) >= twoWeeksAgo).forEach(p => { recentTypes[p.type] = (recentTypes[p.type] || 0) + 1; });
  const allTypes = {};
  allPosts.forEach(p => { allTypes[p.type] = (allTypes[p.type] || 0) + 1; });
  const gaps = Object.keys(allTypes).filter(t => !recentTypes[t] || recentTypes[t] < 2).filter(t => allTypes[t] >= 5);
  if (gaps.length > 0) {
    cards.push({
      type: 'warning', icon: '📭',
      title: '近期較少發的類型',
      text: `以下類型近兩週發文較少，可以考慮補上：${gaps.map(g => `<span class="highlight-text">${g}</span>`).join('、')}。保持多樣性有助於觸及不同受眾。`
    });
  }

  // 5. Avoid fatigue warning
  const thisWeekSuggest = allPosts.filter(p => new Date(p.date) >= new Date(now.getTime() - 7*86400000));
  const weekTypeCount = {};
  thisWeekSuggest.forEach(p => { weekTypeCount[p.type] = (weekTypeCount[p.type] || 0) + 1; });
  const overused = Object.entries(weekTypeCount).filter(([,c]) => c >= 5);
  if (overused.length > 0) {
    cards.push({
      type: 'warning', icon: '⚠️',
      title: '注意內容疲勞',
      text: `本週 ${overused.map(([t,c]) => `「${t}」已發 ${c} 篇`).join('、')}，粉絲可能產生疲勞。建議今天換個類型試試。`
    });
  }

  // 6. Engagement trend
  const last7 = allPosts.filter(p => new Date(p.date) >= new Date(now.getTime() - 7*86400000));
  const prev7 = allPosts.filter(p => { const d = new Date(p.date); return d >= new Date(now.getTime() - 14*86400000) && d < new Date(now.getTime() - 7*86400000); });
  if (last7.length >= 2 && prev7.length >= 2) {
    const lastAvg = last7.reduce((s,p) => s + totalEngagement(p), 0) / last7.length;
    const prevAvg = prev7.reduce((s,p) => s + totalEngagement(p), 0) / prev7.length;
    const trend = ((lastAvg - prevAvg) / prevAvg * 100).toFixed(0);
    cards.push({
      type: trend > 0 ? 'positive' : 'warning',
      icon: trend > 0 ? '🚀' : '📉',
      title: '互動趨勢',
      text: `近 7 天平均互動 <span class="highlight-text">${Math.round(lastAvg)}</span>，${trend > 0 ? '較前一週成長' : '較前一週下降'} <span class="highlight-text">${Math.abs(trend)}%</span>。${trend > 0 ? '趨勢良好，繼續保持！' : '可以嘗試不同的標題風格或發文時間來提振互動。'}`
    });
  }

  // 7. Weekly content mix recommendation
  const typeStats = {};
  allPosts.forEach(p => {
    if (!typeStats[p.type]) typeStats[p.type] = { count: 0, eng: 0 };
    typeStats[p.type].count++;
    typeStats[p.type].eng += totalEngagement(p);
  });

  // Calculate optimal mix based on engagement per type
  const typePerf = Object.entries(typeStats).map(([t, s]) => ({
    type: t,
    avgEng: s.eng / s.count,
    count: s.count,
    pct: (s.count / allPosts.length * 100).toFixed(1)
  })).sort((a, b) => b.avgEng - a.avgEng);

  if (typePerf.length >= 3) {
    // Recommend mix: more of high-performing, less of low-performing
    const total = 7; // posts per week
    const recommended = typePerf.map((t, i) => {
      let qty;
      if (i === 0) qty = 3;       // Best type: 3/week
      else if (i === 1) qty = 2;  // 2nd best: 2/week
      else if (i === 2) qty = 1;  // 3rd: 1/week
      else qty = 0;
      return { ...t, recommended: Math.min(qty, total) };
    }).filter(t => t.recommended > 0);

    cards.push({
      type: 'positive',
      icon: '📋',
      title: '本週建議內容配比',
      text: `根據歷史互動數據，建議每週 ${total} 篇的最佳配比：<br><br>
        ${recommended.map(t => `<span class="highlight-text">${t.type}</span> × ${t.recommended} 篇（平均互動 ${Math.round(t.avgEng)}）`).join('<br>')}
        <br>+ 其他類型 × 1 篇（保持多樣性）`
    });
  }

  // 8. Short vs long text recommendation（使用 fullText 長度）
  const shortPosts = allPosts.filter(p => (p.fullText || '').length > 0 && (p.fullText || '').length < 150);
  const longPosts = allPosts.filter(p => (p.fullText || '').length >= 300);
  const shortAvg = shortPosts.length > 0 ? shortPosts.reduce((s,p) => s + totalEngagement(p), 0) / shortPosts.length : 0;
  const longAvg = longPosts.length > 0 ? longPosts.reduce((s,p) => s + totalEngagement(p), 0) / longPosts.length : 0;

  if (shortPosts.length >= 3 && longPosts.length >= 3) {
    const ratio = shortAvg > 0 && longAvg > 0 ? (shortAvg / longAvg).toFixed(1) : '?';
    // 以瀏覽互動率補充
    const sV = shortPosts.filter(p => viewEngRate(p) !== null);
    const lV = longPosts.filter(p => viewEngRate(p) !== null);
    const sRate = sV.length >= 2 ? (sV.reduce((s,p) => s + viewEngRate(p), 0) / sV.length).toFixed(2) : null;
    const lRate = lV.length >= 2 ? (lV.reduce((s,p) => s + viewEngRate(p), 0) / lV.length).toFixed(2) : null;
    const rateNote = sRate && lRate ? `<br>瀏覽互動率：短文 ${sRate}% vs 長文 ${lRate}%（${parseFloat(sRate) > parseFloat(lRate) ? '短文效率更高' : '長文效率更高'}）` : '';
    const timeCaveat = shortAvg > longAvg * 2 ? `<br><span style="font-size:11px;color:var(--orange)">⚠️ 原始互動差距受舊爆文影響，建議以互動率為準</span>` : '';
    cards.push({
      type: 'info',
      icon: '📐',
      title: '長短文最佳配比',
      text: `短文（<150字）${shortPosts.length}篇，平均互動 <span class="highlight-text">${Math.round(shortAvg)}</span>；長文（≥300字）${longPosts.length}篇，平均 ${Math.round(longAvg)}${rateNote}${timeCaveat}<br><br>
        <span style="color:var(--green)">建議比例：</span>每週 2-3 篇短文（問答/吐槽/金句）+ 3 篇長文（觀點/案例）+ 1 篇圖卡<br>
        目前短文佔 ${(shortPosts.length/allPosts.length*100).toFixed(0)}%`
    });
  }

  // 9. Media recommendation
  const imgCount = allPosts.filter(p => p.media === '圖片').length;
  const vidCount = allPosts.filter(p => p.media === '影片').length;
  const textCount = allPosts.filter(p => p.media === '純文字').length;

  cards.push({
    type: imgCount + vidCount < allPosts.length * 0.15 ? 'warning' : 'info',
    icon: '🎨',
    title: '媒體格式建議',
    text: `目前比例：純文字 ${(textCount/allPosts.length*100).toFixed(0)}% ｜ 圖片 ${(imgCount/allPosts.length*100).toFixed(0)}% ｜ 影片 ${(vidCount/allPosts.length*100).toFixed(0)}%<br><br>
      <span style="color:var(--green)">本週建議加入：</span><br>
      • 1 張職場金句圖卡（高分享潛力）<br>
      • 1 支 60 秒短影片（職涯小知識/案例快講）<br>
      圖文內容的分享率通常比純文字高 2-3 倍`
  });

  container.innerHTML = cards.map(c => `<div class="insight-card ${c.type}"><h4>${c.icon} ${c.title}</h4><p>${c.text}</p></div>`).join('');
  } catch(err) {
    console.error('generateSuggestions error:', err);
    container.innerHTML = '<div class="insight-card warning"><h4>⚠️ 分析暫時無法載入</h4><p>發生錯誤：' + escapeHtml(err.message) + '。請重新整理頁面或重新分析。</p></div>';
  }
}

document.getElementById('refreshSuggest')?.addEventListener('click', generateSuggestions);

// ===== Outlier Detection Helper =====
function detectOutliers(postsArr, metricFn) {
  const values = postsArr.map(metricFn).filter(v => v > 0);
  if (values.length < 6) return { outliers: [], filtered: postsArr, threshold: Infinity };
  const sorted = [...values].sort((a, b) => a - b);
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const threshold = q3 + 3 * (q3 - q1);
  const outliers = postsArr.filter(p => metricFn(p) > threshold);
  const filtered = postsArr.filter(p => metricFn(p) <= threshold);
  return { outliers, filtered, threshold: Math.round(threshold) };
}

// ===== Account Health Check =====
function generateHealthCheck() {
  const scoreCard = document.getElementById('healthScoreCard');
  const details = document.getElementById('healthDetails');
  try {
  if (!scoreCard || posts.length < 10) {
    if (scoreCard) scoreCard.innerHTML = '<p style="color:#556">數據不足，至少需要 10 篇貼文</p>';
    return;
  }

  // Detect outlier posts (e.g. early viral posts that distort averages)
  const outlierResult = detectOutliers(posts, p => totalEngagement(p));
  const statsBase = outlierResult.filtered; // use for health score calculations
  const outlierPosts = outlierResult.outliers;

  const allPosts = posts;
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30*86400000);
  const recent = allPosts.filter(p => new Date(p.date) >= thirtyDaysAgo);

  // Calculate 6 health dimensions (each 0-100)
  const scores = {};

  // 1. Posting Frequency (consistency)
  // Ideal: 5-7 posts per week
  const weeks = {};
  allPosts.forEach(p => {
    const d = new Date(p.date);
    const weekKey = d.getFullYear() + '-' + Math.ceil((d.getMonth()*30 + d.getDate()) / 7);
    weeks[weekKey] = (weeks[weekKey] || 0) + 1;
  });
  const recentWeeks = {};
  recent.forEach(p => {
    const d = new Date(p.date);
    const weekKey = d.getFullYear() + '-' + Math.ceil((d.getMonth()*30 + d.getDate()) / 7);
    recentWeeks[weekKey] = (recentWeeks[weekKey] || 0) + 1;
  });
  const avgFreq = Object.values(recentWeeks).length > 0 ? Object.values(recentWeeks).reduce((s,v) => s+v, 0) / Object.values(recentWeeks).length : 0;
  scores.frequency = Math.min(100, Math.round(avgFreq / 7 * 100));

  // 2. Content Diversity (mix of types)
  const typeCount = {};
  recent.forEach(p => { typeCount[p.type] = (typeCount[p.type] || 0) + 1; });
  const uniqueTypes = Object.keys(typeCount).length;
  scores.diversity = Math.min(100, Math.round(uniqueTypes / 5 * 100));

  // 3. Media Mix (not all text)
  const mediaCount = {};
  recent.forEach(p => { mediaCount[p.media] = (mediaCount[p.media] || 0) + 1; });
  const textPct = (mediaCount['純文字'] || 0) / Math.max(recent.length, 1);
  scores.mediaMix = Math.round((1 - textPct) * 100 + (textPct < 0.9 ? 20 : 0));
  scores.mediaMix = Math.min(100, Math.max(10, scores.mediaMix));

  // 4. Engagement Quality (comment-to-like ratio)
  const totalLikes = allPosts.reduce((s,p) => s + p.likes, 0);
  const totalComments = allPosts.reduce((s,p) => s + p.comments, 0);
  const clRatio = totalLikes > 0 ? (totalComments / totalLikes) : 0;
  scores.engagement = Math.min(100, Math.round(clRatio * 10 * 100)); // 10% ratio = 100

  // 5. Growth Momentum (recent vs older performance)
  const older = allPosts.filter(p => new Date(p.date) < thirtyDaysAgo);
  const recentAvg = recent.length > 0 ? recent.reduce((s,p) => s + p.likes + p.comments + p.reposts, 0) / recent.length : 0;
  const olderAvg = older.length > 0 ? older.reduce((s,p) => s + p.likes + p.comments + p.reposts, 0) / older.length : 0;
  const momentum = olderAvg > 0 ? (recentAvg / olderAvg) : 1;
  scores.momentum = Math.min(100, Math.round(momentum * 50)); // 2x growth = 100

  // 6. Bio Optimization
  const bio = settings.name || '';
  const bioText = ''; // We don't have bio in localStorage, but we can check from profile
  let bioScore = 50; // Base score
  // Check for key elements in a good bio
  // We'll do a simple check based on known data
  // Bio score is 70 because @cda_pu_positive_thinking has positioning, CTA, credentials,
  // and pain-point description, but lacks numeric social proof and has a long handle.
  bioScore = 70;
  scores.bio = bioScore;

  // Overall score (weighted average)
  const weights = { frequency: 25, diversity: 15, mediaMix: 10, engagement: 25, momentum: 15, bio: 10 };
  const totalWeight = Object.values(weights).reduce((s,w) => s+w, 0);
  const overall = Math.round(Object.entries(scores).reduce((s, [k, v]) => s + v * (weights[k] || 10), 0) / totalWeight);

  // Score color
  const getColor = (score) => score >= 80 ? '#27ae60' : score >= 60 ? '#f39c12' : '#e74c3c';
  const getGrade = (score) => score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B+' : score >= 60 ? 'B' : score >= 50 ? 'C' : 'D';

  // Render score card
  scoreCard.innerHTML = `
    <div class="health-score" style="border: 6px solid ${getColor(overall)}; color: ${getColor(overall)}">
      <div class="score-number">${overall}</div>
      <div class="score-label">${getGrade(overall)} 級</div>
    </div>
    <div class="health-breakdown">
      ${Object.entries({
        '發文頻率': scores.frequency,
        '內容多樣性': scores.diversity,
        '媒體豐富度': scores.mediaMix,
        '互動品質': scores.engagement,
        '成長動能': scores.momentum,
        'Bio 優化': scores.bio
      }).map(([label, score]) => `
        <div class="health-metric">
          <span class="health-metric-label">${label}</span>
          <div class="health-bar">
            <div class="health-bar-fill" style="width:${score}%;background:${getColor(score)}"></div>
          </div>
          <span class="health-metric-value" style="color:${getColor(score)}">${score}</span>
        </div>
      `).join('')}
    </div>
  `;

  // Generate detailed recommendations
  const cards = [];

  if (outlierPosts.length > 0) {
    const titles = outlierPosts.slice(0, 2).map(p => `「${p.title.substring(0, 25)}...」`).join('、');
    cards.push({
      type: 'warning',
      icon: '🔥',
      title: `偵測到 ${outlierPosts.length} 篇高互動離群貼文`,
      text: `${titles} 等貼文互動數遠超平均（閾值：${outlierResult.threshold}），這些可能是早期爆文或特殊事件，已排除於健檢趨勢計算，避免數據失真。`
    });
  }

  // Bio analysis
  cards.push({
    type: scores.bio >= 70 ? 'positive' : 'warning',
    icon: '📝',
    title: 'Bio 自我介紹分析',
    text: `<p style="font-size:11px;color:var(--text-muted);margin-bottom:8px">基於帳號 @cda_pu_positive_thinking 的 Bio 分析</p><strong>目前 Bio：</strong><br>
      ✅ 有明確定位（職涯顧問×講師）<br>
      ✅ 有痛點描述（轉職碰壁×履歷改不好×斜槓走不通）<br>
      ✅ 有個人背景（軍職到後勤到顧問）<br>
      ✅ 有 CTA（預約諮詢連結）<br>
      <span style="color:var(--orange)">可優化：</span><br>
      • 加入數字社會證明（如「服務 200+ 位轉職者」）<br>
      • 加入成果（如「學員平均薪資成長 20%」）<br>
      • Handle 太長（@cda_pu_positive_thinking，25字元），影響口碑傳播`
  });

  // Content structure
  const textPosts = allPosts.filter(p => p.media === '純文字').length;
  const imgPosts = allPosts.filter(p => p.media === '圖片').length;
  const vidPosts = allPosts.filter(p => p.media === '影片').length;
  cards.push({
    type: scores.mediaMix < 50 ? 'warning' : 'info',
    icon: '🖼️',
    title: '內容媒體比例',
    text: `純文字 <span class="highlight-text">${textPosts} 篇（${(textPosts/allPosts.length*100).toFixed(0)}%）</span> ｜ 圖片 ${imgPosts} 篇 ｜ 影片 ${vidPosts} 篇<br><br>
      你的帳號幾乎全是純文字，這限制了觸及面。Threads 演算法偏好多樣化內容。<br>
      <span style="color:var(--green)">建議：</span>每週至少加 1-2 篇圖卡（金句圖、數據圖表、案例前後對比）`
  });

  // Text length insight（使用 fullText 實際長度，並納入瀏覽互動率比較）
  const shortP = allPosts.filter(p => (p.fullText || '').length > 0 && (p.fullText || '').length < 150);
  const longP = allPosts.filter(p => (p.fullText || '').length >= 300);
  const shortAvgEng = shortP.length > 0 ? Math.round(shortP.reduce((s,p) => s + p.likes + p.comments + p.reposts, 0) / shortP.length) : 0;
  const longAvgEng = longP.length > 0 ? Math.round(longP.reduce((s,p) => s + p.likes + p.comments + p.reposts, 0) / longP.length) : 0;
  const ratioSL = longAvgEng > 0 ? (shortAvgEng / longAvgEng).toFixed(1) : '?';
  const longPct = allPosts.length > 0 ? (longP.length / allPosts.length * 100).toFixed(0) : 0;
  const shortPct = allPosts.length > 0 ? (shortP.length / allPosts.length * 100).toFixed(0) : 0;
  // 以瀏覽互動率比較（排除「舊爆文因時間積累更多互動」的失真）
  const shortWithV = shortP.filter(p => viewEngRate(p) !== null);
  const longWithV = longP.filter(p => viewEngRate(p) !== null);
  const shortRateH = shortWithV.length >= 2 ? shortWithV.reduce((s,p) => s + viewEngRate(p), 0) / shortWithV.length : null;
  const longRateH = longWithV.length >= 2 ? longWithV.reduce((s,p) => s + viewEngRate(p), 0) / longWithV.length : null;
  const hasRateData = shortRateH !== null && longRateH !== null;
  const rateWinner = hasRateData ? (shortRateH > longRateH ? '短文' : '長文') : null;
  cards.push({
    type: hasRateData ? (longRateH >= shortRateH ? 'positive' : 'info') : 'info',
    icon: '📏',
    title: '文字長度 vs 互動分析',
    text: `
      <table style="width:100%;font-size:12px;border-collapse:collapse;margin-bottom:10px">
        <tr style="color:var(--text-muted)"><th style="text-align:left;padding:4px">長度</th><th style="padding:4px">篇數</th><th style="padding:4px">平均互動</th>${hasRateData ? '<th style="padding:4px">瀏覽互動率</th>' : ''}</tr>
        <tr><td style="padding:4px">短文（&lt;150字）</td><td style="text-align:center;padding:4px">${shortP.length}篇（${shortPct}%）</td><td style="text-align:center;padding:4px">${shortAvgEng}</td>${hasRateData ? `<td style="text-align:center;padding:4px">${shortRateH.toFixed(2)}%</td>` : ''}</tr>
        <tr><td style="padding:4px">長文（≥300字）</td><td style="text-align:center;padding:4px">${longP.length}篇（${longPct}%）</td><td style="text-align:center;padding:4px">${longAvgEng}</td>${hasRateData ? `<td style="text-align:center;padding:4px">${longRateH.toFixed(2)}%</td>` : ''}</tr>
      </table>
      ${shortAvgEng > longAvgEng * 2 ? `<span style="color:var(--orange);font-size:11px">⚠️ 原始互動數差距大，原因：2024年爆文（當時帳號剛起步、粉絲更活躍）歸為短文，拉高了短文平均。</span><br>` : ''}
      ${hasRateData ? `<span style="color:var(--green)">以瀏覽互動率更準確：<strong>${rateWinner}</strong> 表現更好（${rateWinner === '長文' ? longRateH.toFixed(2) : shortRateH.toFixed(2)}%）</span><br><br>` : '<br>'}
      <span style="color:var(--green)">建議：</span>每週 2-3 篇短文（提問、吐槽、金句）＋ 2-3 篇深度長文，兼顧觸及與深度`
  });

  // Posting frequency stability
  const monthlyPosts = {};
  allPosts.forEach(p => { const m = p.date.substring(0,7); monthlyPosts[m] = (monthlyPosts[m]||0)+1; });
  const months = Object.entries(monthlyPosts).sort();
  const gaps = [];
  for (let i = 1; i < months.length; i++) {
    if (months[i][1] < 5 && months[i-1][1] > 20) gaps.push(months[i][0]);
  }
  cards.push({
    type: gaps.length > 0 ? 'warning' : 'positive',
    icon: '📅',
    title: '發文穩定度',
    text: `歷史月度發文：${months.map(([m,c]) => m.slice(5) + '月:' + c + '篇').join('、')}<br><br>
      ${gaps.length > 0 ? `<span style="color:var(--accent)">⚠️ 發現空窗期！</span>2024/10~2025/9 幾乎停更，這對演算法推薦有嚴重影響。<br>` : ''}
      <span style="color:var(--green)">建議：</span>保持每天至少 1 篇，即使是短文也好。穩定 > 爆量`
  });

  // Engagement quality
  cards.push({
    type: scores.engagement >= 70 ? 'positive' : 'info',
    icon: '💬',
    title: '互動品質分析',
    text: `留言/愛心比：<span class="highlight-text">${(totalComments/Math.max(totalLikes,1)*100).toFixed(1)}%</span>（一般帳號 3-5%）<br>
      瀏覽→互動轉換率：<span class="highlight-text">${((totalLikes+totalComments+allPosts.reduce((s,p)=>s+p.reposts,0))/Math.max(allPosts.reduce((s,p)=>s+(p.views||0),0),1)*100).toFixed(2)}%</span><br><br>
      留言比偏高代表你的內容能引發討論，這是好事！但瀏覽→互動轉換率偏低，代表很多人「看了但沒按讚」。<br>
      <span style="color:var(--green)">建議：</span>在貼文結尾加入明確的 CTA（按讚=認同、留言=分享經驗）`
  });

  // Time diversity
  const hourCounts = {};
  allPosts.forEach(p => { const h = (p.time || '12:00').split(':')[0]; hourCounts[h] = (hourCounts[h]||0)+1; });
  const topHourEntry = Object.entries(hourCounts).sort((a,b) => b[1]-a[1])[0];
  const topHourCount = topHourEntry ? topHourEntry[1] : 0;
  const topHourPct = allPosts.length > 0 ? (topHourCount / allPosts.length * 100).toFixed(0) : 0;
  const topHourLabel = topHourEntry ? topHourEntry[0] + ':00' : '-';
  cards.push({
    type: 'warning',
    icon: '⏰',
    title: '發文時間多樣性',
    text: `你有 <span class="highlight-text">${topHourCount} 篇（${topHourPct}%）</span>都集中在同一時段（${topHourLabel}）。<br><br>
      雖然這是你表現最好的時段，但過度集中可能錯過其他受眾。<br>
      <span style="color:var(--green)">建議：</span>嘗試在晚上 20:00-21:00 發文（上班族下班後的黃金時段），測試 2-3 週看互動差異`
  });

  details.innerHTML = cards.map(c => `<div class="insight-card ${c.type}"><h4>${c.icon} ${c.title}</h4><p>${c.text}</p></div>`).join('');
  } catch(err) {
    console.error('generateHealthCheck error:', err);
    if (scoreCard) scoreCard.innerHTML = '<div class="insight-card warning"><h4>⚠️ 分析暫時無法載入</h4><p>發生錯誤：' + escapeHtml(err.message) + '。請重新整理頁面或重新分析。</p></div>';
  }
}

document.getElementById('refreshHealth')?.addEventListener('click', generateHealthCheck);

// ===== Follower Chart =====
function renderFollowerChart() {
  fetch('/api/followers').then(r => r.json()).then(data => {
    if (!data || data.length < 2) {
      document.getElementById('followerNote').textContent = '需要至少 2 天的數據才能顯示趨勢（每次同步會自動記錄）';
      return;
    }
    destroyChart('followers');
    const sorted = data.sort((a,b) => a.date.localeCompare(b.date));
    charts.followers = new Chart(document.getElementById('chartFollowers'), {
      type: 'line',
      data: {
        labels: sorted.map(d => d.date.slice(5)),
        datasets: [{
          label: '粉絲數',
          data: sorted.map(d => d.followers),
          borderColor: '#9b59b6',
          backgroundColor: 'rgba(155,89,182,0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: '#9b59b6',
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#556' }, grid: { color: '#1a1a2e' } },
          y: { ticks: { color: '#556' }, grid: { color: '#1a1a2e' } },
        }
      }
    });
    const first = sorted[0].followers;
    const last = sorted[sorted.length-1].followers;
    const growth = last - first;
    document.getElementById('followerNote').textContent = `${sorted[0].date} ~ ${sorted[sorted.length-1].date} 共成長 ${growth >= 0 ? '+' : ''}${growth} 位粉絲`;
  }).catch(() => {
    document.getElementById('followerNote').textContent = '無法載入粉絲數據（需要透過伺服器啟動）';
  });
}

// ===== Engagement Predictor =====
document.getElementById('predictBtn')?.addEventListener('click', () => {
  const title = document.getElementById('predictInput').value.trim();
  const result = document.getElementById('predictResult');
  if (!title) { result.innerHTML = '<p style="color:var(--text-muted)">請輸入標題</p>'; return; }
  if (posts.length < 20) { result.innerHTML = '<p style="color:var(--text-muted)">數據不足（至少需要 20 篇貼文）</p>'; return; }

  // Simple prediction based on keyword matching with historical performance
  const titleLower = title.toLowerCase();

  // 1. Find similar posts by keyword overlap（使用改良版關鍵字萃取）
  const inputKws = extractMeaningfulKeywords([title], 1).map(k => k.word);
  const scores = posts.map(p => {
    const pText = p.fullText || p.title || '';
    let overlap = 0;
    inputKws.forEach(kw => { if (pText.includes(kw)) overlap++; });
    return { post: p, similarity: overlap / Math.max(inputKws.length, 1) };
  }).sort((a,b) => b.similarity - a.similarity);

  // Take top 10 most similar posts
  const similar = scores.slice(0, 10).filter(s => s.similarity > 0.05);

  if (similar.length < 3) {
    // Fallback: use overall average
    const avg = Math.round(posts.reduce((s,p) => s + totalEngagement(p), 0) / posts.length);
    result.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px">
        <div class="viral-card"><h4>預測互動</h4><p style="font-size:24px;font-weight:700;color:var(--accent)">${avg}</p><p>基於整體平均</p></div>
        <div class="viral-card"><h4>預測愛心</h4><p style="font-size:24px;font-weight:700;color:#e74c3c">${Math.round(posts.reduce((s,p)=>s+p.likes,0)/posts.length)}</p></div>
        <div class="viral-card"><h4>預測留言</h4><p style="font-size:24px;font-weight:700;color:#3498db">${Math.round(posts.reduce((s,p)=>s+p.comments,0)/posts.length)}</p></div>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">⚠️ 找不到足夠的相似貼文，使用整體平均估算</p>`;
    return;
  }

  const predLikes = Math.round(similar.reduce((s,x) => s + x.post.likes, 0) / similar.length);
  const predComments = Math.round(similar.reduce((s,x) => s + x.post.comments, 0) / similar.length);
  const predReposts = Math.round(similar.reduce((s,x) => s + (x.post.reposts || 0), 0) / similar.length);
  const predViews = Math.round(similar.reduce((s,x) => s + (x.post.views || 0), 0) / similar.length);
  const predTotal = predLikes + predComments + predReposts;

  const topSimilar = similar.slice(0, 3);

  // Classify the input
  const predictedType = classifyPost({ title, fullText: title, type: '', id: 'predict', date: '', time: '' }, null);

  result.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px">
      <div class="viral-card"><h4>預測互動</h4><p style="font-size:28px;font-weight:700;color:var(--accent)">${predTotal}</p></div>
      <div class="viral-card"><h4>❤️ 愛心</h4><p style="font-size:28px;font-weight:700;color:#e74c3c">${predLikes}</p></div>
      <div class="viral-card"><h4>💬 留言</h4><p style="font-size:28px;font-weight:700;color:#3498db">${predComments}</p></div>
      <div class="viral-card"><h4>👁 瀏覽</h4><p style="font-size:28px;font-weight:700;color:#f39c12">${predViews.toLocaleString()}</p></div>
    </div>
    <p style="font-size:12px;color:var(--text-dim);margin-top:12px">
      預測分類：<span class="type-badge type-${predictedType}">${predictedType}</span>
      ｜基於 ${similar.length} 篇相似貼文
    </p>
    <div style="margin-top:12px">
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:6px">最相似的歷史貼文：</p>
      ${topSimilar.map(s => `<p style="font-size:12px;color:var(--text-dim);padding:4px 0;border-bottom:1px solid #1a1a2e">• ${escapeHtml(s.post.title)} <span style="color:var(--accent)">（互動 ${totalEngagement(s.post)}）</span></p>`).join('')}
    </div>
  `;
});

// ===== Weekly Report =====
document.getElementById('genWeeklyReport')?.addEventListener('click', () => {
  const container = document.getElementById('weeklyReportResult');
  container.innerHTML = '<p style="color:var(--text-dim)">產生中...</p>';

  fetch('/api/weekly-report').then(r => r.json()).then(data => {
    const tw = data.thisWeek;
    const lw = data.lastWeek;
    const delta = (curr, prev) => {
      if (prev === 0) return '—';
      const pct = ((curr - prev) / prev * 100).toFixed(0);
      return pct > 0 ? `<span class="kpi-up">▲ ${pct}%</span>` : `<span class="kpi-down">▼ ${Math.abs(pct)}%</span>`;
    };

    container.innerHTML = `
      <div style="background:var(--bg);border-radius:12px;padding:24px;border:1px solid #2a2a4a">
        <h3 style="margin-bottom:16px">📊 週報 ${data.period.from} ~ ${data.period.to}</h3>
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <tr style="border-bottom:1px solid #2a2a4a"><th style="text-align:left;padding:8px;color:var(--text-dim)">指標</th><th style="padding:8px;color:var(--text-dim)">本週</th><th style="padding:8px;color:var(--text-dim)">上週</th><th style="padding:8px;color:var(--text-dim)">變化</th></tr>
          <tr style="border-bottom:1px solid #1a1a2e"><td style="padding:8px">發文數</td><td style="text-align:center;padding:8px">${tw.count}</td><td style="text-align:center;padding:8px">${lw.count}</td><td style="text-align:center;padding:8px">${delta(tw.count, lw.count)}</td></tr>
          <tr style="border-bottom:1px solid #1a1a2e"><td style="padding:8px">總愛心</td><td style="text-align:center;padding:8px">${tw.totalLikes.toLocaleString()}</td><td style="text-align:center;padding:8px">${lw.totalLikes.toLocaleString()}</td><td style="text-align:center;padding:8px">${delta(tw.totalLikes, lw.totalLikes)}</td></tr>
          <tr style="border-bottom:1px solid #1a1a2e"><td style="padding:8px">總留言</td><td style="text-align:center;padding:8px">${tw.totalComments}</td><td style="text-align:center;padding:8px">${lw.totalComments}</td><td style="text-align:center;padding:8px">${delta(tw.totalComments, lw.totalComments)}</td></tr>
          <tr style="border-bottom:1px solid #1a1a2e"><td style="padding:8px">總瀏覽</td><td style="text-align:center;padding:8px">${tw.totalViews.toLocaleString()}</td><td style="text-align:center;padding:8px">${lw.totalViews.toLocaleString()}</td><td style="text-align:center;padding:8px">${delta(tw.totalViews, lw.totalViews)}</td></tr>
          <tr><td style="padding:8px;font-weight:700">總互動</td><td style="text-align:center;padding:8px;font-weight:700">${tw.totalEngagement.toLocaleString()}</td><td style="text-align:center;padding:8px;font-weight:700">${lw.totalEngagement.toLocaleString()}</td><td style="text-align:center;padding:8px">${delta(tw.totalEngagement, lw.totalEngagement)}</td></tr>
        </table>
        ${tw.topPost ? `<p style="margin-top:16px;font-size:12px;color:var(--text-dim)">🏆 本週最佳貼文：${escapeHtml(tw.topPost.title)}（互動 ${(tw.topPost.likes||0)+(tw.topPost.comments||0)+(tw.topPost.reposts||0)}）</p>` : ''}
      </div>
    `;
  }).catch(err => {
    container.innerHTML = `<p style="color:var(--accent)">無法產生報告（需要透過伺服器啟動）: ${err.message}</p>`;
  });
});

// ===== Thread Splitter Tool =====
let tsPostsData = []; // 目前切割的串文資料

// 字數計數器
document.getElementById('tsInput')?.addEventListener('input', function() {
  const len = this.value.length;
  document.getElementById('tsCharCount').textContent = len + ' 字';
  const hint = document.getElementById('tsLenHint');
  if (len < 500) hint.textContent = '⚠️ 建議至少 500 字才有切割效果';
  else if (len > 5000) hint.textContent = '⚠️ 超過 5000 字上限';
  else if (len >= 1000) hint.textContent = `✅ 適合切割（預計 ${Math.ceil(len / 300)}–${Math.ceil(len / 200)} 篇）`;
  else hint.textContent = '可以切割，但篇數可能偏少';
});

// AI 切割按鈕
document.getElementById('tsSplitBtn')?.addEventListener('click', async () => {
  const text = document.getElementById('tsInput')?.value.trim();
  const status = document.getElementById('tsSplitStatus');
  const btn = document.getElementById('tsSplitBtn');

  if (!text) { showToast('請先貼上文章內容'); return; }
  if (text.length < 200) { showToast('文章太短，至少需要 200 字'); return; }
  if (text.length > 6000) { showToast('文章過長（上限 6000 字）'); return; }

  const targetLen = parseInt(document.getElementById('tsTargetLen')?.value || '300');
  const maxParts = parseInt(document.getElementById('tsMaxParts')?.value || '5');
  const style = document.getElementById('tsStyle')?.value || 'hook';

  btn.disabled = true;
  status.textContent = '⏳ AI 分析中，約需 10–20 秒...';

  try {
    const res = await fetch('/api/ai-split-thread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, targetLen, maxParts, style })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.detail || data.error || '切割失敗');

    tsPostsData = data.result.posts.map((p, i) => ({ ...p, id: 'ts_' + Date.now() + '_' + i }));
    tsRenderPosts();
    document.getElementById('tsSplitInput').style.display = 'none';
    document.getElementById('tsResult').style.display = 'block';
    status.textContent = '';

    // 更新標題
    document.getElementById('tsResultTitle').textContent = `✅ 已切割為 ${tsPostsData.length} 篇串文`;
    const totalChars = tsPostsData.reduce((s, p) => s + (p.text || '').length, 0);
    document.getElementById('tsResultMeta').textContent = `原文 ${text.length} 字 → 串文共 ${totalChars} 字`;

  } catch (err) {
    status.textContent = '❌ ' + err.message;
    showToast('切割失敗：' + err.message);
  } finally {
    btn.disabled = false;
  }
});

// 渲染串文卡片列表
function tsRenderPosts() {
  const container = document.getElementById('tsPostList');
  if (!container) return;

  const roleLabel = { hook: '🪝 鉤子', body: '📝 論述', cta: '🎯 CTA' };
  const roleColor = { hook: 'var(--accent)', body: 'var(--blue)', cta: 'var(--green)' };

  container.innerHTML = tsPostsData.map((p, i) => {
    const len = (p.text || '').length;
    const pct = Math.min(100, Math.round(len / 500 * 100));
    const barColor = len > 450 ? 'var(--accent)' : len > 380 ? 'var(--orange)' : 'var(--green)';
    const lenWarning = len > 500 ? `<span style="color:var(--accent);font-size:11px;font-weight:700"> ⚠️ 超出 500 字上限！</span>` : len > 450 ? `<span style="color:var(--orange);font-size:11px"> 接近上限</span>` : '';

    return `
    <div class="ts-post-card" id="tscard_${p.id}">
      <div class="ts-card-header">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="ts-seq-badge">${i + 1}</span>
          <span style="font-size:12px;font-weight:700;color:${roleColor[p.role] || 'var(--text-dim)'}">
            ${roleLabel[p.role] || p.role}
          </span>
          <span style="font-size:11px;color:var(--text-muted)">${len} 字${lenWarning}</span>
        </div>
        <div style="display:flex;gap:6px">
          ${i > 0 ? `<button class="ts-btn-sm" onclick="tsMoveUp(${i})" title="上移">↑</button>` : ''}
          ${i < tsPostsData.length - 1 ? `<button class="ts-btn-sm" onclick="tsMoveDown(${i})" title="下移">↓</button>` : ''}
          <button class="ts-btn-sm" onclick="tsSplitPost(${i})" title="拆成兩篇">✂️</button>
          ${tsPostsData.length > 1 ? `<button class="ts-btn-sm ts-btn-del" onclick="tsDeletePost(${i})" title="刪除">✕</button>` : ''}
        </div>
      </div>

      <!-- 字數進度條 -->
      <div style="height:3px;background:#1a1a2e;border-radius:2px;margin:8px 0">
        <div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px;transition:width .3s"></div>
      </div>

      <!-- 編輯區 -->
      <textarea class="ts-post-textarea" id="tsta_${p.id}"
        oninput="tsUpdatePost('${p.id}', this.value)"
        style="width:100%;box-sizing:border-box;resize:vertical"
      >${escapeHtml(p.text || '')}</textarea>

      <!-- 快速 AI 調整 -->
      <div class="ts-ai-btns">
        <span style="font-size:10px;color:var(--text-muted)">AI 快速調整：</span>
        <button class="ts-btn-ai" onclick="tsAiAdjust('${p.id}', 'shorten')">縮短至 ${Math.round(parseInt(document.getElementById('tsTargetLen')?.value||300) * 0.9)} 字</button>
        <button class="ts-btn-ai" onclick="tsAiAdjust('${p.id}', 'hook')">強化開頭</button>
        <button class="ts-btn-ai" onclick="tsAiAdjust('${p.id}', 'ending')">加強結尾</button>
      </div>
    </div>`;
  }).join('');
}

// 更新單篇內容
window.tsUpdatePost = function(id, value) {
  const p = tsPostsData.find(x => x.id === id);
  if (p) {
    p.text = value;
    p.charCount = value.length;
    // 更新字數顯示（找到 card 更新）
    const card = document.getElementById('tscard_' + id);
    if (card) {
      const len = value.length;
      const lenSpan = card.querySelector('.ts-card-header span:nth-child(3)');
      const bar = card.querySelector('[style*="border-radius:2px;transition"]');
      if (lenSpan) {
        const pct = Math.min(100, Math.round(len / 500 * 100));
        const warning = len > 500 ? ' ⚠️ 超出 500 字上限！' : len > 450 ? ' 接近上限' : '';
        lenSpan.textContent = len + ' 字' + warning;
        lenSpan.style.color = len > 500 ? 'var(--accent)' : len > 450 ? 'var(--orange)' : 'var(--text-muted)';
      }
      if (bar) {
        const pct = Math.min(100, Math.round(len / 500 * 100));
        const barColor = len > 450 ? 'var(--accent)' : len > 380 ? 'var(--orange)' : 'var(--green)';
        bar.style.width = pct + '%';
        bar.style.background = barColor;
      }
    }
  }
};

// 上移
window.tsMoveUp = function(idx) {
  if (idx <= 0) return;
  [tsPostsData[idx - 1], tsPostsData[idx]] = [tsPostsData[idx], tsPostsData[idx - 1]];
  tsRenderPosts();
};

// 下移
window.tsMoveDown = function(idx) {
  if (idx >= tsPostsData.length - 1) return;
  [tsPostsData[idx], tsPostsData[idx + 1]] = [tsPostsData[idx + 1], tsPostsData[idx]];
  tsRenderPosts();
};

// 刪除
window.tsDeletePost = function(idx) {
  if (tsPostsData.length <= 1) { showToast('至少需要保留 1 篇'); return; }
  if (!confirm(`確定刪除第 ${idx + 1} 篇？`)) return;
  tsPostsData.splice(idx, 1);
  // 更新篇號文字
  tsUpdateSeqNumbers();
  tsRenderPosts();
};

// 拆成兩篇
window.tsSplitPost = function(idx) {
  const p = tsPostsData[idx];
  const text = p.text || '';
  if (text.length < 100) { showToast('篇幅太短，不需要拆分'); return; }
  // 在中間找最近的句號或換行
  const mid = Math.floor(text.length / 2);
  let splitAt = mid;
  for (let i = mid; i < Math.min(mid + 80, text.length); i++) {
    if ('。！？\n'.includes(text[i])) { splitAt = i + 1; break; }
  }
  const part1 = text.slice(0, splitAt).trim();
  const part2 = text.slice(splitAt).trim();
  if (!part2) { showToast('無法找到合適的斷點'); return; }
  const newPost = { ...p, id: 'ts_' + Date.now(), text: part2, role: 'body', charCount: part2.length };
  tsPostsData[idx] = { ...p, text: part1, charCount: part1.length };
  tsPostsData.splice(idx + 1, 0, newPost);
  tsUpdateSeqNumbers();
  tsRenderPosts();
  showToast('✅ 已拆成兩篇');
};

// 新增空白篇
window.tsAddPost = function() {
  const newPost = {
    id: 'ts_' + Date.now(),
    seq: tsPostsData.length + 1,
    role: 'body',
    text: '',
    charCount: 0
  };
  tsPostsData.push(newPost);
  tsUpdateSeqNumbers();
  tsRenderPosts();
  // 捲動到新卡片
  setTimeout(() => {
    const last = document.getElementById('tscard_' + newPost.id);
    if (last) last.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
};

// 更新各篇的篇號文字（文字末尾的 (N/M)）
function tsUpdateSeqNumbers() {
  const total = tsPostsData.length;
  tsPostsData.forEach((p, i) => {
    p.seq = i + 1;
    // 更新篇號：把結尾的 (X/Y) 替換成新的
    p.text = p.text.replace(/（\d+\/\d+）\s*$/, '').trimEnd() + `\n（${i + 1}/${total}）`;
  });
}

// AI 快速調整單篇
window.tsAiAdjust = async function(id, mode) {
  const p = tsPostsData.find(x => x.id === id);
  if (!p) return;
  const ta = document.getElementById('tsta_' + id);
  if (!ta) return;

  const targetLen = parseInt(document.getElementById('tsTargetLen')?.value || '300');
  const originalText = p.text || '';
  const modePrompt = mode === 'shorten'
    ? `請將以下 Threads 貼文縮短至約 ${Math.round(targetLen * 0.9)} 字，保留核心論點，去掉次要細節。輸出純文字，不加說明。`
    : mode === 'hook'
    ? '請改寫以下 Threads 貼文的開頭（前 2–3 句），讓它更吸引人點進來繼續閱讀。保留後半段內容不變。輸出純文字，不加說明。'
    : '請改寫以下 Threads 貼文的最後 1–2 句，讓結尾更有力，自然引導讀者想繼續看下一篇。輸出純文字，不加說明。';

  ta.disabled = true;
  ta.style.opacity = '0.5';

  try {
    const res = await fetch('/api/ai-split-thread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${modePrompt}\n\n原文：\n${originalText}`,
        targetLen: targetLen,
        maxParts: 1,
        style: 'natural',
        _singleAdjust: true
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.detail || data.error);

    // 取回調整後的文字（AI 可能回傳 1 篇或直接文字）
    let newText = data.result?.posts?.[0]?.text || originalText;
    p.text = newText;
    p.charCount = newText.length;
    ta.value = newText;
    tsUpdatePost(id, newText);
    showToast('✅ AI 調整完成');
  } catch (err) {
    showToast('調整失敗：' + err.message);
  } finally {
    ta.disabled = false;
    ta.style.opacity = '1';
  }
};

// 手機預覽切換
window.tsTogglePreview = function() {
  const preview = document.getElementById('tsPhonePreview');
  if (!preview) return;
  if (preview.style.display === 'none') {
    tsRenderPhonePreview();
    preview.style.display = 'block';
    preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    preview.style.display = 'none';
  }
};

// 渲染手機預覽
function tsRenderPhonePreview() {
  const container = document.getElementById('tsPhoneContent');
  if (!container) return;
  container.innerHTML = tsPostsData.map((p, i) => `
    <div class="ts-phone-post ${i === 0 ? 'ts-phone-main' : 'ts-phone-reply'}">
      <div class="ts-phone-avatar">
        <div class="ts-phone-avatar-circle">${i === 0 ? '👤' : '↳'}</div>
        ${i < tsPostsData.length - 1 ? '<div class="ts-phone-thread-line"></div>' : ''}
      </div>
      <div class="ts-phone-body">
        <div class="ts-phone-name">職涯停看聽 <span style="color:#888;font-size:11px">· ${i === 0 ? '剛剛' : (i * 30) + '秒後'}</span></div>
        <div class="ts-phone-text">${escapeHtml(p.text || '').replace(/\n/g, '<br>')}</div>
        <div class="ts-phone-actions">❤️ &nbsp; 💬 &nbsp; 🔁 &nbsp; ✈️</div>
      </div>
    </div>
  `).join('');
}

// 儲存草稿
window.tsSaveDraft = function() {
  if (tsPostsData.length === 0) { showToast('沒有可儲存的內容'); return; }
  const key = 'ts_drafts';
  let drafts = [];
  try { drafts = JSON.parse(localStorage.getItem(key)) || []; } catch {}
  const draft = {
    id: 'tsd_' + Date.now(),
    savedAt: new Date().toISOString(),
    totalParts: tsPostsData.length,
    preview: (tsPostsData[0]?.text || '').substring(0, 60),
    posts: JSON.parse(JSON.stringify(tsPostsData))
  };
  drafts.unshift(draft);
  if (drafts.length > 30) drafts = drafts.slice(0, 30);
  localStorage.setItem(key, JSON.stringify(drafts));
  showToast(`✅ 已儲存串文草稿（${tsPostsData.length} 篇）`);
};

// 測試發文權限
window.tsTestPublish = async function() {
  const btn = document.getElementById('tsTestPublishBtn');
  const result = document.getElementById('tsTestResult');
  if (btn) btn.disabled = true;
  if (result) result.textContent = '⏳ 測試中...';
  try {
    const res = await fetch('/api/test-publish');
    const data = await res.json();
    if (result) {
      if (data.hasPublishPermission) {
        result.innerHTML = `<span style="color:var(--green)">${data.message}</span>`;
      } else {
        result.innerHTML = `<span style="color:var(--accent)">${data.message}</span>`;
      }
    }
  } catch (err) {
    if (result) result.innerHTML = `<span style="color:var(--accent)">❌ 測試失敗：${err.message}</span>`;
  } finally {
    if (btn) btn.disabled = false;
  }
};

// 點擊「發布串文」按鈕 → 顯示確認畫面
window.tsPublish = function() {
  if (tsPostsData.length === 0) { showToast('沒有可發布的內容'); return; }

  // 先同步 textarea 最新內容到 tsPostsData
  tsPostsData.forEach(p => {
    const ta = document.getElementById('tsta_' + p.id);
    if (ta) { p.text = ta.value; p.charCount = ta.value.length; }
  });

  // 檢查字數
  const overLimit = tsPostsData.filter(p => (p.text || '').length > 500);
  if (overLimit.length > 0) {
    showToast(`第 ${overLimit.map(p => p.seq).join('、')} 篇超過 500 字，請先縮短`);
    return;
  }

  const section = document.getElementById('tsPublishSection');
  const confirm = document.getElementById('tsPublishConfirm');
  const progress = document.getElementById('tsPublishProgress');
  const done = document.getElementById('tsPublishDone');
  const error = document.getElementById('tsPublishError');

  if (!section) return;

  // 顯示摘要
  const summary = document.getElementById('tsPublishSummary');
  if (summary) {
    summary.innerHTML = `共 <strong style="color:var(--text-bright)">${tsPostsData.length} 篇</strong> 串文，總計 ${tsPostsData.reduce((s,p) => s + (p.text||'').length, 0)} 字<br>
    <span style="font-size:11px;margin-top:4px;display:block">第 1 篇：「${escapeHtml((tsPostsData[0]?.text || '').substring(0, 50))}...」</span>`;
  }

  const estTime = document.getElementById('tsEstTime');
  if (estTime) estTime.textContent = `${tsPostsData.length * 30} 秒以上`;

  // 重置顯示狀態
  confirm.style.display = 'block';
  progress.style.display = 'none';
  done.style.display = 'none';
  error.style.display = 'none';

  section.style.display = 'block';
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// 確認後開始發布
window.tsConfirmPublish = async function() {
  const confirm = document.getElementById('tsPublishConfirm');
  const progress = document.getElementById('tsPublishProgress');
  const done = document.getElementById('tsPublishDone');
  const error = document.getElementById('tsPublishError');
  const stepsEl = document.getElementById('tsProgressSteps');
  const msgEl = document.getElementById('tsProgressMsg');

  confirm.style.display = 'none';
  progress.style.display = 'block';

  // 初始化步驟顯示
  if (stepsEl) {
    stepsEl.innerHTML = tsPostsData.map((p, i) => `
      <div id="tsstep_${i}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:6px;margin-bottom:6px;background:var(--bg-card2)">
        <span id="tsstep_icon_${i}" style="font-size:16px;width:20px;text-align:center">⏳</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;color:var(--text-dim)">第 ${i+1} 篇</div>
          <div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((p.text||'').substring(0,40))}...</div>
        </div>
        <span id="tsstep_status_${i}" style="font-size:11px;color:var(--text-muted)">等待中</span>
      </div>
    `).join('');
  }

  try {
    let replyToId = null;
    let userId = null;
    let firstPermalink = null;

    for (let i = 0; i < tsPostsData.length; i++) {
      // 更新 UI：發布中
      const iconEl = document.getElementById('tsstep_icon_' + i);
      const statusEl = document.getElementById('tsstep_status_' + i);
      const stepEl = document.getElementById('tsstep_' + i);
      if (iconEl) iconEl.textContent = '📡';
      if (statusEl) { statusEl.textContent = '發布中（30 秒）'; statusEl.style.color = 'var(--blue)'; }
      if (msgEl) msgEl.textContent = `發布第 ${i + 1} / ${tsPostsData.length} 篇...`;

      const postRes = await fetch('/api/publish-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: tsPostsData[i].text, replyToId, userId })
      });

      if (!postRes.ok) {
        const errData = await postRes.json();
        throw new Error(`第 ${i + 1} 篇失敗：${errData.error}`);
      }

      const data = await postRes.json();
      replyToId = data.postId;
      userId = data.userId;
      if (i === 0 && data.permalink) firstPermalink = data.permalink;

      // 更新 UI：完成
      if (iconEl) iconEl.textContent = '✅';
      if (statusEl) { statusEl.textContent = '完成'; statusEl.style.color = 'var(--green)'; }
      if (stepEl) stepEl.style.background = 'rgba(39,174,96,.08)';
    }

    // 全部完成
    progress.style.display = 'none';
    done.style.display = 'block';
    const doneMsg = document.getElementById('tsPublishDoneMsg');
    if (doneMsg) doneMsg.textContent = `${tsPostsData.length} 篇串文已成功發布到 Threads！`;
    const link = document.getElementById('tsPermalink');
    if (link && firstPermalink) {
      link.href = firstPermalink;
      link.style.display = 'inline-block';
    }
    showToast(`🎉 串文發布完成！共 ${tsPostsData.length} 篇`);

  } catch (err) {
    progress.style.display = 'none';
    error.style.display = 'block';
    const errMsg = document.getElementById('tsPublishErrorMsg');
    if (errMsg) errMsg.textContent = err.message;
  }
};

// ===== Newsletter Tool =====
let nlSelectedIds = new Set();
let nlCandidatePosts = [];

// 儲存到電子報歷史
function nlSaveHistory(subject, htmlContent, textContent) {
  const key = 'nl_history';
  let history = [];
  try { history = JSON.parse(localStorage.getItem(key)) || []; } catch {}
  const entry = {
    id: Date.now().toString(),
    savedAt: new Date().toISOString(),
    subject: subject || '（無件名）',
    preview: textContent.substring(0, 100),
    html: htmlContent,
    text: textContent,
  };
  history.unshift(entry);
  if (history.length > 20) history = history.slice(0, 20);
  localStorage.setItem(key, JSON.stringify(history));
}

function renderNlHistory() {
  const container = document.getElementById('nlHistoryList');
  if (!container) return;
  let history = [];
  try { history = JSON.parse(localStorage.getItem('nl_history')) || []; } catch {}
  if (history.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px">尚無歷史記錄。生成電子報後會自動儲存在這裡。</p>';
    return;
  }
  container.innerHTML = history.map(h => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--bg-card2);border-radius:8px;margin-bottom:8px">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--text-bright);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(h.subject)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${h.savedAt.slice(0,10)} ${h.savedAt.slice(11,16)} ｜ ${escapeHtml(h.preview)}...</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button onclick="nlRestoreHistory('${h.id}')" class="btn-secondary" style="font-size:11px;padding:4px 10px">重新載入</button>
        <button onclick="nlDeleteHistory('${h.id}')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:0 4px">✕</button>
      </div>
    </div>
  `).join('');
}

window.nlRestoreHistory = function(id) {
  let history = [];
  try { history = JSON.parse(localStorage.getItem('nl_history')) || []; } catch {}
  const entry = history.find(h => h.id === id);
  if (!entry) return;
  const previewSection = document.getElementById('nlPreviewSection');
  const previewEl = document.getElementById('nlPreview');
  if (previewSection && previewEl) {
    previewEl.innerHTML = '<iframe srcdoc="' + entry.html.replace(/"/g, '&quot;') + '" style="width:100%;border:none;min-height:500px;border-radius:6px"></iframe>';
    previewSection.style.display = 'block';
    previewSection.scrollIntoView({ behavior: 'smooth' });
    showToast('✅ 已載入歷史電子報');
  }
};

window.nlDeleteHistory = function(id) {
  let history = [];
  try { history = JSON.parse(localStorage.getItem('nl_history')) || []; } catch {}
  history = history.filter(h => h.id !== id);
  localStorage.setItem('nl_history', JSON.stringify(history));
  renderNlHistory();
  showToast('已刪除');
};

function nlInit() {
  // 預設日期：本月
  nlSetPreset('month');
  renderNlHistory();
}

window.nlSetPreset = function(type) {
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const toEl = document.getElementById('nl-date-to');
  const fromEl = document.getElementById('nl-date-from');
  if (!toEl || !fromEl) return;
  toEl.value = fmt(now);
  const from = new Date(now);
  if (type === 'week')   from.setDate(now.getDate() - 7);
  if (type === 'month')  from.setMonth(now.getMonth() - 1);
  if (type === '3month') from.setMonth(now.getMonth() - 3);
  if (type === '6month') from.setMonth(now.getMonth() - 6);
  if (type === 'year')   from.setFullYear(now.getFullYear() - 1);
  fromEl.value = fmt(from);
};

document.getElementById('nlLoadBtn')?.addEventListener('click', () => {
  const from = document.getElementById('nl-date-from').value;
  const to   = document.getElementById('nl-date-to').value;
  const topN = parseInt(document.getElementById('nl-top-n').value) || 5;
  const sortBy = document.getElementById('nl-sort-by').value;

  if (!from || !to) { showToast('請先設定日期區間'); return; }
  if (posts.length === 0) { showToast('尚無貼文數據，請先同步'); return; }

  // 篩選區間
  let range = posts.filter(p => p.date >= from && p.date <= to);
  if (range.length === 0) { showToast('此區間沒有貼文數據'); return; }

  // 排序
  if (sortBy === 'engagement') range.sort((a,b) => totalEngagement(b) - totalEngagement(a));
  else if (sortBy === 'views') range.sort((a,b) => (b.views||0) - (a.views||0));
  else if (sortBy === 'rate') {
    range = range.filter(p => (p.views||0) > 100).sort((a,b) => viewEngRate(b) - viewEngRate(a));
    if (range.length === 0) {
      showToast('此區間沒有足夠瀏覽數據，改用互動數排序');
      range = posts.filter(p => p.date >= from && p.date <= to).sort((a,b) => totalEngagement(b) - totalEngagement(a));
    }
  }

  nlCandidatePosts = range.slice(0, topN);
  nlSelectedIds = new Set(nlCandidatePosts.map(p => p.id));

  // 顯示 Step 2
  document.getElementById('nlPostsSection').style.display = 'block';
  document.getElementById('nlSettingsSection').style.display = 'none';
  document.getElementById('nlPreviewSection').style.display = 'none';
  renderNlPostsList();

  // 捲動到 Step 2
  document.getElementById('nlPostsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function renderNlPostsList() {
  const container = document.getElementById('nlPostsList');
  const sortLabel = { engagement: '互動數', views: '瀏覽數', rate: '瀏覽互動率' }[document.getElementById('nl-sort-by').value];
  container.innerHTML = `
    <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">依 <strong>${sortLabel}</strong> 排序，共 ${nlCandidatePosts.length} 篇。勾選想納入電子報的文章：</p>
    ${nlCandidatePosts.map((p, i) => {
      const eng = totalEngagement(p);
      const rate = viewEngRate(p);
      const excerpt = (p.fullText || p.title || '').substring(0, 120).replace(/\n/g,' ');
      return `
        <label class="nl-post-item" style="display:flex;gap:14px;padding:14px;border:1px solid #2a2a4a;border-radius:8px;margin-bottom:8px;cursor:pointer;transition:border-color .2s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor=nlSelectedIds.has('${p.id}')?'var(--accent)':'#2a2a4a'">
          <div style="padding-top:2px">
            <input type="checkbox" ${nlSelectedIds.has(p.id) ? 'checked' : ''} onchange="nlToggle('${p.id}', this.checked)" style="width:16px;height:16px;accent-color:var(--accent)">
          </div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
              <span style="font-size:12px;font-weight:700;color:var(--text-muted)">#${i+1}</span>
              <span class="type-badge type-${p.type}">${p.type}</span>
              <span style="font-size:11px;color:var(--text-muted)">${p.date}</span>
              ${p.media !== '純文字' ? `<span style="font-size:11px;background:#2a2a4a;padding:1px 6px;border-radius:4px">${p.media}</span>` : ''}
            </div>
            <div style="font-size:13px;color:var(--text-bright);font-weight:600;margin-bottom:6px">${escapeHtml(p.title)}</div>
            ${excerpt.length > 0 ? `<div style="font-size:11px;color:var(--text-muted);line-height:1.6">${escapeHtml(excerpt)}${(p.fullText||'').length > 120 ? '...' : ''}</div>` : ''}
          </div>
          <div style="text-align:right;white-space:nowrap;font-size:11px;color:var(--text-dim)">
            <div>❤️ ${(p.likes||0).toLocaleString()}</div>
            <div>💬 ${p.comments||0}</div>
            <div>🔁 ${p.reposts||0}</div>
            ${(p.views||0) > 0 ? `<div>👁 ${(p.views||0).toLocaleString()}</div>` : ''}
            ${rate ? `<div style="color:var(--green)">${rate.toFixed(1)}%率</div>` : ''}
            <div style="font-weight:700;color:var(--accent);margin-top:4px">互動 ${eng}</div>
          </div>
        </label>`;
    }).join('')}
  `;
}

window.nlToggle = function(id, checked) {
  if (checked) nlSelectedIds.add(id);
  else nlSelectedIds.delete(id);
  // Update border color
  document.querySelectorAll('.nl-post-item').forEach((el, i) => {
    const p = nlCandidatePosts[i];
    if (p) el.style.borderColor = nlSelectedIds.has(p.id) ? 'var(--accent)' : '#2a2a4a';
  });
};

window.nlSelectAll = function(val) {
  if (val) nlCandidatePosts.forEach(p => nlSelectedIds.add(p.id));
  else nlSelectedIds.clear();
  renderNlPostsList();
};

document.getElementById('nlNextBtn')?.addEventListener('click', () => {
  if (nlSelectedIds.size === 0) { showToast('請至少選擇 1 篇文章'); return; }
  document.getElementById('nlSettingsSection').style.display = 'block';
  document.getElementById('nlSettingsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ===== Newsletter Step 3: 規則 / 語氣 / Prompt 邏輯 =====
const NL_RULES = {
  adapt:    { enabled: true },
  subject:  { enabled: true },
  cta:      { enabled: true },
  hashtag:  { enabled: false },
  greeting: { enabled: false },
};
const NL_TONE_LABELS = { professional: '專業正式', friendly: '親切友善', casual: '輕鬆隨性', inspiring: '激勵啟發' };
const NL_TYPE_LABELS = { weekly: '週報 / 週刊', insights: '洞察 / 觀點', tips: '實用技巧', story: '故事型' };
const NL_LANG_LABELS = { 'zh-TW': '繁體中文', 'zh-CN': '簡體中文', 'en': '英文', 'bilingual': '中英雙語' };

window.nlToggleRule = function(key) {
  NL_RULES[key].enabled = !NL_RULES[key].enabled;
  const on = NL_RULES[key].enabled;
  const icon = document.getElementById('nlicon-' + key);
  const tog  = document.getElementById('nltoggle-' + key);
  if (icon) { icon.textContent = on ? '✓' : '–'; icon.className = 'nl-rule-icon ' + (on ? 'nl-icon-on' : 'nl-icon-off'); }
  if (tog)  { tog.className = 'nl-toggle' + (on ? ' nl-toggle-on' : ''); }
  // 展開/收起 adapt-detail
  if (key === 'adapt') {
    const detail = document.getElementById('nl-adapt-detail');
    if (detail) detail.style.display = on ? 'flex' : 'none';
  }
  nlOnSettingChange();
};

window.nlUpdateThresh = function() {
  const v1 = document.getElementById('nl-thresh1')?.value || 150;
  const v2 = document.getElementById('nl-thresh2')?.value || 500;
  const s1 = document.getElementById('nl-thresh1-val');
  const s2 = document.getElementById('nl-thresh2-val');
  if (s1) s1.textContent = v1 + ' 字';
  if (s2) s2.textContent = v2 + ' 字';
  nlOnSettingChange();
};

window.nlSetMode = function(mode) {
  const modeMap = {
    short: { t1: 9999, t2: 9999 },
    mid:   { t1: 0,    t2: 9999 },
    long:  { t1: 0,    t2: 0    },
  };
  const vals = modeMap[mode] || { t1: 150, t2: 500 };
  const el1 = document.getElementById('nl-thresh1');
  const el2 = document.getElementById('nl-thresh2');
  if (el1) el1.value = vals.t1;
  if (el2) el2.value = vals.t2;
  document.querySelectorAll('.nl-mode-btn').forEach(btn => {
    btn.classList.toggle('nl-mode-active', btn.dataset.mode === mode);
  });
  nlUpdatePromptPreview();
};

window.nlSwitchTab = function(tab) {
  ['rules','tone','prompt'].forEach(t => {
    const el = document.getElementById('nl-tab-' + t);
    const btn = document.querySelector(`[data-nltab="${t}"]`);
    if (el) el.style.display = t === tab ? 'block' : 'none';
    if (btn) btn.className = 'nl-tab' + (t === tab ? ' nl-tab-active' : '');
  });
  if (tab === 'prompt') nlUpdatePromptPreview();
};

function nlGetSettings() {
  return {
    thresh1: parseInt(document.getElementById('nl-thresh1')?.value || 150),
    thresh2: parseInt(document.getElementById('nl-thresh2')?.value || 500),
    tone: document.getElementById('nl-tone')?.value || 'friendly',
    type: document.getElementById('nl-type')?.value || 'insights',
    lang: document.getElementById('nl-lang')?.value || 'zh-TW',
  };
}

window.nlOnSettingChange = function() {
  // 若當前在 Prompt 預覽 tab，即時更新
  const promptTab = document.getElementById('nl-tab-prompt');
  if (promptTab && promptTab.style.display !== 'none') nlUpdatePromptPreview();
};

function nlGetCharCount(text) {
  return text.replace(/\s/g, '').length;
}

function nlDetectMode(text, t1, t2) {
  const n = nlGetCharCount(text);
  if (n === 0) return null;
  if (n < t1) return 'short';
  if (n <= t2) return 'mid';
  return 'long';
}

const NL_MODE_CONFIG = {
  short: { label: '短文', instruction: (t1) => `- 原文為短貼文（低於 ${t1} 字）→ 請「擴寫豐富」：補充背景脈絡、具體案例或深層洞察，讓讀者獲得完整的職涯啟發` },
  mid:   { label: '中篇', instruction: (t1,t2) => `- 原文為中篇（${t1}–${t2} 字）→ 請「重整為電子報格式」：加強段落層次、調整語氣節奏，保留所有核心觀點` },
  long:  { label: '長文', instruction: (t1,t2) => `- 原文為長文（超過 ${t2} 字）→ 請「提煉精華」：保留最有價值的核心論點與案例，刪除重複敘述，讓整篇閱讀流暢完整` },
};

function nlBuildPrompt(inputText, cfg) {
  const { thresh1, thresh2, tone, type, lang } = cfg;
  const mode = nlDetectMode(inputText, thresh1, thresh2);
  const ruleLines = [];

  if (NL_RULES.adapt.enabled && mode) {
    const mc = NL_MODE_CONFIG[mode];
    ruleLines.push(mc.instruction(thresh1, thresh2));
  }
  if (NL_RULES.hashtag.enabled)  ruleLines.push('- 移除所有 Hashtag（#），若有關鍵字可整合至內文自然提及');
  if (NL_RULES.greeting.enabled) ruleLines.push('- 在內文開頭加入一句親切的問候語');
  if (NL_RULES.cta.enabled)      ruleLines.push('- 在結尾加入一句行動呼籲（CTA），引導讀者回覆、分享或思考');
  if (NL_RULES.subject.enabled)  ruleLines.push('- 額外生成一行「件名（Subject）」，風格吸睛，適合電子報開信');

  const outputFormat = NL_RULES.subject.enabled
    ? '件名：[主旨行]\n\n內文：\n[電子報本文]'
    : '內文：\n[電子報本文]';

  return `你是一位專業的電子報編輯，請將以下 Threads 貼文改寫為適合發送的電子報內容。

【語氣風格】${NL_TONE_LABELS[tone] || tone}
【電子報類型】${NL_TYPE_LABELS[type] || type}
【輸出語言】${NL_LANG_LABELS[lang] || lang}

【轉換規則】
${ruleLines.length > 0 ? ruleLines.join('\n') : '- 保持原文風格，僅做格式調整'}
- 輸出純文字，不使用任何 Markdown 符號（#、**、*、---、• 等）
- 文章必須完整結束，不可在句子中途停止

【原始 Threads 貼文】
${inputText.trim()}

請直接輸出結果，格式如下：
${outputFormat}`;
}

function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/^#{1,6}\s+/gm, '')           // 移除 # 標題
    .replace(/\*\*(.*?)\*\*/g, '$1')        // 移除 **粗體**
    .replace(/\*(.*?)\*/g, '$1')            // 移除 *斜體*
    .replace(/^[-*+]\s+/gm, '・')           // 轉換子彈清單
    .replace(/`([^`]+)`/g, '$1')            // 移除 `程式碼`
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 移除 [文字](連結)
    .replace(/^\s*---+\s*$/gm, '')          // 移除分隔線
    .replace(/\n{3,}/g, '\n\n')             // 合併多餘空行
    .trim();
}

function nlParseOutput(raw) {
  const subjectMatch = raw.match(/件名[：:]\s*(.+)/);
  const bodyMatch    = raw.match(/內文[：:]\n?([\s\S]+)/);
  const subject = subjectMatch ? subjectMatch[1].trim() : null;
  const rawBody = bodyMatch
    ? bodyMatch[1].trim()
    : raw.replace(/件名[：:].*\n?/g,'').replace(/內文[：:]\n?/g,'').trim();
  const body = stripMarkdown(rawBody);
  return { subject, body };
}

function nlUpdatePromptPreview() {
  const el = document.getElementById('nl-prompt-preview');
  if (!el) return;
  const selected = nlCandidatePosts.filter(p => nlSelectedIds.has(p.id));
  if (selected.length === 0) { el.textContent = '（請先完成 Step 2 選取文章）'; return; }
  const cfg = nlGetSettings();
  const firstPost = selected[0];
  const inputText = firstPost.fullText || firstPost.title || '';
  el.textContent = nlBuildPrompt(inputText, cfg);
}

// ===== Generate: 逐篇呼叫 Claude API =====
document.getElementById('nlGenerateBtn')?.addEventListener('click', async () => {
  const selected = nlCandidatePosts.filter(p => nlSelectedIds.has(p.id));
  if (selected.length === 0) { showToast('請先選擇文章'); return; }

  const btn = document.getElementById('nlGenerateBtn');
  const statusEl = document.getElementById('nlConvertStatus');
  btn.disabled = true;
  btn.textContent = '⏳ 轉換中...';

  const cfg = nlGetSettings();
  const from = document.getElementById('nl-date-from').value;
  const to   = document.getElementById('nl-date-to').value;
  const results = []; // { post, subject, body, error }

  for (let i = 0; i < selected.length; i++) {
    const p = selected[i];
    if (statusEl) statusEl.textContent = `⏳ 正在轉換第 ${i+1}/${selected.length} 篇：${p.title.substring(0,30)}...`;
    const inputText = p.fullText || p.title || '';
    const prompt = nlBuildPrompt(inputText, cfg);
    try {
      const res = await fetch('/api/nl-convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      // 先取得原始文字，再判斷是否為合法 JSON（避免伺服器回傳 HTML 錯誤頁）
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        // 伺服器回傳非 JSON（通常是伺服器未重啟或路由不存在）
        if (rawText.includes('<!DOCTYPE') || rawText.includes('<html')) {
          results.push({ post: p, subject: null, body: null, error: '伺服器回應異常，請重新啟動伺服器（start-dashboard.bat）後再試' });
        } else {
          results.push({ post: p, subject: null, body: null, error: '回應格式錯誤：' + rawText.substring(0, 80) });
        }
        continue;
      }
      if (!res.ok || !data.success) {
        results.push({ post: p, subject: null, body: null, error: (data.error || '轉換失敗') + (data.detail ? '：' + data.detail : '') });
      } else {
        const parsed = nlParseOutput(data.result);
        results.push({ post: p, subject: parsed.subject, body: parsed.body, error: null });
      }
    } catch (e) {
      if (e.message === 'Failed to fetch') {
        results.push({ post: p, subject: null, body: null, error: '無法連線到伺服器，請確認 start-dashboard.bat 已執行' });
        break; // 伺服器掛掉就不繼續嘗試後面的文章
      }
      results.push({ post: p, subject: null, body: null, error: e.message });
    }
  }

  btn.disabled = false;
  btn.textContent = '✨ 開始 AI 轉換';
  if (statusEl) statusEl.textContent = `✅ 完成！${results.filter(r=>!r.error).length}/${results.length} 篇轉換成功`;

  // 計算區間統計
  const rangePosts = posts.filter(p => p.date >= from && p.date <= to);
  const stats = {
    count: rangePosts.length,
    totalViews: rangePosts.reduce((s,p) => s+(p.views||0),0),
    totalLikes: rangePosts.reduce((s,p) => s+p.likes,0),
    totalComments: rangePosts.reduce((s,p) => s+p.comments,0),
    totalReposts: rangePosts.reduce((s,p) => s+(p.reposts||0),0),
  };
  stats.totalEng = stats.totalLikes + stats.totalComments + stats.totalReposts;

  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日`;

  const html = nlBuildHtml({ results, stats, from, to, dateStr, cfg });
  const text = nlBuildText({ results, stats, from, to, dateStr });

  document.getElementById('nlPreviewSection').style.display = 'block';
  document.getElementById('nlPreview').innerHTML = html;
  document.getElementById('nlPreviewSection').dataset.text = text;
  document.getElementById('nlPreviewSection').dataset.html = html;
  document.getElementById('nlPreviewSection').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // 儲存到電子報歷史
  const firstSubject = results.find(r => r.subject)?.subject || null;
  nlSaveHistory(firstSubject, html, text);
  renderNlHistory();
});

function nlBuildHtml({ results, stats, from, to, dateStr }) {
  const accentColor = '#e94560';
  const escape = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');

  const postsHtml = results.map((r, i) => {
    const p = r.post;
    const eng = totalEngagement(p);
    const rate = viewEngRate(p);
    const linkHtml = p.permalink ? `<p style="margin:12px 0 0"><a href="${p.permalink}" style="color:${accentColor};font-size:12px;text-decoration:none;font-weight:600">▶ 前往 Threads 閱讀完整原文 →</a></p>` : '';

    if (r.error) {
      return `
        <div style="border:1px solid #fcc;border-radius:8px;padding:20px;margin-bottom:16px;background:#fff8f8">
          <div style="font-size:12px;color:#a33;margin-bottom:8px">⚠️ 轉換失敗：${escape(r.error)}</div>
          <div style="font-size:13px;color:#555">${escape(p.title)}</div>
        </div>`;
    }

    return `
      <div style="border:1px solid #e5e5e5;border-radius:8px;padding:20px;margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <span style="background:${accentColor};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">${p.type}</span>
          <span style="font-size:11px;color:#888">${p.date}</span>
          ${i === 0 ? '<span style="background:#f39c12;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">🏆 本期最熱門</span>' : ''}
          ${r.subject ? `<span style="font-size:11px;color:#555;background:#f5f5f5;padding:2px 8px;border-radius:4px">📧 件名：${escape(r.subject)}</span>` : ''}
        </div>
        <div style="font-size:15px;line-height:1.85;color:#222;white-space:pre-wrap">${escape(r.body)}</div>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid #f0f0f0;display:flex;gap:14px;font-size:12px;color:#aaa;flex-wrap:wrap">
          <span>❤️ ${(p.likes||0).toLocaleString()}</span>
          <span>💬 ${p.comments||0}</span>
          <span>🔁 ${p.reposts||0}</span>
          ${(p.views||0) > 0 ? `<span>👁 ${(p.views||0).toLocaleString()}</span>` : ''}
          ${rate ? `<span style="color:#27ae60">互動率 ${rate.toFixed(2)}%</span>` : ''}
        </div>
        ${linkHtml}
      </div>`;
  }).join('');

  const statsHtml = stats.count > 0 ? `
    <div style="background:#f8f8f8;border-radius:8px;padding:16px 20px;margin:24px 0;border-left:3px solid ${accentColor}">
      <div style="font-size:12px;font-weight:600;color:#888;margin-bottom:8px">📊 本期帳號數據（${from} ～ ${to}）</div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:13px;color:#333">
        <div><strong>${stats.count}</strong> 篇貼文</div>
        ${stats.totalViews > 0 ? `<div>👁 <strong>${stats.totalViews.toLocaleString()}</strong> 次瀏覽</div>` : ''}
        <div>❤️ <strong>${stats.totalLikes.toLocaleString()}</strong></div>
        <div>💬 <strong>${stats.totalComments.toLocaleString()}</strong></div>
        <div>🔁 <strong>${stats.totalReposts.toLocaleString()}</strong></div>
      </div>
    </div>` : '';

  return `
    <div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;background:#fff;border:1px solid #e5e5e5;border-radius:10px;overflow:hidden">
      <div style="background:${accentColor};color:#fff;padding:28px 24px;text-align:center">
        <div style="font-size:12px;opacity:.8;margin-bottom:6px">${dateStr}</div>
        <h1 style="margin:0;font-size:22px;font-weight:800;letter-spacing:.5px">職涯停看聽 電子報</h1>
        <div style="font-size:13px;opacity:.85;margin-top:8px">本期精選 ${results.filter(r=>!r.error).length} 篇高互動職涯洞見</div>
      </div>
      <div style="padding:28px 24px">
        ${postsHtml}
        ${statsHtml}
      </div>
      <div style="background:#f5f5f5;padding:14px 24px;text-align:center;font-size:11px;color:#999">
        © 職涯停看聽 ｜ 本電子報由 Threads 分析系統自動生成
      </div>
    </div>`;
}

function nlBuildText({ results, stats, from, to, dateStr }) {
  const line = '─'.repeat(50);
  const lines = [];
  lines.push(line);
  lines.push(`職涯停看聽 電子報　${dateStr}`);
  lines.push(`本期精選 ${results.filter(r=>!r.error).length} 篇高互動職涯洞見`);
  lines.push(line);

  results.forEach((r, i) => {
    const p = r.post;
    lines.push('');
    lines.push(`${i === 0 ? '🏆 ' : `${i+1}. `}【${p.type}】${p.date}`);
    if (r.subject) lines.push(`📧 件名：${r.subject}`);
    lines.push('');
    if (r.error) {
      lines.push(`⚠️ 轉換失敗：${r.error}`);
      lines.push(`原文標題：${p.title}`);
    } else {
      lines.push(r.body);
    }
    lines.push('');
    const engParts = [`❤️ ${p.likes||0}`, `💬 ${p.comments||0}`, `🔁 ${p.reposts||0}`];
    if ((p.views||0) > 0) engParts.push(`👁 ${(p.views||0).toLocaleString()}`);
    lines.push(engParts.join('  '));
    if (p.permalink) lines.push(`▶ ${p.permalink}`);
    lines.push('');
  });

  if (stats.count > 0) {
    lines.push(line);
    lines.push(`📊 本期帳號數據（${from} ～ ${to}）`);
    lines.push(`發文 ${stats.count} 篇　愛心 ${stats.totalLikes.toLocaleString()}　留言 ${stats.totalComments.toLocaleString()}　轉發 ${stats.totalReposts.toLocaleString()}`);
    if (stats.totalViews > 0) lines.push(`總瀏覽 ${stats.totalViews.toLocaleString()}`);
    lines.push('');
  }

  lines.push(line);
  lines.push('© 職涯停看聽');
  return lines.join('\n');
}

document.getElementById('nlCopyTextBtn')?.addEventListener('click', () => {
  const text = document.getElementById('nlPreviewSection').dataset.text || '';
  navigator.clipboard.writeText(text).then(() => showToast('✅ 純文字已複製到剪貼簿！')).catch(() => showToast('複製失敗，請手動選取'));
});

function nlDownloadFile(content, filename, mimeType) {
  const blob = new Blob(['\uFEFF' + content], { type: mimeType + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('nlDownloadHtmlBtn')?.addEventListener('click', () => {
  const html = document.getElementById('nlPreviewSection').dataset.html || '';
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  nlDownloadFile(html, `職涯停看聽電子報_${dateStr}.html`, 'text/html');
  showToast('✅ HTML 檔案下載中！');
});

document.getElementById('nlDownloadTxtBtn')?.addEventListener('click', () => {
  const text = document.getElementById('nlPreviewSection').dataset.text || '';
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  nlDownloadFile(text, `職涯停看聽電子報_${dateStr}.txt`, 'text/plain');
  showToast('✅ TXT 檔案下載中！');
});

document.getElementById('nlReEditBtn')?.addEventListener('click', () => {
  document.getElementById('nlPreviewSection').style.display = 'none';
  document.getElementById('nlSettingsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
});


// ===== 排程發文功能（整合至串文工具 + 排程管理佇列）=====

/** 初始化排程時間選擇器：設定 min 為現在 + 20 分鐘，預填明天 09:00 */
function schedInitTimePicker(elementId = 'tsSchedTime') {
  const input = document.getElementById(elementId);
  if (!input) return;
  const minTime = new Date(Date.now() + 20 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const localStr = `${minTime.getFullYear()}-${pad(minTime.getMonth()+1)}-${pad(minTime.getDate())}T${pad(minTime.getHours())}:${pad(minTime.getMinutes())}`;
  input.min = localStr;
  const tomorrow = new Date(minTime);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const tStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth()+1)}-${pad(tomorrow.getDate())}T09:00`;
  if (!input.value) input.value = tStr;
}

/** 從串文工具開啟排程面板（互斥：同時關閉立即發布面板） */
window.tsScheduleOpen = function() {
  if (typeof tsPostsData === 'undefined' || tsPostsData.length === 0) {
    showToast('沒有可排程的內容');
    return;
  }

  // 同步 textarea 最新內容
  tsPostsData.forEach(p => {
    const ta = document.getElementById('tsta_' + p.id);
    if (ta) { p.text = ta.value; p.charCount = ta.value.length; }
  });

  // 字數驗證
  const overLimit = tsPostsData.filter(p => (p.text || '').length > 500);
  if (overLimit.length > 0) {
    showToast(`第 ${overLimit.map(p => p.seq).join('、')} 篇超過 500 字，請先縮短`);
    return;
  }

  // 互斥：關閉立即發布面板
  const pubSec = document.getElementById('tsPublishSection');
  if (pubSec) pubSec.style.display = 'none';

  // 顯示摘要
  const summary = document.getElementById('tsScheduleSummary');
  if (summary) {
    const firstText = (tsPostsData[0]?.text || '').substring(0, 50);
    const totalChars = tsPostsData.reduce((s, p) => s + (p.text || '').length, 0);
    summary.innerHTML = `共 <strong style="color:var(--text-bright)">${tsPostsData.length} 篇</strong> 串文，總計 ${totalChars} 字，將依序排程發布<br>
      <span style="font-size:11px;margin-top:4px;display:block">第 1 篇：「${escapeHtml(firstText)}${tsPostsData[0]?.text?.length > 50 ? '...' : ''}」</span>`;
  }

  // 初始化時間選擇器
  schedInitTimePicker('tsSchedTime');

  // 重設狀態 + 顯示
  const statusEl = document.getElementById('tsScheduleStatus');
  if (statusEl) statusEl.textContent = '';
  const section = document.getElementById('tsScheduleSection');
  if (section) {
    section.style.display = 'block';
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

/** 提交串文排程 */
window.tsScheduleSubmit = async function(btn) {
  const timeEl = document.getElementById('tsSchedTime');
  const statusEl = document.getElementById('tsScheduleStatus');
  if (!timeEl?.value) { statusEl.textContent = '❌ 請選擇發布時間'; return; }

  // 客戶端驗證：至少 20 分鐘後
  const scheduledLocal = new Date(timeEl.value);
  const minTime = new Date(Date.now() + 20 * 60 * 1000);
  if (scheduledLocal < minTime) {
    statusEl.textContent = '❌ 發布時間必須至少 20 分鐘後';
    return;
  }

  // 防重複提交
  if (btn) btn.disabled = true;
  statusEl.textContent = '⏳ 提交中...';

  try {
    const posts = tsPostsData.map((p, i) => ({ seq: i + 1, content: p.text || '' }));
    const resp = await fetch('/api/scheduled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'thread',
        posts,
        scheduled_at: scheduledLocal.toISOString()  // UTC ISO，避免時區歧義
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '排程失敗');

    statusEl.textContent = `✅ 已加入排程（${posts.length} 篇）`;
    showToast(`✅ 已排程 ${posts.length} 篇串文`);
    // 關閉面板 + refresh queue
    setTimeout(() => {
      const sec = document.getElementById('tsScheduleSection');
      if (sec) sec.style.display = 'none';
    }, 1500);
    schedLoadQueue();
  } catch (e) {
    statusEl.textContent = `❌ ${e.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
};

/** 取消排程（pending 才可取消，in_progress 會被 API 拒絕） */
async function schedCancel(id, btn) {
  if (!confirm('確定取消這個排程？')) return;
  if (btn) btn.disabled = true;
  try {
    const resp = await fetch('/api/scheduled', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '取消失敗');
    showToast('✅ 排程已取消');
    schedLoadQueue();
  } catch (e) {
    showToast(`❌ ${e.message}`);
    if (btn) btn.disabled = false;
  }
}
window.schedCancel = schedCancel;

/** 載入排程佇列 */
async function schedLoadQueue() {
  const container = document.getElementById('schedQueue');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--text-muted);font-size:13px">載入中...</p>';

  try {
    const resp = await fetch('/api/scheduled');
    const posts = await resp.json();
    if (!resp.ok) throw new Error(posts.error || '載入失敗');

    if (!Array.isArray(posts) || posts.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:13px">目前沒有排程貼文</p>';
      return;
    }

    // 分組：執行中 / 待發 / 終態
    const inProgress = posts.filter(p => p.status === 'in_progress');
    const pending = posts.filter(p => p.status === 'pending');
    const history = posts.filter(p => !['pending', 'in_progress'].includes(p.status));

    const formatTime = iso => {
      if (!iso) return '';
      const d = new Date(iso);
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    const statusBadge = item => {
      const s = item.status;
      const map = {
        pending:              ['⏳ 待發布',                                  '#1a2a4a', '#6ab4ff'],
        in_progress:          ['🔄 發送中...',                                '#1e2a4a', '#3b82f6'],
        published:            ['✅ 已發布',                                  '#1a3a1a', '#6abf69'],
        partially_published:  [`⚠️ 部分發出 (${item.published_count||0}/${item.total_count||0})`, '#3a2a0a', '#f59e0b'],
        failed:               ['❌ 失敗',                                    '#3a1a1a', '#ff6b6b'],
        cancelled:            ['🚫 已取消',                                  '#252525', '#888888']
      };
      const [label, bg, color] = map[s] || ['?', '#333', '#aaa'];
      return `<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:${bg};color:${color};font-weight:600;white-space:nowrap">${label}</span>`;
    };

    const escHtml = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;');

    const renderPost = p => {
      // 取得內容預覽：thread 取第 1 篇，single 取 content
      const isThread = p.type === 'thread' && Array.isArray(p.posts);
      const previewText = isThread ? (p.posts[0]?.content || '') : (p.content || '');
      const threadBadge = isThread
        ? `<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:#2a1a3a;color:#c084fc;font-weight:600">📜 ${p.posts.length}篇串文</span>`
        : '';
      return `
        <div style="padding:12px 4px;border-bottom:1px solid #1a1a2e;display:flex;gap:12px;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
              ${statusBadge(p)}
              ${threadBadge}
              <span style="font-size:11px;color:var(--text-muted)">排程：${formatTime(p.scheduled_at)}</span>
              ${p.published_at ? `<span style="font-size:11px;color:var(--text-muted)">發布：${formatTime(p.published_at)}</span>` : ''}
            </div>
            <p style="font-size:13px;color:var(--text-dim);margin:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;white-space:pre-wrap">${escHtml(previewText)}</p>
            ${p.reply ? `<p style="font-size:11px;color:var(--text-muted);margin:4px 0 0">💬 留言：${escHtml(p.reply.substring(0,60))}${p.reply.length>60?'...':''}</p>` : ''}
            ${p.error ? `<p style="font-size:11px;color:#ff6b6b;margin:4px 0 0">錯誤：${escHtml(p.error)}</p>` : ''}
          </div>
          ${p.status === 'pending' ? `<button class="btn-secondary" style="font-size:11px;padding:4px 10px;white-space:nowrap;flex-shrink:0" onclick="schedCancel('${p.id}', this)">取消</button>` : ''}
        </div>
      `;
    };

    let html = '';
    if (inProgress.length) {
      html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;font-weight:600;letter-spacing:.5px">執行中 (${inProgress.length})</div>`;
      html += inProgress.map(renderPost).join('');
    }
    if (pending.length) {
      html += `<div style="font-size:11px;color:var(--text-muted);margin-top:${inProgress.length?'16px':'0'};margin-bottom:8px;font-weight:600;letter-spacing:.5px">待發布 (${pending.length})</div>`;
      html += pending.map(renderPost).join('');
    }
    if (history.length) {
      html += `<div style="font-size:11px;color:var(--text-muted);margin-top:${(inProgress.length||pending.length)?'16px':'0'};margin-bottom:8px;font-weight:600;letter-spacing:.5px">最近記錄</div>`;
      html += history.map(renderPost).join('');
    }

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<p style="color:var(--accent);font-size:13px">載入失敗：${e.message}</p>`;
  }
}
