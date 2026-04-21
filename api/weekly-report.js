const https = require('https');

module.exports = async (req, res) => {
  try {
    const headers = { 'User-Agent': 'tzlth-dashboard' };
    const pat = process.env.GITHUB_PAT;
    if (pat) headers['Authorization'] = `token ${pat}`;
    const data = await new Promise((resolve, reject) => {
      https.get(
        'https://raw.githubusercontent.com/shoppy09/tzlth-threads-dashboard/master/threads-data.json',
        { headers },
        r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))); }
      ).on('error', reject);
    });

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);

    const thisWeek = data.posts.filter(p => new Date(p.date) >= weekAgo);
    const lastWeek = data.posts.filter(p => {
      const d = new Date(p.date);
      return d >= twoWeeksAgo && d < weekAgo;
    });

    const calcStats = (arr) => ({
      count: arr.length,
      totalLikes: arr.reduce((s, p) => s + (p.likes || 0), 0),
      totalComments: arr.reduce((s, p) => s + (p.comments || 0), 0),
      totalReposts: arr.reduce((s, p) => s + (p.reposts || 0), 0),
      totalViews: arr.reduce((s, p) => s + (p.views || 0), 0),
      totalEngagement: arr.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0) + (p.reposts || 0) + (p.shares || 0), 0),
      topPost: [...arr].sort((a, b) =>
        ((b.likes || 0) + (b.comments || 0) + (b.reposts || 0)) -
        ((a.likes || 0) + (a.comments || 0) + (a.reposts || 0))
      )[0] || null,
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
};
