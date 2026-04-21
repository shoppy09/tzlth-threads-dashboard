const https = require('https');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, targetLen = 300, maxParts = 5, style = 'hook', authorTone = '' } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text 參數必填' });
  if (text.length > 6000) return res.status(400).json({ error: '輸入文章過長（上限 6000 字）' });

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_AI_API_KEY 尚未設定' });

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
      const req2 = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, r => {
        const chunks = [];
        r.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        r.on('end', () => {
          try { resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) }); }
          catch { reject(new Error('API response parse error')); }
        });
      });
      req2.on('error', reject);
      req2.write(postData);
      req2.end();
    });

    if (apiRes.status !== 200) throw new Error(apiRes.body?.error?.message || `HTTP ${apiRes.status}`);

    let rawText = apiRes.body.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) throw new Error('AI 未返回任何文字');

    // 清除可能的 markdown code block 包裝
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('AI 回傳格式無法解析，請重試');
    }

    if (!parsed.posts || !Array.isArray(parsed.posts)) throw new Error('AI 回傳結構異常');
    parsed.posts = parsed.posts.map(p => ({ ...p, charCount: (p.text || '').length }));
    res.json({ success: true, result: parsed });

  } catch (err) {
    res.status(500).json({ error: '切割失敗', detail: err.message });
  }
};
