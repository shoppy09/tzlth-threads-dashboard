module.exports = (req, res) => {
  res.json({
    exists: true,
    lines: [
      '[GitHub Actions] 資料由 tzlth-hq fetch-threads.yml 每日 09:00 / 21:00（台灣時間）自動更新',
      '[提示] 最新執行記錄請前往：github.com/shoppy09/tzlth-hq/actions/workflows/fetch-threads.yml'
    ],
    lastSuccess: '自動更新已啟用（tzlth-hq canonical cron）',
    lastFail: null
  });
};
