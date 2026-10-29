#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
publish_controls.py — Threads 排程發文的對外控制（HQ RCF-278，2026-10-28；HQ routine-automation-sop.md 第五節 a～g）

被 publish_scheduled.py 匯入。只放「純函式＋Threads 讀取」，不寫佇列。

a 核准雜湊：content_hash() 必須和 HQ scripts/threads_queue.py 的同名函式逐位元相同
  與看板 lib/content-hash.js（排程面板顯示「雜湊一致」用，2026-10-29）三邊驗同一組測試向量 HASH_VECTOR；改一邊就要改另兩邊。
  正規化＝CRLF/CR→LF、NFC、每行去尾端空白、整格去頭尾空白。
b 字數：Threads 每則上限 500 字元，emoji 按 UTF-8 位元組計（Meta 官方 posts 頁）⇒ weighted_len()。
  emoji 判斷是近似（常見 emoji 區段＋變體選擇字＋零寬連接字），寧可算多。
c 去重：already_posted() 讀自己近 48 小時的頂層貼文，首行相同就當成已發（防 Tim 手動已發）。
d 讀回：readback() 用發文時存下的編號逐格讀回比對；find_manual_thread() 給空跑比對用
  （從 /me/threads 找首行相同的串首，再沿「回覆自己上一格」的鏈往下找，邏輯同 fetch-threads.js buildThreadParts，
   不收別人的留言，也不收 Tim 回讀者的回覆）。
"""

import hashlib
import json
import re
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

GRAPH_API = 'https://graph.threads.net/v1.0'
TW = timezone(timedelta(hours=8))
MAX_CELL = 500
MAX_CELLS = 10
MAX_PER_RUN = 1          # 每次最多 1 則串文（SOP 第五節 b 預設 3，日更 1 篇取更嚴）
LEAD_MINUTES = 5         # 10:57 觸發時，5 分鐘內到期的先拿出來等
LATE_MAX_MINUTES = 120   # 晚超過 2 小時不發（只有 12:30 那次會補發，Tim 2026-10-28 D5）
DEDUPE_HOURS = 48

# 三邊（看板 Python／看板 lib/content-hash.js／HQ）共用的測試向量：改正規化或雜湊時三邊自測會一起紅
HASH_VECTOR = (['標題行\r\n\r\n第一段  \n', '  第二格　結尾。 '],
               '8bff0c2746ccaa00f30985a4258a63bde92f023bedd09fca7ab136b967ee2947')


def normalize_cell(s):
    s = (s or '').replace('\r\n', '\n').replace('\r', '\n')
    s = unicodedata.normalize('NFC', s)
    s = '\n'.join(line.rstrip() for line in s.split('\n'))
    return s.strip()


def content_hash(cells):
    norm = [normalize_cell(c) for c in cells]
    return hashlib.sha256(json.dumps(norm, ensure_ascii=False).encode('utf-8')).hexdigest()


def _is_emoji(ch):
    cp = ord(ch)
    return (cp >= 0x1F000 or 0x2600 <= cp <= 0x27BF or 0x2B00 <= cp <= 0x2BFF
            or cp in (0xFE0F, 0x200D, 0x20E3) or 0x1F1E6 <= cp <= 0x1F1FF)


def weighted_len(s):
    return sum(len(ch.encode('utf-8')) if _is_emoji(ch) else 1 for ch in s or '')


def first_line(s):
    for line in normalize_cell(s).split('\n'):
        if line.strip():
            return line.strip()
    return ''


def check_entry(entry):
    """發布前檢查（a、b）。回傳 (ok, 原因代碼, 說明)。"""
    if entry.get('type') != 'thread':
        return False, 'not_thread', '只發串文（單篇格式沒有核准流程）'
    cells = [p.get('content', '') for p in sorted(entry.get('posts', []), key=lambda p: p.get('seq', 0))]
    if not cells:
        return False, 'empty', '沒有內容'
    if not entry.get('approved_hash'):
        return False, 'unapproved', '沒有核准紀錄（看板網頁新增的排程不發，Tim 2026-10-28 D4）'
    if content_hash(cells) != entry['approved_hash']:
        return False, 'hash_mismatch', '內容和核准時不同（核准後被改過），需重新核准'
    if len(cells) > MAX_CELLS:
        return False, 'too_many_cells', f'{len(cells)} 格超過上限 {MAX_CELLS}'
    for i, c in enumerate(cells, 1):
        n = weighted_len(normalize_cell(c))
        if n > MAX_CELL:
            return False, 'too_long', f'第 {i} 格 {n} 字元（emoji 按位元組計）超過 {MAX_CELL}'
    return True, 'ok', ''


def parse_ts(s):
    # Threads API 時間格式是 2026-10-29T02:30:00+0000（時區沒有冒號）；統一補成 +00:00，不依賴 Python 版本
    s = re.sub(r'([+-]\d{2})(\d{2})$', r'\1:\2', str(s).replace('Z', '+00:00'))
    d = datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=TW)
    return d


def classify_due(entries, now):
    """回傳 (要處理的, 太晚的, 延後的)；只看 pending。排序最舊優先，取 MAX_PER_RUN。"""
    ready, late = [], []
    for e in entries:
        if e.get('status') != 'pending':
            continue
        try:
            t = parse_ts(e['scheduled_at'])
        except Exception:  # noqa: BLE001
            late.append((e, 'bad_time'))
            continue
        if t > now + timedelta(minutes=LEAD_MINUTES):
            continue
        if now - t > timedelta(minutes=LATE_MAX_MINUTES):
            late.append((e, 'too_late'))
            continue
        ready.append(e)
    ready.sort(key=lambda e: parse_ts(e['scheduled_at']))
    return ready[:MAX_PER_RUN], late, ready[MAX_PER_RUN:]


# ── Threads 讀取 ─────────────────────────────────────────────────────────────

def threads_get(path, token, opener=urllib.request.urlopen):
    """path 為相對路徑（補上網址與 token），或 API 回的 paging.next 完整網址（已含 token，原樣使用）。"""
    if path.startswith('http'):
        url = path
    else:
        sep = '&' if '?' in path else '?'
        url = f'{GRAPH_API}{path}{sep}access_token={urllib.parse.quote(token)}'
    req = urllib.request.Request(url, headers={'User-Agent': 'tzlth-publisher'})
    with opener(req, timeout=60) as r:
        return json.loads(r.read())


def recent_top_posts(token, get=None, limit=15):
    get = get or threads_get
    res = get(f'/me/threads?fields=id,text,timestamp,permalink&limit={limit}', token)
    return res.get('data', [])


def already_posted(first_cell, token, now, get=None):
    """近 DEDUPE_HOURS 小時內自己有首行相同的頂層貼文 → 回傳那篇，否則 None。"""
    want = first_line(first_cell)
    for p in recent_top_posts(token, get):
        try:
            if now - parse_ts(p.get('timestamp')) > timedelta(hours=DEDUPE_HOURS):
                continue
        except Exception:  # noqa: BLE001
            continue
        if first_line(p.get('text', '')) == want:
            return p
    return None


def readback(post_ids, cells, token, get=None):
    """逐格讀回。回傳 {'ok': bool, 'mismatch': [seq…], 'permalink': 首格連結}。"""
    get = get or threads_get
    mismatch, permalink = [], ''
    for i, (pid, c) in enumerate(zip(post_ids, cells), 1):
        try:
            got = get(f'/{pid}?fields=id,text,permalink', token)
        except Exception:  # noqa: BLE001
            mismatch.append(i)
            continue
        if i == 1:
            permalink = got.get('permalink', '')
        if normalize_cell(got.get('text', '')) != normalize_cell(c):
            mismatch.append(i)
    if len(post_ids) != len(cells):
        mismatch.append('格數')
    return {'ok': not mismatch, 'mismatch': mismatch, 'permalink': permalink}


def own_chain(root_id, replies):
    """replies＝/me/replies 的 data；只收接在自己這串後面的格（同 fetch-threads.js buildThreadParts）。"""
    lst = [r for r in replies if (r.get('root_post') or {}).get('id') == root_id]
    lst.sort(key=lambda r: str(r.get('timestamp', '')))
    chain, parts = {root_id}, []
    for r in lst:
        parent = (r.get('replied_to') or {}).get('id')
        if parent in chain:
            chain.add(r['id'])
            parts.append(r)
    return parts


def find_manual_thread(cells, token, now, get=None, reply_pages=3):
    """空跑比對：找 Tim 手發、首行相同的那串。回傳 (root, [各格文字]) 或 (None, [])。"""
    get = get or threads_get
    root = already_posted(cells[0], token, now, get)
    if not root:
        return None, []
    replies, url = [], '/me/replies?fields=id,text,timestamp,root_post,replied_to&limit=100'
    for _ in range(reply_pages):          # 新到舊；當天的回覆在最前面幾頁（Tim 每天也會回別人，故最多翻 3 頁）
        res = get(url, token)
        replies += res.get('data', [])
        nxt = (res.get('paging') or {}).get('next')
        if not nxt or len(own_chain(root['id'], replies)) >= len(cells) - 1:
            break
        url = nxt
    parts = own_chain(root['id'], replies)
    return root, [root.get('text', '')] + [p.get('text', '') for p in parts]


def diff_cells(want, got):
    """逐格比對，回傳差異說明列表（空＝一致）。"""
    out = []
    if len(want) != len(got):
        out.append(f'格數不同：排程 {len(want)} 格、線上 {len(got)} 格')
    for i, (a, b) in enumerate(zip(want, got), 1):
        a2, b2 = normalize_cell(a), normalize_cell(b)
        if a2 != b2:
            k = next((j for j in range(min(len(a2), len(b2))) if a2[j] != b2[j]), min(len(a2), len(b2)))
            out.append(f'第 {i} 格不同（第 {k + 1} 字起）：排程「{a2[max(0, k - 8):k + 12]}」／線上「{b2[max(0, k - 8):k + 12]}」')
    return out


def selftest():
    fails = 0

    def ck(name, got, want):
        nonlocal fails
        ok = got == want
        fails += not ok
        print(f"{'PASS' if ok else 'FAIL'}｜{name}｜預期 {want!r} 實得 {got!r}")

    ck('正規化：CRLF、尾端空白、頭尾空白', normalize_cell('a  \r\nb\r\n\r\n'), 'a\nb')
    ck('雜湊不受換行格式影響', content_hash(['a\r\nb']), content_hash(['a\nb']))
    ck('雜湊受內容影響', content_hash(['a']) == content_hash(['b']), False)
    ck('測試向量（與 HQ threads_queue.py 同值）', content_hash(HASH_VECTOR[0]), HASH_VECTOR[1])
    ck('emoji 按位元組計', weighted_len('a😀'), 1 + 4)
    ck('中文按字元計', weighted_len('中文'), 2)
    ck('Threads 時間格式（+0000）', parse_ts('2026-10-29T02:30:00+0000').hour, 2)
    e = {'type': 'thread', 'posts': [{'seq': 1, 'content': 'x'}], 'approved_hash': content_hash(['x'])}
    ck('核准相符可發', check_entry(e)[0], True)
    ck('沒核准不發', check_entry({**e, 'approved_hash': None})[1], 'unapproved')
    ck('內容被改不發', check_entry({**e, 'posts': [{'seq': 1, 'content': 'y'}]})[1], 'hash_mismatch')
    long = '字' * 501
    ck('超過 500 不發', check_entry({**e, 'posts': [{'seq': 1, 'content': long}], 'approved_hash': content_hash([long])})[1], 'too_long')
    many = [str(i) for i in range(11)]
    ck('超過 10 格不發', check_entry({'type': 'thread', 'posts': [{'seq': i + 1, 'content': c} for i, c in enumerate(many)],
                                       'approved_hash': content_hash(many)})[1], 'too_many_cells')
    now = datetime(2026, 10, 29, 10, 57, tzinfo=TW)
    q = [{'id': 'a', 'status': 'pending', 'scheduled_at': '2026-10-29T11:00:00+08:00'},
         {'id': 'b', 'status': 'pending', 'scheduled_at': '2026-10-29T08:00:00+08:00'},
         {'id': 'c', 'status': 'pending', 'scheduled_at': '2026-10-30T11:00:00+08:00'},
         {'id': 'd', 'status': 'published', 'scheduled_at': '2026-10-29T11:00:00+08:00'}]
    r, l, d = classify_due(q, now)
    ck('10:57 拿到 11:00 的文', [x['id'] for x in r], ['a'])
    ck('晚 3 小時的不發', [x[0]['id'] for x in l], ['b'])
    ck('明天的不碰', 'c' in [x['id'] for x in r + d], False)
    q2 = [{'id': 'x', 'status': 'pending', 'scheduled_at': '2026-10-29T10:50:00+08:00'},
          {'id': 'y', 'status': 'pending', 'scheduled_at': '2026-10-29T11:00:00+08:00'}]
    r, l, d = classify_due(q2, now)
    ck('超過單次上限：最舊先發、其餘延後', ([x['id'] for x in r], [x['id'] for x in d]), (['x'], ['y']))
    replies = [{'id': 'r1', 'timestamp': '1', 'root_post': {'id': 'R'}, 'replied_to': {'id': 'R'}},
               {'id': 'z', 'timestamp': '2', 'root_post': {'id': 'R'}, 'replied_to': {'id': 'reader'}},
               {'id': 'r2', 'timestamp': '3', 'root_post': {'id': 'R'}, 'replied_to': {'id': 'r1'}}]
    ck('只收自己的串、不收回讀者的', [p['id'] for p in own_chain('R', replies)], ['r1', 'r2'])
    ck('逐格比對：一致', diff_cells(['a', 'b'], ['a', 'b ']), [])
    ck('逐格比對：格數不同會報', len(diff_cells(['a', 'b'], ['a'])) >= 1, True)
    print('合計：' + ('全部通過' if not fails else f'{fails} 項失敗'))
    return 1 if fails else 0


if __name__ == '__main__':
    import sys
    sys.exit(selftest())
