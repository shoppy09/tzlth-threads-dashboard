const crypto = require('crypto');

// 核准雜湊的 JS 版（2026-10-29 HQ tasks「看板排程面板改善」B：排程面板顯示「已核准，雜湊一致」）
// ⛔ 必須和 scripts/publish_controls.py、HQ scripts/threads_queue.py 的 content_hash() 逐位元相同
//    （三邊驗同一組測試向量 HASH_VECTOR；改一邊就要改另兩邊）。
// 只給畫面顯示用：發不發仍由 publish_controls.check_entry() 決定，這裡算錯只會顯示錯，不會讓沒核准的發出去。
// 正規化＝CRLF/CR→LF、NFC、每行去尾端空白、整格去頭尾空白。
// 「空白」照 Python str.isspace() 的集合（比 JS trim() 多 \x1c-\x1f、\x85，少 ﻿），不能改用 trim()。
// 雜湊輸入＝json.dumps(list, ensure_ascii=False) 的字串：元素間是「, 」；JSON.stringify 對字串的跳脫與 Python 相同
// （\" \\ \b \f \n \r \t，其他控制字元 \u00xx 小寫）。孤立代理字元兩邊不同，但 Python 那邊會直接失敗，不會有核准紀錄。

const WS = '[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const TAIL = new RegExp(WS + '+$');
const HEAD = new RegExp('^' + WS + '+');

const HASH_VECTOR = [['標題行\r\n\r\n第一段  \n', '  第二格　結尾。 '],
  '8bff0c2746ccaa00f30985a4258a63bde92f023bedd09fca7ab136b967ee2947'];

function normalizeCell(s) {
  s = String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC');
  s = s.split('\n').map(line => line.replace(TAIL, '')).join('\n');
  return s.replace(HEAD, '').replace(TAIL, '');
}

function contentHash(cells) {
  const json = '[' + cells.map(c => JSON.stringify(normalizeCell(c))).join(', ') + ']';
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

// 佇列項目的格子：照 publish_controls.check_entry() 依 seq 排序取 content
function entryCells(entry) {
  return [...(entry.posts || [])].sort((a, b) => (a.seq || 0) - (b.seq || 0)).map(p => p.content || '');
}

// 自測：測試向量不符就回 false，呼叫端整批改顯示「雜湊未核對」，不誤標一致
function selftest() {
  return contentHash(HASH_VECTOR[0]) === HASH_VECTOR[1];
}

module.exports = { normalizeCell, contentHash, entryCells, selftest, HASH_VECTOR };
