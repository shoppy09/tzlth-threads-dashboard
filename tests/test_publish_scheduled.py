#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
看板排程發文的控制測試（HQ RCF-278，2026-10-28；HQ routine-automation-sop.md 第五節 g）
假 GitHub（佇列檔、空跑紀錄、執行紀錄、觸發）＋假 Threads（容器、發布、讀回、自己的貼文與回覆）。
⛔ 之後每次出錯：走 HQ 改善追溯，並在這裡加一條能重現該錯的情境。

用法：python -X utf8 tests/test_publish_scheduled.py
"""
import json
import os
import sys
from base64 import b64decode, b64encode
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'scripts'))
os.environ.setdefault('GITHUB_TOKEN', 'x')
os.environ.setdefault('THREADS_ACCESS_TOKEN', 'y')

import publish_controls as pc  # noqa: E402
import publish_scheduled as ps  # noqa: E402
import notify_line as nl  # noqa: E402

# install() 會把 pc.threads_get 換成假的，第 15 段要測真的那支 ⇒ 先留一份
REAL_THREADS_GET = pc.threads_get
REAL_LINE_QUOTA = nl.line_quota_used
REAL_LINE_PUSH = nl.line_push

FAILS = 0


def ck(name, cond, info=''):
    global FAILS
    FAILS += not cond
    print(f"{'PASS' if cond else 'FAIL'}｜{name}{'｜' + str(info) if info and not cond else ''}")


class World:
    def __init__(self, queue, now, own_posts=(), replies=(), runs=None, publish_fail_at=None, readback_text=None):
        self.files = {ps.FILE_PATH: json.loads(json.dumps(queue)), ps.DRY_LOG_PATH: []}
        self.sha = {k: 1 for k in self.files}
        self.now = now
        self.own_posts = list(own_posts)
        self.replies = list(replies)
        self.runs = runs if runs is not None else {}
        self.publish_fail_at = publish_fail_at
        self.readback_text = readback_text or {}
        self.containers = []      # (text, reply_to)
        self.published = []       # 發布順序的編號
        self.puts = []            # 寫入了哪些檔
        self.dispatches = []
        self.pushes = []
        self.tim_cancels_during_wait = False
        # 真實回應形狀（10-28 probe log）：有回覆權限時 data[0] 帶 reply_config
        self.publishing_limit = {'data': [{'quota_usage': 0, 'reply_quota_usage': 0,
                                           'reply_config': {'quota_total': 1000, 'quota_duration': 86400}}]}

    def gh_api(self, method, path, body=None):
        if '/contents/' in path:
            fp = path.split('/contents/')[1]
            if method == 'GET':
                if fp not in self.files:
                    return 404, {}
                raw = json.dumps(self.files[fp], ensure_ascii=False).encode('utf-8')
                return 200, {'content': b64encode(raw).decode(), 'sha': str(self.sha[fp])}
            self.puts.append(fp)
            self.files[fp] = json.loads(b64decode(body['content']))
            self.sha[fp] = self.sha.get(fp, 0) + 1
            return 200, {}
        if path.endswith('/dispatches'):
            self.dispatches.append((path, body))
            return 204, {}
        if '/runs?' in path:
            wf = path.split('/workflows/')[1].split('/')[0]
            return 200, {'workflow_runs': self.runs.get(wf, [])}
        return 404, {}

    def threads_post(self, endpoint, params):
        if endpoint.endswith('/threads'):
            n = len(self.containers) + 1
            self.containers.append((params['text'], params.get('reply_to_id')))
            if self.publish_fail_at and len(self.published) + 1 == self.publish_fail_at and params.get('reply_to_id'):
                return {'error': {'message': 'boom'}}
            return {'id': f'c{n}'}
        if endpoint.endswith('/threads_publish'):
            pid = f'p{len(self.published) + 1}'
            self.published.append(pid)
            return {'id': pid}
        return {}

    def threads_get(self, path, token=None, opener=None):
        if path.startswith('/me?'):
            return {'id': 'U', 'username': 'tim'}
        if path.startswith('/me/threads_publishing_limit'):
            return self.publishing_limit
        if path.startswith('/me/threads?'):
            return {'data': self.own_posts}
        if path.startswith('/me/replies'):
            return {'data': self.replies}
        pid = path[1:].split('?')[0]
        if pid in self.published:
            i = self.published.index(pid)
            text = self.readback_text.get(i, self.published_texts()[i])
            return {'id': pid, 'text': text, 'permalink': f'https://threads/{pid}'}
        return {}

    def published_texts(self):
        # 第 i 個發布對應第 i 個成功建立的容器（測試裡容器建立與發布一一對應）
        return [t for t, _ in self.containers]


NET_ATTEMPTS = []


def _no_network(*a, **k):
    NET_ATTEMPTS.append(getattr(a[0], 'full_url', a[0]) if a else '?')
    raise RuntimeError('測試不得連網（有呼叫漏接到假的 Threads／GitHub）')


def install(w):
    pc.urllib.request.urlopen = _no_network      # 2026-10-28 實例：預設參數綁死真函式，測試真的打到 Threads
    ps.gh_api = w.gh_api
    ps.threads_post = w.threads_post
    pc.threads_get = w.threads_get
    ps.threads_get = lambda path: w.threads_get(path)
    ps._USER_ID_CACHE = None
    ps.CONTAINER_WAIT_S = 0
    ps.NOTES.clear()
    ps.SUMMARY.clear()
    ps.WRITE_FAILURES.clear()
    ps.now_tw = lambda: w.now
    ps.time.sleep = lambda s: None
    real_acquire = ps.acquire_lease.__wrapped__ if hasattr(ps.acquire_lease, '__wrapped__') else ps.acquire_lease

    def acquire(eid):
        if w.tim_cancels_during_wait:
            for e in w.files[ps.FILE_PATH]:
                if e['id'] == eid:
                    e['status'] = 'cancelled'
        return real_acquire(eid)
    acquire.__wrapped__ = real_acquire
    ps.acquire_lease = acquire
    ps.notify_line.send = lambda msgs, *a, **k: (w.pushes.append(list(msgs)) or 0)


CELLS = ['標題行\n\n第一格內容', '第二格內容', '第三格內容']


def entry(eid='e1', when='2026-10-29T11:00:00+08:00', cells=CELLS, approved=True, status='pending', source=None):
    e = {'id': eid, 'type': 'thread', 'title': '標題行', 'status': status, 'scheduled_at': when,
         'posts': [{'seq': i + 1, 'content': c} for i, c in enumerate(cells)],
         'approved_hash': pc.content_hash(cells) if approved else None}
    if source:
        e['source'] = source
    return e


T1057 = datetime(2026, 10, 29, 10, 57, tzinfo=pc.TW)
T1230 = datetime(2026, 10, 29, 12, 30, tzinfo=pc.TW)


def run(w, mode, task, cross='dry'):
    install(w)
    ps.MODE, ps.CROSS_MODE, ps.TASK = mode, cross, task
    {'publish': ps.run_publish, 'compare': ps.run_compare, 'watch': ps.run_watch,
     'preflight': ps.run_preflight}[task]()


# 1 空跑：不寫佇列、不發布、逐格建容器、寫空跑紀錄
w = World([entry()], T1057)
run(w, 'dry', 'publish')
ck('空跑不寫佇列', ps.FILE_PATH not in w.puts, w.puts)
ck('空跑不呼叫發布', not w.published, w.published)
ck('空跑逐格建立不發布的容器', len(w.containers) == 3 and all(r is None for _, r in w.containers))
ck('空跑寫入空跑紀錄', w.files[ps.DRY_LOG_PATH] and w.files[ps.DRY_LOG_PATH][-1]['task'] == 'publish')
ck('空跑一切正常不推 LINE', not ps.NOTES, ps.NOTES)
ck('空跑記錄回覆權限有', w.files[ps.DRY_LOG_PATH][-1].get('reply_permission') is True, w.files[ps.DRY_LOG_PATH][-1])

# 1b 回應有 data 但沒有 reply_config（沒有回覆權限）→ 判沒有、推通知（2026-10-29：原本只看 data 會判成有）
w = World([entry()], T1057)
w.publishing_limit = {'data': [{'quota_usage': 0}]}
run(w, 'dry', 'publish')
ck('缺 reply_config：判沒有回覆權限', w.files[ps.DRY_LOG_PATH][-1].get('reply_permission') is False, w.files[ps.DRY_LOG_PATH][-1])
ck('缺 reply_config：推通知', any('回覆的權限' in n for n in ps.NOTES), ps.NOTES)

# 2 空跑：內容被改 → 不建容器、推通知
bad = entry()
bad['posts'][1]['content'] = '被偷改'
w = World([bad], T1057)
run(w, 'dry', 'publish')
ck('雜湊不符：空跑也擋', not w.containers and any('核准' in n for n in ps.NOTES), ps.NOTES)

# 3 正式：完整發出、串成一串、讀回一致
w = World([entry()], T1057)
run(w, 'live', 'publish')
q = w.files[ps.FILE_PATH][0]
ck('正式：狀態 published', q['status'] == 'published', q['status'])
ck('正式：存下每格編號', q.get('post_ids') == ['p1', 'p2', 'p3'], q.get('post_ids'))
ck('正式：第 2 格回覆第 1 格、第 3 格回覆第 2 格', [r for _, r in w.containers] == [None, 'p1', 'p2'], w.containers)
ck('正式：讀回一致', q.get('readback', {}).get('ok') is True, q.get('readback'))
ck('正式：正常不推 LINE', not ps.NOTES, ps.NOTES)

# 4 正式：沒有核准 → failed、不發
w = World([entry(approved=False)], T1057)
run(w, 'live', 'publish')
ck('沒核准不發', not w.published and w.files[ps.FILE_PATH][0]['status'] == 'failed')

# 5 正式：近 48 小時已手發過 → cancelled、不重發
w = World([entry()], T1057, own_posts=[{'id': 'm1', 'text': '標題行\n\n手發', 'timestamp': '2026-10-29T02:30:00+0000', 'permalink': 'x'}])
run(w, 'live', 'publish')
ck('已手發不重發', not w.published and w.files[ps.FILE_PATH][0]['status'] == 'cancelled')

# 6 正式：第 3 格失敗 → partially_published、不重試、推通知
w = World([entry()], T1057, publish_fail_at=3)
run(w, 'live', 'publish')
q = w.files[ps.FILE_PATH][0]
ck('發到一半：partially_published', q['status'] == 'partially_published' and q.get('published_count') == 2, q)
ck('發到一半：推通知', any('2/3' in n for n in ps.NOTES), ps.NOTES)

# 7 正式：晚超過 2 小時 → failed、不發
w = World([entry(when='2026-10-29T08:00:00+08:00')], T1057)
run(w, 'live', 'publish')
ck('晚超過 2 小時不發', not w.published and w.files[ps.FILE_PATH][0]['status'] == 'failed')

# 8 正式：等待期間 Tim 在看板取消 → 拿不到租約 → 不發
w = World([entry()], T1057)
w.tim_cancels_during_wait = True
run(w, 'live', 'publish')
ck('等待期間取消就不發', not w.published, w.published)

# 9 正式：讀回不一致 → 推通知
w = World([entry()], T1057, readback_text={1: '被平台改過的字'})
run(w, 'live', 'publish')
ck('讀回不一致要推', any('讀回' in n for n in ps.NOTES), ps.NOTES)

# 10 殭屍租約 → failed、不自動重發
z = entry(status='in_progress')
z['lease_acquired_at'] = '2026-10-29T09:00:00+08:00'
w = World([z], T1057)
run(w, 'live', 'publish')
ck('殭屍租約標 failed、不重發', w.files[ps.FILE_PATH][0]['status'] == 'failed' and not w.published)

# 11 空跑比對：手發版本一致 / 不同
own = [{'id': 'R', 'text': CELLS[0], 'timestamp': '2026-10-29T03:00:00+0000', 'permalink': 'x'}]
rep = [{'id': 'a', 'text': CELLS[1], 'timestamp': '1', 'root_post': {'id': 'R'}, 'replied_to': {'id': 'R'}},
       {'id': 'b', 'text': CELLS[2], 'timestamp': '2', 'root_post': {'id': 'R'}, 'replied_to': {'id': 'a'}}]
w = World([entry()], T1230, own_posts=own, replies=rep)
run(w, 'dry', 'compare')
ck('比對一致：記 same、不推', w.files[ps.DRY_LOG_PATH][-1].get('result') == 'same' and not ps.NOTES)
rep2 = [dict(rep[0]), dict(rep[1], text='第三格改過')]
w = World([entry()], T1230, own_posts=own, replies=rep2)
run(w, 'dry', 'compare')
ck('比對不同：記 diff、推一則', w.files[ps.DRY_LOG_PATH][-1].get('result') == 'diff' and len(ps.NOTES) == 1)
ck('比對不寫佇列', ps.FILE_PATH not in w.puts)

# 12 正式比對：還沒發 → 觸發 publish 補發（本身不發）
w = World([entry()], T1230)
run(w, 'live', 'compare')
ck('補發＝觸發 publish-scheduled.yml', w.dispatches and 'publish-scheduled.yml' in w.dispatches[0][0] and not w.published)

# 13 巡看：今天該跑的沒跑 → 推
w = World([entry()], datetime(2026, 10, 29, 13, 30, tzinfo=pc.TW), runs={})
run(w, 'dry', 'watch')
ck('巡看：QStash 沒觸發要推', any('10:57' in n for n in ps.NOTES), ps.NOTES)
w = World([entry()], datetime(2026, 10, 29, 13, 30, tzinfo=pc.TW),
          runs={'publish-scheduled.yml': [{'event': 'workflow_dispatch'}], 'publish-followup.yml': [{'event': 'workflow_dispatch'}]})
run(w, 'dry', 'watch')
ck('巡看：都有跑就不推（非週日）', not ps.NOTES, ps.NOTES)

# 13b 空跑：昨天的 pending 不再報「晚了」（空跑不寫佇列，昨天那筆永遠是 pending）
w = World([entry(when='2026-10-28T11:00:00+08:00')], T1057)
run(w, 'dry', 'publish')
ck('空跑只看今天：昨天的不報晚', not ps.NOTES, ps.NOTES)

# 14 空跑模式下任何寫佇列的呼叫都會被擋
ps.MODE, ps.CROSS_MODE = 'dry', 'dry'
try:
    ps.write_scheduled_file([], None, 'x')
    ck('空跑寫佇列會丟錯', False)
except RuntimeError:
    ck('空跑寫佇列會丟錯', True)

# 16 19:00 跨發（RCF-295）：11:00 空跑、19:00 正式同時存在
CROSS = ['跨發標題\n\u200b\n第一格', '第二格']
A1100 = '2026-11-08T11:00:00+08:00'
A1900 = '2026-11-08T19:00:00+08:00'
T1857 = datetime(2026, 11, 8, 18, 57, tzinfo=pc.TW)
T1057B = datetime(2026, 11, 8, 10, 57, tzinfo=pc.TW)
T2030 = datetime(2026, 11, 8, 20, 30, tzinfo=pc.TW)


def two(status19='pending'):
    return [entry('m', A1100), entry('x', A1900, cells=CROSS, source=ps.CROSS_SOURCE, status=status19)]


w = World(two(), T1857)
run(w, 'dry', 'publish', cross='live')
q = {e['id']: e for e in w.files[ps.FILE_PATH]}
ck('18:57：不把 11:00 那筆報成晚了（每天假警報）', not ps.NOTES, ps.NOTES)
ck('18:57：跨發真的發出', q['x']['status'] == 'published' and q['x'].get('readback', {}).get('ok') is True, q['x'])
ck('18:57：11:00 空跑那筆不被動到', q['m']['status'] == 'pending' and 'error' not in q['m'], q['m'])
ck('18:57：串成一串', [r for _, r in w.containers] == [None, 'p1'], w.containers)

w = World(two(), T1857)
run(w, 'dry', 'publish', cross='dry')
ck('兩邊都空跑：18:57 不報晚、不寫佇列', not ps.NOTES and ps.FILE_PATH not in w.puts, (ps.NOTES, w.puts))
ck('兩邊都空跑：18:57 只處理跨發', [r['entry'] for r in w.files[ps.DRY_LOG_PATH]] == ['x'], w.files[ps.DRY_LOG_PATH])

w = World(two(), T1057B)
run(w, 'dry', 'publish', cross='live')
ck('10:57：跨發還沒到時間不碰', {e['id']: e['status'] for e in w.files[ps.FILE_PATH]} == {'m': 'pending', 'x': 'pending'} and not w.published)
ck('10:57：11:00 照舊空跑', [r['entry'] for r in w.files[ps.DRY_LOG_PATH]] == ['m'], w.files[ps.DRY_LOG_PATH])

own1100 = [{'id': 'R', 'text': CELLS[0], 'timestamp': '2026-11-08T03:00:00+0000', 'permalink': 'x'}]
rep1100 = [{'id': 'a', 'text': CELLS[1], 'timestamp': '1', 'root_post': {'id': 'R'}, 'replied_to': {'id': 'R'}},
           {'id': 'b', 'text': CELLS[2], 'timestamp': '2', 'root_post': {'id': 'R'}, 'replied_to': {'id': 'a'}}]
w = World(two(), T2030, own_posts=own1100, replies=rep1100)
run(w, 'dry', 'compare', cross='live')
ck('20:30：跨發沒發 → 觸發補發', w.dispatches and 'publish-scheduled.yml' in w.dispatches[0][0] and any('19:00' in n for n in ps.NOTES), (w.dispatches, ps.NOTES))
ck('20:30：不再比一次 11:00', not w.files[ps.DRY_LOG_PATH], w.files[ps.DRY_LOG_PATH])

w = World(two('published'), T2030)
run(w, 'dry', 'compare', cross='live')
ck('20:30：跨發已發 → 不補、不推', not w.dispatches and not ps.NOTES, (w.dispatches, ps.NOTES))

w = World([entry('x', '2026-11-07T19:00:00+08:00', cells=CROSS, source=ps.CROSS_SOURCE)], T1057B)
run(w, 'dry', 'publish', cross='live')
ck('昨天的跨發沒發：標 failed 並推', w.files[ps.FILE_PATH][0]['status'] == 'failed' and any('晚超過' in n for n in ps.NOTES), ps.NOTES)

w = World(two(), T1857, own_posts=[{'id': 'h', 'text': '跨發標題\n\u200b\n手發', 'timestamp': '2026-11-08T10:50:00+0000', 'permalink': 'x'}])
run(w, 'dry', 'publish', cross='live')
ck('您已手發那篇：跨發取消、不重發', not w.published and {e['id']: e['status'] for e in w.files[ps.FILE_PATH]}['x'] == 'cancelled')

w = World(two(), T1057B)
run(w, 'dry', 'preflight', cross='live')
ck('預跑：只建容器、不發布、不寫佇列', len(w.containers) == 2 and not w.published and ps.FILE_PATH not in w.puts, (w.containers, w.puts))
ck('預跑：不碰 11:00 那筆', all(t.startswith('跨發') or t == '第二格' for t, _ in w.containers), w.containers)
ck('預跑：正常不推', not ps.NOTES, ps.NOTES)

bad = entry('x', A1900, cells=CROSS, source=ps.CROSS_SOURCE)
bad['posts'][1]['content'] = '被偷改'
w = World([bad], T1857)
run(w, 'dry', 'publish', cross='live')
ck('跨發雜湊不符：不發、標 failed', not w.published and w.files[ps.FILE_PATH][0]['status'] == 'failed' and any('核准' in n for n in ps.NOTES), ps.NOTES)

w = World(two(), T1857)
run(w, 'live', 'publish', cross='dry')
ck('反向（11:00 正式、跨發空跑）：跨發不發', not w.published and w.files[ps.FILE_PATH][1]['status'] == 'pending')

# 15 預設參數不可綁死連網函式（HQ tasks「看板禁止連網守衛擋不到 threads_get」，2026-10-30）：
#    `opener=urllib.request.urlopen` 在定義時就綁死真函式，守衛換的是模組屬性，換不到它
ck('前面所有情境都沒有嘗試連網', not NET_ATTEMPTS, NET_ATTEMPTS)
import inspect  # noqa: E402
REAL = (('publish_controls.threads_get', REAL_THREADS_GET, ('/me', 't')),
        ('notify_line.line_quota_used', REAL_LINE_QUOTA, ('t',)),
        ('notify_line.line_push', REAL_LINE_PUSH, ('t', 'u', 'x')))
for name, fn, _ in REAL:
    ck(f'{name} 的 opener 預設值是 None（呼叫時才取連網函式）',
       inspect.signature(fn).parameters['opener'].default is None)
pc.urllib.request.urlopen = _no_network
for name, fn, args in REAL:
    if inspect.signature(fn).parameters['opener'].default is not None:
        ck(f'{name} 不帶 opener 會被守衛擋下', False, '預設值綁死，略過實呼叫以免真的連網')
        continue
    before = len(NET_ATTEMPTS)
    try:
        fn(*args)
        blocked = False
    except RuntimeError:
        blocked = True
    ck(f'{name} 不帶 opener 會被守衛擋下', blocked and len(NET_ATTEMPTS) == before + 1, NET_ATTEMPTS[before:])

print('合計：' + ('全部通過' if not FAILS else f'{FAILS} 項失敗'))
sys.exit(1 if FAILS else 0)
