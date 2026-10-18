"""
publish_scheduled.py
Triggered by GitHub Actions every 30 minutes.
Reads data/scheduled-posts.json, publishes due posts (single or thread) to Threads,
writes back with lease-based concurrency protection.

Uses GITHUB_TOKEN (auto-provided by Actions) and THREADS_ACCESS_TOKEN (secret).

State machine:
  pending → in_progress (lease acquired with SHA)
  pending → cancelled (user DELETE)
  in_progress → published (all posts succeeded)
  in_progress → partially_published (thread mid-failure)
  in_progress → failed (first post failure or single post failure)
  in_progress → failed (zombie lease timeout; 2026-10-18 起不再自動改回 pending，見 reset_zombie_leases)
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
from dateutil import parser as dateparser

GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN')
THREADS_TOKEN = os.environ.get('THREADS_ACCESS_TOKEN')
REPO = 'shoppy09/tzlth-threads-dashboard'
FILE_PATH = 'data/scheduled-posts.json'
TW_OFFSET = timezone(timedelta(hours=8))
GRAPH_API = 'https://graph.threads.net/v1.0'
HISTORY_DAYS = 30
LEASE_TIMEOUT_MINUTES = 20  # Zombie lease detection threshold
# 2026-10-18（HQ 批次:B38，寫入失敗審查 10-08 ③）：任何寫回 GitHub 失敗都記在這裡，跑完 exit 1
# ⇒ Actions 紅燈寄信。原本只印 WARNING、照印 Success，失敗沒人看得到
WRITE_FAILURES = []
STATUS_UPDATE_RETRIES = 3   # SHA conflict retry on final status update
GET_TRANSIENT_RETRIES = 3   # Retry GET on transient GitHub API errors (502/503/504/network)
TRANSIENT_STATUSES = {502, 503, 504}  # GitHub server-side transient errors

# Cache user_id within a single run
_USER_ID_CACHE = None


# ── Validation ──────────────────────────────────────────────────────────────

def check_env():
    if not GITHUB_TOKEN:
        print('ERROR: GITHUB_TOKEN not set', flush=True)
        sys.exit(1)
    if not THREADS_TOKEN:
        print('ERROR: THREADS_ACCESS_TOKEN not set', flush=True)
        sys.exit(1)


# ── GitHub Contents API ──────────────────────────────────────────────────────

def github_request(method, path, body_dict=None):
    url = f'https://api.github.com/repos/{REPO}/contents/{path}'
    body_bytes = json.dumps(body_dict).encode('utf-8') if body_dict else None
    headers = {
        'Authorization': f'Bearer {GITHUB_TOKEN}',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'tzlth-publisher',
    }
    if body_bytes:
        headers['Content-Type'] = 'application/json'
    # GET is idempotent → retry on transient GitHub 5xx / network errors with backoff.
    # (Root cause of spurious workflow failures: read_scheduled_file() hit GitHub API 502.)
    # Non-GET (PUT) is not retried here — write conflicts are handled via SHA/STATUS_UPDATE_RETRIES.
    attempts = GET_TRANSIENT_RETRIES if method == 'GET' else 1
    last_status, last_body = None, {}
    for attempt in range(attempts):
        req = urllib.request.Request(url, data=body_bytes, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                last_status, last_body = e.code, json.loads(e.read())
            except Exception:
                last_status, last_body = e.code, {}
        except urllib.error.URLError as e:
            # network-level transient (DNS/conn reset/timeout) — retryable for GET
            last_status, last_body = 599, {'error': str(e)}
        transient = last_status in TRANSIENT_STATUSES or last_status == 599
        if method == 'GET' and transient and attempt < attempts - 1:
            time.sleep(2 ** attempt)  # 1s, 2s exponential backoff
            continue
        break
    return last_status, last_body


def read_scheduled_file():
    status, body = github_request('GET', FILE_PATH)
    if status == 404:
        return [], None
    if status != 200:
        raise RuntimeError(f'GitHub read error: {status} — {body}')
    posts = json.loads(b64decode(body['content']))
    return posts, body['sha']


def write_scheduled_file(posts, sha, message):
    encoded = b64encode(json.dumps(posts, ensure_ascii=False, indent=2).encode('utf-8')).decode()
    payload = {'message': message, 'content': encoded}
    if sha:
        payload['sha'] = sha
    status, _ = github_request('PUT', FILE_PATH, payload)
    return status  # 200/201 = ok, 409 = SHA conflict


# ── Threads API ──────────────────────────────────────────────────────────────

def threads_post(endpoint, params):
    params['access_token'] = THREADS_TOKEN
    body = urllib.parse.urlencode(params).encode('utf-8')
    req = urllib.request.Request(
        f'{GRAPH_API}{endpoint}',
        data=body,
        method='POST',
        headers={'Content-Type': 'application/x-www-form-urlencoded'}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def threads_get(path):
    sep = '&' if '?' in path else '?'
    url = f'{GRAPH_API}{path}{sep}access_token={THREADS_TOKEN}'
    req = urllib.request.Request(url, headers={'User-Agent': 'tzlth-publisher'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def get_user_id():
    global _USER_ID_CACHE
    if _USER_ID_CACHE:
        return _USER_ID_CACHE
    me = threads_get('/me?fields=id')
    if 'id' not in me:
        raise RuntimeError(f'Could not get user ID: {me}')
    _USER_ID_CACHE = me['id']
    return _USER_ID_CACHE


def publish_single_post(content, reply_text=None):
    """Publishes one post (and optional first-comment reply) to Threads.
    Returns (post_id, reply_error_or_None). Raises on main-post failure."""
    user_id = get_user_id()
    container = threads_post(f'/{user_id}/threads', {'text': content, 'media_type': 'TEXT'})
    if 'id' not in container:
        raise RuntimeError(f'Main container creation failed: {container}')
    container_id = container['id']
    print(f'  Waiting 30s for container {container_id}...', flush=True)
    time.sleep(30)
    result = threads_post(f'/{user_id}/threads_publish', {'creation_id': container_id})
    if 'id' not in result:
        raise RuntimeError(f'Publish failed: {result}')
    post_id = result['id']
    print(f'  Published main post: {post_id}', flush=True)

    reply_error = None
    if reply_text and reply_text.strip():
        try:
            reply_container = threads_post(
                f'/{user_id}/threads',
                {'text': reply_text.strip(), 'media_type': 'TEXT', 'reply_to_id': post_id}
            )
            if 'id' not in reply_container:
                raise RuntimeError(f'Reply container creation failed: {reply_container}')
            print(f'  Waiting 30s for reply container...', flush=True)
            time.sleep(30)
            pub = threads_post(f'/{user_id}/threads_publish', {'creation_id': reply_container['id']})
            if 'id' not in pub:
                raise RuntimeError(f'Reply publish failed: {pub}')
            print(f'  Reply published.', flush=True)
        except Exception as e:
            # 主文已發出 ⇒ 狀態仍是 published，但把留言失敗寫進 reply_error（原本只印、記錄看不到）
            reply_error = str(e)
            print(f'::warning::首則留言發布失敗（主文已發出）：{e}', flush=True)
    return post_id, reply_error


def publish_reply(content, reply_to_id):
    """Publish one post as a reply to an existing post. Raises on failure."""
    user_id = get_user_id()
    container = threads_post(f'/{user_id}/threads', {
        'text': content, 'media_type': 'TEXT', 'reply_to_id': reply_to_id
    })
    if 'id' not in container:
        raise RuntimeError(f'Reply container creation failed: {container}')
    print(f'  Waiting 30s for reply container...', flush=True)
    time.sleep(30)
    result = threads_post(f'/{user_id}/threads_publish', {'creation_id': container['id']})
    if 'id' not in result:
        raise RuntimeError(f'Reply publish failed: {result}')
    print(f'  Published reply: {result["id"]}', flush=True)
    return result['id']


def publish_thread(posts):
    """Publish a thread (chained replies). Returns (success_count, error_or_None)."""
    if not posts:
        return 0, 'empty_posts'
    try:
        first_id, _ = publish_single_post(posts[0]['content'])
    except Exception as e:
        return 0, f'first_post_failed: {e}'
    success = 1
    prev_id = first_id
    for post in posts[1:]:
        time.sleep(2)  # rate-limit buffer between containers
        try:
            reply_id = publish_reply(post['content'], reply_to_id=prev_id)
            prev_id = reply_id
            success += 1
        except Exception as e:
            return success, f'post_{post.get("seq", "?")}_failed: {e}'
    return success, None


# ── Concurrency control: lease + zombie sweep ────────────────────────────────

def now_tw_iso():
    return datetime.now(TW_OFFSET).isoformat()


ZOMBIE_ERROR = ('租約逾時（發文中斷）：可能已發出、也可能沒發出。請到 Threads 確認；'
                '沒發出再重新排程（為避免重複發文，系統不自動重試）')


def reset_zombie_leases(posts):
    """in_progress 租約逾時 → 標 failed，不自動改回 pending（2026-10-18 HQ 批次:B38 決定 2(a)）。

    卡在 in_progress 有兩種可能：發文前就當掉（沒發出），或發出了但最終狀態寫不回去（已發出）。
    程式分不出來；原本一律改回 pending ⇒ 後者會在下一次排程重發一次。改成交給人確認。"""
    now = datetime.now(TW_OFFSET)
    changed = False
    for p in posts:
        if p.get('status') != 'in_progress':
            continue
        lease_str = p.get('lease_acquired_at')
        if not lease_str:
            p['status'] = 'failed'
            p['error'] = ZOMBIE_ERROR
            p['failed_at'] = now_tw_iso()
            changed = True
            print(f'::warning::Zombie (no lease ts) → failed: {p["id"][:8]}', flush=True)
            continue
        try:
            lease_at = dateparser.parse(lease_str)
            if lease_at.tzinfo is None:
                lease_at = lease_at.replace(tzinfo=TW_OFFSET)
            if (now - lease_at).total_seconds() > LEASE_TIMEOUT_MINUTES * 60:
                p['status'] = 'failed'
                p['error'] = ZOMBIE_ERROR
                p['failed_at'] = now_tw_iso()
                p.pop('lease_acquired_at', None)
                changed = True
                print(f'::warning::Zombie lease (>{LEASE_TIMEOUT_MINUTES}min) → failed: {p["id"][:8]}', flush=True)
        except Exception as e:
            print(f'  Lease parse error on {p["id"][:8]}: {e}', flush=True)
    return changed


def acquire_lease(entry_id):
    """Atomic update: pending → in_progress with SHA. Returns True if claimed."""
    posts, sha = read_scheduled_file()
    target = next((p for p in posts if p.get('id') == entry_id), None)
    if not target or target.get('status') != 'pending':
        return False
    target['status'] = 'in_progress'
    target['lease_acquired_at'] = now_tw_iso()
    status = write_scheduled_file(posts, sha, f'lease: claim {entry_id[:8]}')
    return status in (200, 201)


def update_final_status(entry_id, final_status, **kwargs):
    """Update entry to final status, retry on SHA 409 up to N times."""
    for attempt in range(STATUS_UPDATE_RETRIES):
        posts, sha = read_scheduled_file()
        target = next((p for p in posts if p.get('id') == entry_id), None)
        if not target:
            print(f'  Status update: entry {entry_id[:8]} not found', flush=True)
            return False
        target['status'] = final_status
        target.pop('lease_acquired_at', None)
        if final_status == 'published':
            target['published_at'] = now_tw_iso()
            target['error'] = None
            if kwargs.get('reply_error'):
                target['reply_error'] = kwargs.get('reply_error')
        elif final_status == 'partially_published':
            target['published_count'] = kwargs.get('published_count')
            target['total_count'] = kwargs.get('total_count')
            target['error'] = kwargs.get('error')
            target['published_at'] = now_tw_iso()
        elif final_status == 'failed':
            target['error'] = kwargs.get('error')
            target['failed_at'] = now_tw_iso()
        status = write_scheduled_file(
            posts, sha,
            f'status: {entry_id[:8]} → {final_status}'
        )
        if status in (200, 201):
            return True
        print(f'  Status update SHA conflict (attempt {attempt+1}/{STATUS_UPDATE_RETRIES})', flush=True)
        time.sleep(2)
    print(f'::error::最終狀態寫不回 GitHub（{STATUS_UPDATE_RETRIES} 次）：{entry_id[:8]} → {final_status}。'
          f'租約逾時後會被標成 failed，請到 Threads 確認是否已發出', flush=True)
    WRITE_FAILURES.append(f'status {entry_id[:8]}')
    return False


# ── Main process flow ────────────────────────────────────────────────────────

def process_one_entry(entry):
    """Acquire lease → publish → update final status."""
    entry_id = entry.get('id')
    print(f'Processing {entry_id[:8]}...', flush=True)

    if not acquire_lease(entry_id):
        print(f'  Lease not acquired (taken by another runner or status changed); skipping.', flush=True)
        return

    final_status = 'published'
    extra = {}
    try:
        if entry.get('type') == 'thread':
            posts = entry.get('posts', [])
            count, err = publish_thread(posts)
            if err is None:
                final_status = 'published'
            elif count == 0:
                final_status = 'failed'
                extra['error'] = err
            else:
                final_status = 'partially_published'
                extra['published_count'] = count
                extra['total_count'] = len(posts)
                extra['error'] = err
        else:
            # Single post (legacy / API direct call)
            _, reply_err = publish_single_post(entry.get('content', ''), entry.get('reply_text'))
            final_status = 'published'
            if reply_err:
                extra['reply_error'] = reply_err
    except Exception as e:
        final_status = 'failed'
        extra['error'] = str(e)
        print(f'  ❌ Failed: {e}', flush=True)

    ok = update_final_status(entry_id, final_status, **extra)
    if final_status == 'published' and ok:
        print(f'  ✅ Success: {entry_id[:8]}', flush=True)
    elif final_status == 'published':
        print(f'  ⚠️ Published but status not saved: {entry_id[:8]}', flush=True)
    elif final_status == 'partially_published':
        print(f'  ⚠️ Partial: {extra.get("published_count")}/{extra.get("total_count")} for {entry_id[:8]}', flush=True)
    else:
        print(f'  ❌ Failed: {entry_id[:8]}', flush=True)


def cleanup_old_records():
    """Remove published/cancelled records older than HISTORY_DAYS."""
    posts, sha = read_scheduled_file()
    now = datetime.now(TW_OFFSET)
    cutoff = now - timedelta(days=HISTORY_DAYS)
    cutoff_iso = cutoff.isoformat()

    def keep(p):
        if p.get('status') in ('pending', 'in_progress'):
            return True
        # failed_at（2026-10-18 起）：沒有它時 failed 會退回 created_at，30 天前建的排程一失敗就被清掉
        ts = p.get('published_at') or p.get('failed_at') or p.get('cancelled_at') or p.get('created_at', '')
        return ts >= cutoff_iso

    new_posts = [p for p in posts if keep(p)]
    if len(new_posts) == len(posts):
        return
    status = write_scheduled_file(
        new_posts, sha,
        f'chore: cleanup records older than {HISTORY_DAYS} days'
    )
    if status in (200, 201):
        print(f'Cleaned {len(posts) - len(new_posts)} old records.', flush=True)
    else:
        print(f'::warning::清理舊紀錄寫回失敗（HTTP {status}），下次再清', flush=True)


def main():
    check_env()
    now_tw = datetime.now(TW_OFFSET)
    print(f'Run start: {now_tw.strftime("%Y-%m-%d %H:%M:%S TW")}', flush=True)

    # Step 1: Sweep zombie leases
    posts, sha = read_scheduled_file()
    if reset_zombie_leases(posts):
        zs = write_scheduled_file(posts, sha, 'chore: mark zombie leases failed')
        if zs not in (200, 201):
            print(f'::error::殭屍租約標 failed 寫回失敗（HTTP {zs}）', flush=True)
            WRITE_FAILURES.append('zombie')
        posts, sha = read_scheduled_file()

    # Step 2: Find due entries
    due = []
    for p in posts:
        if p.get('status') != 'pending':
            continue
        try:
            scheduled = dateparser.parse(p['scheduled_at'])
            if scheduled.tzinfo is None:
                scheduled = scheduled.replace(tzinfo=TW_OFFSET)
            if scheduled <= now_tw:
                due.append(p)
        except Exception as e:
            print(f'  Skipping malformed scheduled_at for {p.get("id","?")}: {e}', flush=True)

    if not due:
        print('No entries due. Cleanup and exit.', flush=True)
        cleanup_old_records()
        finish()
        return

    print(f'{len(due)} entry(ies) due for publishing.', flush=True)

    # Step 3: Process each due entry
    for entry in due:
        process_one_entry(entry)
        time.sleep(2)

    # Step 4: Cleanup
    cleanup_old_records()
    print('Run complete.', flush=True)
    finish()


def finish():
    if WRITE_FAILURES:
        print(f'::error::寫回 GitHub 失敗 {len(WRITE_FAILURES)} 處：{", ".join(WRITE_FAILURES)}', flush=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
