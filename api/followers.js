const { getPublicJson } = require('../lib/public-raw');

module.exports = async (req, res) => {
  try {
    // 公開檔不帶 token、看狀態碼、不會掛住（2026-10-28，見 lib/public-raw.js）
    const data = await getPublicJson('follower-history.json');
    res.json(data);   // 返回 array，格式與原 /api/followers 相同
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
