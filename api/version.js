// 公開端點：回報「目前服務的是哪一次部署」（2026-09-28 HQ tasks「其餘部署面 repo 無法自報正在服務的是哪一次部署」）
// WHY：本專案 auto-deploy 停用、走 `npx vercel --prod`，而 CLI 部署的是**工作樹**不是 commit ⇒
//   「我剛部署的是不是我以為的那一版」更需要機器可讀的答案。
// commit 取自 Vercel 系統變數；CLI 部署若未帶 git metadata 則為 null，此時看 deployment（一定有）。
// 揭露邊界比照儀表板／財務同名端點：commit 7 碼（本 repo 為 public）、node 大版本、region。
// ⛔ 不得在此加入 env、token 狀態或任何貼文數據。放行清單見 middleware.js PUBLIC_API（精確比對）。
module.exports = (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    deployment: process.env.VERCEL_DEPLOYMENT_ID || null,
    node: process.version.split('.')[0],
    region: process.env.VERCEL_REGION || null,
  });
};
