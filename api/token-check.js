module.exports = (req, res) => {
  const token = process.env.THREADS_ACCESS_TOKEN;
  res.json({ ok: !!(token && token.length > 10), hint: token ? '已設定' : '未設定' });
};
