module.exports = (req, res) => {
  res.json({
    exists: true,
    lines: [
      '[GitHub Actions] 資料由 cron.yml 每日 10:00 / 22:00（台灣時間）自動更新',
      '[提示] 最新執行記錄請前往：github.com/shoppy09/tzlth-threads-dashboard/actions'
    ],
    lastSuccess: '自動更新已啟用（GitHub Actions cron）',
    lastFail: null
  });
};
