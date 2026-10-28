"""
publish_scheduled.py — Threads 排程發文（看板 A-28）

2026-10-28 改版（HQ RCF-278，tasks「Threads 日更改由看板排程發出」；HQ routine-automation-sop.md 第五、六節）：
  - 模式 PUBLISH_MODE＝dry（空跑：不寫佇列、不發文，只產出「會發什麼」與比對）／live（真的發）。預設 dry。
  - 工作 TASK：
      publish  10:57 由 QStash 觸發（publish-scheduled.yml）；5 分鐘內到期的拿出來，等到排程時間才發（才拿租約，
               等待期間看板「取消」鈕仍有效）
      compare  12:30 由 QStash 觸發（publish-followup.yml）：dry＝讀 Tim 手發的那串逐格比對；
               live＝當天還沒發的觸發 publish 補發一次（晚 2 小時內），⛔ 補發也只在 publish-scheduled.yml 裡發，
               所以「停用 publish-scheduled.yml」（schedule_control.py pause A-28）＝全部停住
      watch    GitHub 自己的排程（publish-followup.yml；實際約 13 點多才跑）：只看不發——當天該跑的沒跑、
               11:00 的文還沒發、週日彙總、token 到期提醒
      probe    手動：驗 token、回覆權限（threads_publishing_limit 需 threads_manage_replies）、建一個不發布的容器
  - 控制：a 核准雜湊／b 每次 1 則 ≤10 格、晚 2 小時不發／c 租約＋發前看近 48 小時首行／d 存每格編號讀回／
          e 停用 workflow／f notify_line.py／g tests/test_publish_scheduled.py（見 publish_controls.py 檔頭）

State machine（沿用 2026-10-18 B38）：
  pending → in_progress（租約）→ published／partially_published／failed
  pending → cancelled（Tim 在看板取消；或發前發現已手動發過）
  in_progress 逾時 → failed（不自動重發：可能已發出，交給人確認）
  發到一半失敗 → partially_published，不自動重試（重試會重複發前幾格），推 LINE 附已發格數
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from base64 import b64decode, b64encode
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish_controls as pc  # noqa: E402
import notify_line  # noqa: E402

GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN')
THREADS_TOKEN = os.environ.get('THREADS_ACCESS_TOKEN')
MODE = os.environ.get('PUBLISH_MODE', 'dry').strip() or 'dry'
TASK = os.environ.get('TASK', 'publish').strip() or 'publish'
TOKEN_EXPIRES_ON = os.environ.get('THREADS_TOKEN_EXPIRES_ON', '')   # YYYY-MM-DD，換 token 時一起改 workflow
REPO = os.environ.get('GITHUB_REPOSITORY') or 'shoppy09/tzlth-threads-dashboard'
FILE_PATH = 'data/scheduled-posts.json'
DRY_LOG_PATH = 'data/publish-dry-log.json'
PUBLISH_WORKFLOW = 'publish-scheduled.yml'
FOLLOWUP_WORKFLOW = 'publish-followup.yml'
TW_OFFSET = pc.TW
GRAPH_API = pc.GRAPH_API
HISTORY_DAYS = 30
DRY_LOG_KEEP = 60
LEASE_TIMEOUT_MINUTES = 20
WRITE_FAILURES = []
STATUS_UPDATE_RETRIES = 3
GET_TRANSIENT_RETRIES = 3
TRANSIENT_STATUSES = {502, 503, 504}
CONTAINER_WAIT_S = 30     # Meta 官方建議建立容器後平均等 30 秒再發布
NOTES = []                # 本次要推給 Tim 的異常（最後一次合併推）
SUMMARY = []              # 寫進 Actions 摘要（公開 repo：只寫標題與結果，不寫全文以外的東西）

_USER_ID_CACHE = None


def note(msg):
    NOTES.append(msg)
    print(f'::warning::{msg}', flush=True)


def summary(line):
    SUMMARY.append(line)
    print(line, flush=True)


def label(entry):
    d = (entry.get('scheduled_at') or '')[5:10].replace('-', '/')
    t = (entry.get('title') or pc.first_line((entry.get('posts') or [{}])[0].get('content', '')))[:12]
    return f'{d}〈{t}〉'


# ── GitHub API ───────────────────────────────────────────────────────────────

def gh_api(method, path, body_dict=None):
    url = path if path.startswith('http') else f'https://api.github.com{path}'
    body_bytes = json.dumps(body_dict).encode('utf-8') if body_dict is not None else None
    headers = {'Authorization': f'Bearer {GITHUB_TOKEN}', 'Accept': 'application/vnd.github+json',
               'User-Agent': 'tzlth-publisher'}
    if body_bytes:
        headers['Content-Type'] = 'application/json'
    attempts = GET_TRANSIENT_RETRIES if method == 'GET' else 1
    last_status, last_body = None, {}
    for attempt in range(attempts):
        req = urllib.request.Request(url, data=body_bytes, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            try:
                last_status, last_body = e.code, json.loads(e.read())
            except Exception:  # noqa: BLE001
                last_status, last_body = e.code, {}
        except urllib.error.URLError as e:
            last_status, last_body = 599, {'error': str(e)}
        transient = last_status in TRANSIENT_STATUSES or last_status == 599
        if method == 'GET' and transient and attempt < attempts - 1:
            time.sleep(2 ** attempt)
            continue
        break
    return last_status, last_body


def read_json_file(path):
    status, body = gh_api('GET', f'/repos/{REPO}/contents/{path}')
    if status == 404:
        return [], None
    if status != 200:
        raise RuntimeError(f'GitHub read error {path}: {status} — {body}')
    return json.loads(b64decode(body['content'])), body['sha']


def write_json_file(path, data, sha, message):
    encoded = b64encode(json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')).decode()
    payload = {'message': message, 'content': encoded}
    if sha:
        payload['sha'] = sha
    status, _ = gh_api('PUT', f'/repos/{REPO}/contents/{path}', payload)
    return status


def read_scheduled_file():
    return read_json_file(FILE_PATH)


def write_scheduled_file(posts, sha, message):
    if MODE != 'live':
        raise RuntimeError('空跑模式不得寫佇列（SOP 第六節）')
    return write_json_file(FILE_PATH, posts, sha, message)


def append_dry_log(record):
    """空跑紀錄（不是佇列）：給週日彙總與空跑判讀用。"""
    for attempt in range(3):
        log, sha = read_json_file(DRY_LOG_PATH)
        log = (log or []) + [record]
        st = write_json_file(DRY_LOG_PATH, log[-DRY_LOG_KEEP:], sha,
                             f'[skip ci] dry-run log: {record.get("task")} {record.get("date")}')
        if st in (200, 201):
            return True
        time.sleep(2)
    WRITE_FAILURES.append('dry-log')
    print('::error::空跑紀錄寫不回 GitHub', flush=True)
    return False


def dispatch(workflow, inputs):
    st, body = gh_api('POST', f'/repos/{REPO}/actions/workflows/{workflow}/dispatches',
                      {'ref': 'master', 'inputs': inputs})
    return st in (200, 204), st, body


def runs_today(workflow, today):
    q = urllib.parse.quote(f'>={today}')
    st, body = gh_api('GET', f'/repos/{REPO}/actions/workflows/{workflow}/runs?created={q}&per_page=20')
    if st != 200:
        return None
    return [r for r in body.get('workflow_runs', []) if r.get('event') == 'workflow_dispatch']


# ── Threads API ──────────────────────────────────────────────────────────────

def threads_post(endpoint, params):
    params['access_token'] = THREADS_TOKEN
    body = urllib.parse.urlencode(params).encode('utf-8')
    req = urllib.request.Request(f'{GRAPH_API}{endpoint}', data=body, method='POST',
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def threads_get(path):
    return pc.threads_get(path, THREADS_TOKEN)


def get_user_id():
    global _USER_ID_CACHE
    if _USER_ID_CACHE:
        return _USER_ID_CACHE
    me = threads_get('/me?fields=id,username')
    if 'id' not in me:
        raise RuntimeError(f'Could not get user ID: {me}')
    _USER_ID_CACHE = me['id']
    return _USER_ID_CACHE


def create_container(text, reply_to=None):
    params = {'text': text, 'media_type': 'TEXT'}
    if reply_to:
        params['reply_to_id'] = reply_to
    c = threads_post(f'/{get_user_id()}/threads', params)
    if 'id' not in c:
        raise RuntimeError(f'container failed: {c}')
    return c['id']


def publish_container(cid):
    time.sleep(CONTAINER_WAIT_S)
    r = threads_post(f'/{get_user_id()}/threads_publish', {'creation_id': cid})
    if 'id' not in r:
        raise RuntimeError(f'publish failed: {r}')
    return r['id']


def publish_single_post(content, reply_text=None):
    """單篇（舊格式，保留給 API 直呼）。回傳 (post_id, reply_error)。"""
    post_id = publish_container(create_container(content))
    reply_error = None
    if reply_text and reply_text.strip():
        try:
            publish_container(create_container(reply_text.strip(), reply_to=post_id))
        except Exception as e:  # noqa: BLE001
            reply_error = str(e)
            print(f'::warning::首則留言發布失敗（主文已發出）：{e}', flush=True)
    return post_id, reply_error


def publish_thread(cells):
    """回傳 (已發的編號列表, error_or_None)。發到一半失敗不重試。"""
    ids = []
    for c in cells:
        try:
            pid = publish_container(create_container(c, reply_to=ids[-1] if ids else None))
            ids.append(pid)
            print(f'  Published cell {len(ids)}: {pid}', flush=True)
        except Exception as e:  # noqa: BLE001
            return ids, f'cell_{len(ids) + 1}_failed: {e}'
        time.sleep(2)
    return ids, None


# ── 租約與狀態（live 才會呼叫）────────────────────────────────────────────────

def now_tw():
    return datetime.now(TW_OFFSET)


def now_tw_iso():
    return now_tw().isoformat()


ZOMBIE_ERROR = ('租約逾時（發文中斷）：可能已發出、也可能沒發出。請到 Threads 確認；'
                '沒發出再重新排程（為避免重複發文，系統不自動重試）')


def reset_zombie_leases(posts):
    now = now_tw()
    changed = False
    for p in posts:
        if p.get('status') != 'in_progress':
            continue
        lease_str = p.get('lease_acquired_at')
        try:
            stale = (not lease_str) or (now - pc.parse_ts(lease_str)).total_seconds() > LEASE_TIMEOUT_MINUTES * 60
        except Exception as e:  # noqa: BLE001
            print(f'  Lease parse error on {p["id"][:8]}: {e}', flush=True)
            continue
        if stale:
            p['status'] = 'failed'
            p['error'] = ZOMBIE_ERROR
            p['failed_at'] = now_tw_iso()
            p.pop('lease_acquired_at', None)
            changed = True
            note(f'Threads 排程 {label(p)} 發文中斷（租約逾時），可能已發出，請到 Threads 確認')
    return changed


def acquire_lease(entry_id):
    posts, sha = read_scheduled_file()
    target = next((p for p in posts if p.get('id') == entry_id), None)
    if not target or target.get('status') != 'pending':
        return False
    target['status'] = 'in_progress'
    target['lease_acquired_at'] = now_tw_iso()
    return write_scheduled_file(posts, sha, f'lease: claim {entry_id[:8]}') in (200, 201)


def update_entry(entry_id, final_status, **kw):
    for attempt in range(STATUS_UPDATE_RETRIES):
        posts, sha = read_scheduled_file()
        target = next((p for p in posts if p.get('id') == entry_id), None)
        if not target:
            print(f'  Status update: entry {entry_id[:8]} not found', flush=True)
            return False
        target['status'] = final_status
        target.pop('lease_acquired_at', None)
        stamp = {'published': 'published_at', 'partially_published': 'published_at',
                 'failed': 'failed_at', 'cancelled': 'cancelled_at'}.get(final_status)
        if stamp:
            target[stamp] = now_tw_iso()
        if final_status == 'published':
            target['error'] = None
        for k, v in kw.items():
            target[k] = v
        st = write_scheduled_file(posts, sha, f'status: {entry_id[:8]} → {final_status}')
        if st in (200, 201):
            return True
        print(f'  Status update SHA conflict (attempt {attempt + 1}/{STATUS_UPDATE_RETRIES})', flush=True)
        time.sleep(2)
    print(f'::error::最終狀態寫不回 GitHub：{entry_id[:8]} → {final_status}', flush=True)
    WRITE_FAILURES.append(f'status {entry_id[:8]}')
    return False


def cleanup_old_records():
    posts, sha = read_scheduled_file()
    cutoff_iso = (now_tw() - timedelta(days=HISTORY_DAYS)).isoformat()

    def keep(p):
        if p.get('status') in ('pending', 'in_progress'):
            return True
        ts = p.get('published_at') or p.get('failed_at') or p.get('cancelled_at') or p.get('created_at', '')
        return ts >= cutoff_iso

    new_posts = [p for p in posts if keep(p)]
    if len(new_posts) == len(posts):
        return
    st = write_scheduled_file(new_posts, sha, f'chore: cleanup records older than {HISTORY_DAYS} days')
    if st not in (200, 201):
        print(f'::warning::清理舊紀錄寫回失敗（HTTP {st}），下次再清', flush=True)


# ── 各工作 ───────────────────────────────────────────────────────────────────

def cells_of(entry):
    return [p.get('content', '') for p in sorted(entry.get('posts', []), key=lambda p: p.get('seq', 0))]


def token_ok():
    try:
        me = threads_get('/me?fields=id,username')
        return 'id' in me, me.get('username', '')
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:120]


def reply_permission_ok():
    """threads_publishing_limit 需要 threads_manage_replies：查得到＝能發串文第 2 格以後。只讀、不發文。"""
    try:
        r = threads_get('/me/threads_publishing_limit?fields=quota_usage,config,reply_quota_usage,reply_config')
        return 'data' in r, r
    except urllib.error.HTTPError as e:
        return False, f'HTTP {e.code} {e.read()[:200]!r}'
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:200]


def preflight():
    ok, who = token_ok()
    if not ok:
        note(f'Threads token 失效或讀不到（{who}），今天的排程不會發。請換 token（4 個落點，HQ projects/SYS-02-threads.md §B）')
        return False
    summary(f'- token：有效（@{who}）')
    return True


def run_publish():
    now = now_tw()
    posts, sha = read_scheduled_file()
    if MODE == 'live' and reset_zombie_leases(posts):
        if write_scheduled_file(posts, sha, 'chore: mark zombie leases failed') not in (200, 201):
            WRITE_FAILURES.append('zombie')
        posts, sha = read_scheduled_file()
    if MODE != 'live':
        # 空跑不寫佇列 ⇒ 昨天的 pending 永遠是 pending；只看今天的，否則之後每天都會報「晚了不發」（2026-10-28 實作時撈出）
        posts = [e for e in posts if (e.get('scheduled_at') or '')[:10] == now.date().isoformat()]
    ready, late, deferred = pc.classify_due(posts, now)
    for e, why in late:
        msg = f'Threads 排程 {label(e)} 已晚超過 {pc.LATE_MAX_MINUTES // 60} 小時，不發（{why}）'
        note(msg)
        if MODE == 'live':
            update_entry(e['id'], 'failed', error=msg)
    for e in deferred:
        note(f'Threads 排程 {label(e)} 超過單次上限 {pc.MAX_PER_RUN} 則，延到下一次（12:30 那次會補）')
    if not ready:
        summary('- 沒有到期的排程')
        if MODE == 'live':
            cleanup_old_records()
        return
    if not preflight():
        return
    for entry in ready:
        cells = cells_of(entry)
        ok, code, why = pc.check_entry(entry)
        summary(f'### {label(entry)}｜{len(cells)} 格｜檢查：{"通過" if ok else why}')
        if not ok:
            note(f'Threads 排程 {label(entry)} 不發：{why}')
            if MODE == 'live':
                update_entry(entry['id'], 'failed', error=f'{code}: {why}')
            continue
        if MODE != 'live':
            run_publish_dry(entry, cells, now)
            continue
        dup = pc.already_posted(cells[0], THREADS_TOKEN, now)
        if dup:
            update_entry(entry['id'], 'cancelled', error=f'already_posted: {dup.get("permalink", "")}')
            note(f'Threads 排程 {label(entry)} 近 48 小時已有首行相同的貼文，不重發')
            continue
        wait = (pc.parse_ts(entry['scheduled_at']) - now_tw()).total_seconds()
        if wait > 0:
            print(f'  等到排程時間：{int(wait)} 秒', flush=True)
            time.sleep(wait)
        if not acquire_lease(entry['id']):        # 等待期間 Tim 取消 → 拿不到租約 → 不發
            summary('- 拿不到租約（已取消或已被處理），不發')
            continue
        ids, err = publish_thread(cells)
        if err is None:
            rb = pc.readback(ids, cells, THREADS_TOKEN)
            update_entry(entry['id'], 'published', post_ids=ids, permalink=rb['permalink'], readback=rb)
            summary(f'- ✅ 已發 {len(ids)} 格：{rb["permalink"]}｜讀回{"一致" if rb["ok"] else "不一致：" + str(rb["mismatch"])}')
            if not rb['ok']:
                note(f'Threads {label(entry)} 已發出，但讀回第 {rb["mismatch"]} 格和核准版不同，請看一下')
        elif ids:
            update_entry(entry['id'], 'partially_published', post_ids=ids, published_count=len(ids),
                         total_count=len(cells), error=err)
            note(f'Threads {label(entry)} 只發出 {len(ids)}/{len(cells)} 格就失敗（不自動重試，避免重複）。'
                 f'請在 App 手動接上剩下的格，或刪掉重發')
        else:
            update_entry(entry['id'], 'failed', error=err)
            note(f'Threads {label(entry)} 第 1 格就發布失敗，沒有發出任何內容：{err[:80]}')
    cleanup_old_records()


def run_publish_dry(entry, cells, now):
    """空跑：不發、不寫佇列。驗回覆權限，並為每格建一個不發布的容器，確認 API 收得下這些字。"""
    rec = {'task': 'publish', 'date': entry['scheduled_at'][:10], 'entry': entry['id'], 'title': entry.get('title', ''),
           'cells': len(cells), 'hash_ok': True, 'at': now_tw_iso()}
    perm, detail = reply_permission_ok()
    rec['reply_permission'] = perm
    summary(f'- 回覆權限（串文第 2 格以後要用）：{"有" if perm else "沒有／讀不到"}')
    if not perm:
        note(f'Threads 空跑：token 沒有發回覆的權限（threads_manage_replies），正式發文會只發出第 1 格。{str(detail)[:80]}')
    bad = []
    for i, c in enumerate(cells, 1):
        try:
            create_container(pc.normalize_cell(c))      # 不呼叫 threads_publish ＝ 不公開
        except Exception as e:  # noqa: BLE001
            bad.append(f'第 {i} 格：{str(e)[:80]}')
    rec['container_errors'] = bad
    summary(f'- 逐格建立不發布的容器：{"全部成功" if not bad else "；".join(bad)}')
    if bad:
        note(f'Threads 空跑 {label(entry)}：API 不收這些格 → {"；".join(bad)}')
    for i, c in enumerate(cells, 1):
        summary(f'  - 第 {i} 格：{pc.weighted_len(pc.normalize_cell(c))} 字元｜{pc.first_line(c)[:30]}')
    append_dry_log(rec)


def today_entries(posts, now):
    d = now.date().isoformat()
    return [e for e in posts if (e.get('scheduled_at') or '')[:10] == d and pc.parse_ts(e['scheduled_at']) <= now]


def run_compare():
    now = now_tw()
    posts, _ = read_scheduled_file()
    todays = today_entries(posts, now)
    if not todays:
        summary('- 今天沒有已到期的排程')
        return
    if not preflight():
        return
    for e in todays:
        cells = cells_of(e)
        if MODE == 'live':
            if e.get('status') == 'pending':
                ok, st, _ = dispatch(PUBLISH_WORKFLOW, {'task': 'publish'})
                if ok:
                    note(f'Threads {label(e)} 11:00 沒發出，12:30 補發一次（請之後看一下）')
                else:
                    note(f'Threads {label(e)} 11:00 沒發出，補發觸發失敗（HTTP {st}；暫停中也會這樣）')
            summary(f'- {label(e)}：{e.get("status")}')
            continue
        root, got = pc.find_manual_thread(cells, THREADS_TOKEN, now)
        rec = {'task': 'compare', 'date': now.date().isoformat(), 'entry': e['id'], 'title': e.get('title', ''),
               'cells': len(cells), 'at': now_tw_iso()}
        if not root:
            rec['result'] = 'not_found'
            summary(f'- {label(e)}：找不到你今天手發、首行相同的那篇（還沒發或改了標題），記入週日彙總')
        else:
            diffs = pc.diff_cells(cells, got)
            rec.update(result='same' if not diffs else 'diff', diffs=diffs, permalink=root.get('permalink', ''))
            summary(f'- {label(e)}：與你手發的版本{"逐格一致" if not diffs else "有差異"}')
            for d in diffs:
                summary(f'  - {d}')
            if diffs:
                note(f'Threads 空跑比對 {label(e)}：和你手發的版本有 {len(diffs)} 處不同（可能是你發文時改的）。'
                     f'明細看 GitHub Actions「Threads Publish Follow-up」今天那次')
        append_dry_log(rec)


def run_watch():
    now = now_tw()
    today = now.date().isoformat()
    posts, _ = read_scheduled_file()
    due = [e for e in today_entries(posts, now)]
    if due:
        pub = runs_today(PUBLISH_WORKFLOW, today)
        fol = runs_today(FOLLOWUP_WORKFLOW, today)
        if pub is not None and not pub:
            note('Threads 排程：今天有到期的串文，但 10:57 的發文觸發（QStash）沒有跑')
        if fol is not None and not fol:
            note('Threads 排程：12:30 的比對／補發觸發（QStash）今天沒有跑')
        if MODE == 'live':
            for e in due:
                if e.get('status') == 'pending' and now - pc.parse_ts(e['scheduled_at']) > timedelta(minutes=30):
                    note(f'Threads {label(e)} 到現在還沒發出')
    summary(f'- 巡看：今天到期 {len(due)} 則')
    if now.weekday() == 6:                      # 週日彙總（空跑期；Tim 2026-10-28 D3）
        weekly_digest(now)
    token_reminder(now)


def weekly_digest(now):
    try:
        log, _ = read_json_file(DRY_LOG_PATH)
    except Exception as e:  # noqa: BLE001
        note(f'Threads 週彙總讀不到空跑紀錄：{e}')
        return
    since = (now - timedelta(days=7)).date().isoformat()
    recent = [r for r in (log or []) if r.get('date', '') >= since]
    if MODE != 'live' and not recent:
        return
    pubs = [r for r in recent if r.get('task') == 'publish']
    cmps = [r for r in recent if r.get('task') == 'compare']
    same = sum(r.get('result') == 'same' for r in cmps)
    diff = sum(r.get('result') == 'diff' for r in cmps)
    nf = sum(r.get('result') == 'not_found' for r in cmps)
    bad = sum(bool(r.get('container_errors')) or r.get('reply_permission') is False for r in pubs)
    NOTES.append(f'📋 Threads 排程空跑週彙總（{since}～{now.date().isoformat()}）：發文空跑 {len(pubs)} 次、'
                 f'其中有問題 {bad} 次；與你手發比對 一致 {same}／不同 {diff}／找不到 {nf}。'
                 f'正式上線前至少要 2 週、5 次（RCF-278）')


def token_reminder(now):
    if not TOKEN_EXPIRES_ON:
        return
    try:
        left = (datetime.fromisoformat(TOKEN_EXPIRES_ON).date() - now.date()).days
    except ValueError:
        return
    if left <= 3 or (left <= 14 and now.weekday() == 6):
        NOTES.append(f'⏰ Threads token 還有 {left} 天到期（{TOKEN_EXPIRES_ON}），到期當天 11:00 就發不出去。'
                     f'請換 token（4 個落點）並改 workflow 的 THREADS_TOKEN_EXPIRES_ON')


def run_probe():
    ok = preflight()
    perm, detail = reply_permission_ok()
    summary(f'- 回覆權限：{"有" if perm else "沒有"}｜{str(detail)[:200]}')
    if ok:
        try:
            cid = create_container('（看板排程實測：不發布的容器）')
            summary(f'- 建立不發布的容器：成功（{cid}）')
        except Exception as e:  # noqa: BLE001
            summary(f'- 建立不發布的容器：失敗 {str(e)[:200]}')
            note(f'Threads probe：建立容器失敗 {str(e)[:80]}')
    if not perm:
        note('Threads probe：token 沒有發回覆的權限，串文第 2 格以後會失敗')


def main():
    if not GITHUB_TOKEN or not THREADS_TOKEN:
        print('ERROR: GITHUB_TOKEN 或 THREADS_ACCESS_TOKEN 未設定', flush=True)
        sys.exit(1)
    if MODE not in ('dry', 'live'):
        print(f'ERROR: PUBLISH_MODE 只能是 dry／live，收到 {MODE!r}', flush=True)
        sys.exit(1)
    summary(f'## Threads 排程｜{TASK}｜模式 {MODE}｜{now_tw().strftime("%Y-%m-%d %H:%M")} 台灣')
    {'publish': run_publish, 'compare': run_compare, 'watch': run_watch, 'probe': run_probe}[TASK]()
    finish()


def finish():
    out = os.environ.get('GITHUB_STEP_SUMMARY')
    if out:
        with open(out, 'a', encoding='utf-8') as f:
            f.write('\n'.join(SUMMARY) + '\n')
    rc = notify_line.send(NOTES) if NOTES else 0
    if WRITE_FAILURES:
        print(f'::error::寫回 GitHub 失敗 {len(WRITE_FAILURES)} 處：{", ".join(WRITE_FAILURES)}', flush=True)
        sys.exit(1)
    if rc:
        sys.exit(1)


if __name__ == '__main__':
    main()
