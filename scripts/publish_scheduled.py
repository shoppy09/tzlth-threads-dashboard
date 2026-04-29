"""
publish_scheduled.py
Triggered by GitHub Actions every 30 minutes.
Reads data/scheduled-posts.json, publishes due posts to Threads, writes back.
Uses GITHUB_TOKEN (auto-provided by Actions) and THREADS_ACCESS_TOKEN (secret).
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
HISTORY_DAYS = 30  # Keep published/cancelled records for 30 days


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
    req = urllib.request.Request(url, data=body_bytes, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


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
    status, body = github_request('PUT', FILE_PATH, payload)
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
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def threads_get(path):
    url = f'{GRAPH_API}{path}&access_token={THREADS_TOKEN}' if '?' in path else f'{GRAPH_API}{path}?access_token={THREADS_TOKEN}'
    req = urllib.request.Request(url, headers={'User-Agent': 'tzlth-publisher'})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def get_user_id():
    me = threads_get('/me?fields=id')
    if 'id' not in me:
        raise RuntimeError(f'Could not get user ID: {me}')
    return me['id']


def publish_single_post(content, reply_text=None):
    """
    Publishes one post (and optional first-comment reply) to Threads.
    Returns the published post ID.
    Each container creation requires 30s wait — unavoidable per Threads API design.
    """
    user_id = get_user_id()

    # Step 1: Create main post container
    container = threads_post(f'/{user_id}/threads', {'text': content, 'media_type': 'TEXT'})
    if 'id' not in container:
        raise RuntimeError(f'Main container creation failed: {container}')
    container_id = container['id']

    # Step 2: Wait (Threads API requires processing time before publish)
    print(f'  Waiting 30s for container {container_id}...', flush=True)
    time.sleep(30)

    # Step 3: Publish main post
    result = threads_post(f'/{user_id}/threads_publish', {'creation_id': container_id})
    if 'id' not in result:
        raise RuntimeError(f'Publish failed: {result}')
    post_id = result['id']
    print(f'  Published main post: {post_id}', flush=True)

    # Step 4: Publish reply (first comment) if provided
    if reply_text and reply_text.strip():
        try:
            reply_container = threads_post(
                f'/{user_id}/threads',
                {'text': reply_text.strip(), 'media_type': 'TEXT', 'reply_to_id': post_id}
            )
            if 'id' in reply_container:
                print(f'  Waiting 30s for reply container...', flush=True)
                time.sleep(30)
                threads_post(f'/{user_id}/threads_publish', {'creation_id': reply_container['id']})
                print(f'  Reply published.', flush=True)
        except Exception as e:
            # Reply failure is non-fatal; main post already published
            print(f'  WARNING: Reply publish failed (main post OK): {e}', flush=True)

    return post_id


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    check_env()
    now_tw = datetime.now(TW_OFFSET)
    print(f'Run start: {now_tw.strftime("%Y-%m-%d %H:%M:%S TW")}', flush=True)

    posts, sha = read_scheduled_file()

    # Find posts due for publishing
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
            print(f'  Skipping malformed scheduled_at for {p.get("id")}: {e}', flush=True)

    if not due:
        print('No posts due. Exiting.', flush=True)
        return

    print(f'{len(due)} post(s) due for publishing.', flush=True)

    changed = False
    for post in due:
        pid = post.get('id', 'unknown')
        print(f'Publishing {pid[:8]}...', flush=True)
        try:
            publish_single_post(post['content'], post.get('reply_text'))
            post['status'] = 'published'
            post['published_at'] = now_tw.isoformat()
            post['error'] = None
            print(f'  ✅ Success', flush=True)
        except Exception as e:
            post['status'] = 'failed'
            post['error'] = str(e)
            print(f'  ❌ Failed: {e}', flush=True)
        changed = True
        time.sleep(2)  # Brief pause between posts to avoid rate limits

    if not changed:
        return

    # Cleanup: remove old published/cancelled records (keep pending + last 30 days)
    cutoff_str = (now_tw - timedelta(days=HISTORY_DAYS)).isoformat()
    posts = [
        p for p in posts
        if p['status'] == 'pending'
        or (p.get('published_at') or p.get('cancelled_at') or p.get('created_at', '')) >= cutoff_str
    ]

    # Write back with optimistic locking (sha prevents concurrent overwrites)
    status = write_scheduled_file(
        posts, sha,
        f'chore: publish scheduled posts {now_tw.strftime("%Y-%m-%d %H:%M")} TW'
    )
    if status in (200, 201):
        print('✅ scheduled-posts.json updated.', flush=True)
    elif status == 409:
        print('⚠️  SHA conflict: another process updated the file. Skipping commit.', flush=True)
    else:
        print(f'⚠️  Unexpected GitHub status: {status}', flush=True)


if __name__ == '__main__':
    main()
