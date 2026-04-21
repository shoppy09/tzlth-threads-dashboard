const https = require('https');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: '缺少 prompt' });
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_AI_API_KEY 未設定' });

  try {
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    });
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const req2 = https.request(options, r => {
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
      });
      req2.on('error', reject);
      req2.write(payload);
      req2.end();
    });

    const text = result.body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(500).json({ error: 'Gemini 無回應' });
    res.json({ success: true, result: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
