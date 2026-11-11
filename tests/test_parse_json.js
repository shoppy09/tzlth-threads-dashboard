// 上游回應解析防護測試（2026-11-11，HQ tasks L174）。用法：node --test tests/test_parse_json.js
// 假 https：壞回應（HTML 錯誤頁、空白、截斷）時，新版要在 1 秒內回 502 並帶 message；
// 舊版（git HEAD~ 的寫法）放在子程序重現：例外丟在回呼裡＝未處理例外、回應一直沒送出（附錄二回測）。
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { parseUpstream, settleJson, errorStatus } = require('../lib/parse-json');

const ROOT = path.join(__dirname, '..');
const BAD = {
  'HTML 錯誤頁': '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>',
  '空白': '',
  '截斷的 JSON': '{"candidates":[{"content":',
};

function fakeResponse(status, body) {
  const r = new EventEmitter();
  r.statusCode = status;
  setImmediate(() => { r.emit('data', body); r.emit('end'); });
  return r;
}

function stubHttps(status, body) {
  const orig = { get: https.get, request: https.request };
  https.get = (url, cb) => { cb(fakeResponse(status, body)); const e = new EventEmitter(); return e; };
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => cb(fakeResponse(status, body));
    return req;
  };
  return () => { https.get = orig.get; https.request = orig.request; };
}

function fakeRes() {
  const out = { code: null, body: null };
  const res = { status(c) { out.code = c; return res; }, json(b) { out.body = b; if (out.code === null) out.code = 200; return res; } };
  return { res, out };
}

function callWithin(handler, req, ms = 1000) {
  const { res, out } = fakeRes();
  return Promise.race([
    handler(req, res).then(() => out),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${ms}ms 內沒有回應`)), ms)),
  ]);
}

test('parseUpstream：正常 JSON 照常解析', () => {
  assert.deepStrictEqual(parseUpstream('{"a":1}', 'x', 200), { a: 1 });
});

for (const [name, body] of Object.entries(BAD)) {
  test(`parseUpstream：${name} → 丟出 upstream 錯誤、errorStatus 502`, () => {
    assert.throws(() => parseUpstream(body, 'X', 502), e => e.upstream === true && errorStatus(e) === 502 && /X 回應不是合法 JSON/.test(e.message));
  });
}

test('settleJson：失敗走 reject，不留在回呼', async () => {
  await assert.rejects(new Promise((res, rej) => settleJson(res, rej, '<html>', 'X', 500)), e => e.upstream === true);
  assert.deepStrictEqual(await new Promise((res, rej) => settleJson(res, rej, '{"ok":true}', 'X', 200)), { ok: true });
});

test('errorStatus：一般錯誤 → 500', () => {
  assert.strictEqual(errorStatus(new Error('x')), 500);
});

for (const [name, body] of Object.entries(BAD)) {
  test(`nl-convert：Gemini 回${name} → 1 秒內 502＋message`, async () => {
    process.env.GOOGLE_AI_API_KEY = 'test-key';
    const restore = stubHttps(502, body);
    try {
      const h = require('../api/nl-convert');
      const out = await callWithin(h, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { prompt: 'p' } });
      assert.strictEqual(out.code, 502);
      assert.match(out.body.message, /Gemini 回應不是合法 JSON/);
    } finally { restore(); }
  });

  test(`test-publish：Threads 回${name} → 1 秒內 502＋message`, async () => {
    process.env.THREADS_ACCESS_TOKEN = 'test-token';
    const restore = stubHttps(500, body);
    try {
      const h = require('../api/test-publish');
      const out = await callWithin(h, { method: 'GET', headers: {} });
      assert.strictEqual(out.code, 502);
      assert.match(out.body.message, /Threads（取帳號） 回應不是合法 JSON/);
    } finally { restore(); }
  });

  test(`publish-single：取帳號 ID 回${name} → 1 秒內 502，不會走到發文`, async () => {
    process.env.THREADS_ACCESS_TOKEN = 'test-token';
    let posted = false;
    const restore = stubHttps(500, body);
    const origReq = https.request;
    https.request = (...a) => { posted = true; return origReq(...a); };
    try {
      const h = require('../api/publish-single');
      const out = await callWithin(h, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { text: 't' } });
      assert.strictEqual(out.code, 502);
      assert.strictEqual(posted, false);
    } finally { https.request = origReq; restore(); }
  });
}

test('test-publish：token 無效（401）也帶 message，畫面不再顯示 undefined', async () => {
  process.env.THREADS_ACCESS_TOKEN = 'test-token';
  const restore = stubHttps(400, JSON.stringify({ error: { message: 'Invalid OAuth access token' } }));
  try {
    const out = await callWithin(require('../api/test-publish'), { method: 'GET', headers: {} });
    assert.strictEqual(out.code, 401);
    assert.match(out.body.message, /Token 無效/);
  } finally { restore(); }
});

test('舊版回測（子程序）：同樣的壞回應會丟未處理例外、回應一直沒送出', () => {
  let old;
  try {
    old = execFileSync('git', ['show', 'a525b16:api/nl-convert.js'], { cwd: ROOT, encoding: 'utf-8' });
  } catch (e) {
    return;   // 淺複製取不到舊版時不判（雲端自測只跑 Python 測試，本測試在本機跑）
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oldnl-'));
  fs.mkdirSync(path.join(dir, 'api'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'api', 'nl-convert.js'), old);
  fs.copyFileSync(path.join(ROOT, 'lib', 'request-guard.js'), path.join(dir, 'lib', 'request-guard.js'));
  const script = `
    const https = require('https'); const { EventEmitter } = require('events');
    https.request = (o, cb) => { const q = new EventEmitter(); q.write = () => {}; q.end = () => { const r = new EventEmitter(); r.statusCode = 502;
      setImmediate(() => { r.emit('data', '<html>502</html>'); r.emit('end'); }); cb(r); }; return q; };
    process.env.GOOGLE_AI_API_KEY = 'k';
    let sent = false;
    process.on('uncaughtException', e => { console.log('UNCAUGHT ' + e.name); });
    const res = { status() { return res; }, json() { sent = true; return res; } };
    require(${JSON.stringify(path.join(dir, 'api', 'nl-convert.js'))})({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { prompt: 'p' } }, res);
    setTimeout(() => { console.log(sent ? 'SENT' : 'NO_RESPONSE'); process.exit(0); }, 1000);
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', timeout: 10000 });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(r.stdout, /UNCAUGHT SyntaxError/);
  assert.match(r.stdout, /NO_RESPONSE/);
});
