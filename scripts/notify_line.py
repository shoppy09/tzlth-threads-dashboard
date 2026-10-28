#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
notify_line.py — Threads 排程發文的 LINE 通知（HQ RCF-278，2026-10-28；HQ routine-automation-sop.md 第五節 f）

只推給 Tim（LINE_ADMIN_USER_ID）。規則照官網 notify_line.py（RCF-270）與 HQ cron_health_notify.py（RCF-262）：
  - 主帳號每月 200 則、與預約客戶提醒共用 ⇒ 每次推之前向 LINE API 查本月總用量，> 150 則不推（::warning:: 留 log）
    （用量是 LINE 端的單一數字，總部、官網、看板看到的是同一個，不會各算各的）
  - 平時只推異常；空跑期另有週日彙總（Tim 2026-10-28 D3）
  - 訊息只放日期、標題前 12 字與原因，不放貼文全文（全文看看板「排程」分頁或 Actions 摘要）
推送失敗或缺密鑰（而且有事要推）→ 回傳 1 ⇒ job 紅 ⇒ 至少還有 GitHub 失敗信。

用法（workflow）：
  python scripts/notify_line.py --event failure --workflow publish-scheduled.yml   # if: failure()
  python scripts/notify_line.py --event test
  python scripts/notify_line.py --selftest
程式內：from notify_line import send; send(['訊息'…])
"""

import argparse
import json
import os
import subprocess
import sys
from urllib import request as urequest
from urllib.error import HTTPError, URLError

QUOTA_GUARD = 150
MSG_LIMIT = 1500
TEST_MSG = '🧪 Threads 排程通知測試（RCF-278）：收到這則代表推播路徑正常，不需回覆。'
FAIL_MSG = '🔴 Threads 排程（{wf}）執行失敗，今天的串文可能沒發或沒比對。在對話說「查 Threads 排程」。'


def line_quota_used(token, opener=urequest.urlopen):
    req = urequest.Request('https://api.line.me/v2/bot/message/quota/consumption',
                           headers={'Authorization': f'Bearer {token}'})
    try:
        with opener(req, timeout=15) as r:
            return int(json.loads(r.read().decode('utf-8')).get('totalUsage'))
    except (HTTPError, URLError, ValueError, TypeError, OSError):
        return None


def line_push(token, to, text, opener=urequest.urlopen):
    body = json.dumps({'to': to, 'messages': [{'type': 'text', 'text': text}]}, ensure_ascii=False).encode('utf-8')
    req = urequest.Request('https://api.line.me/v2/bot/message/push', data=body, method='POST',
                           headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    try:
        with opener(req, timeout=15) as r:
            return r.status
    except HTTPError as e:
        return e.code
    except (URLError, OSError):
        return 0


def send(msgs, token=None, to=None, quota_fn=line_quota_used, push_fn=line_push):
    token = os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', '') if token is None else token
    to = os.environ.get('LINE_ADMIN_USER_ID', '') if to is None else to
    if not msgs:
        print('沒有要推的通知')
        return 0
    joined = '／'.join(msgs)
    if not token or not to:
        print('::error::有通知要推，但缺 LINE_CHANNEL_ACCESS_TOKEN 或 LINE_ADMIN_USER_ID：' + joined)
        return 1
    used = quota_fn(token)
    if used is not None and used > QUOTA_GUARD:
        print(f'::warning::LINE 主帳號本月已用 {used} 則（>{QUOTA_GUARD}），不推；通知內容：' + joined)
        return 0
    text = '\n\n'.join(msgs)
    if len(text) > MSG_LIMIT:
        text = text[:MSG_LIMIT - 1] + '…'
    status = push_fn(token, to, text)
    if status != 200:
        print(f'::error::LINE 推送失敗（HTTP {status}）：' + joined)
        return 1
    print(f'✅ 已推 LINE（{len(msgs)} 則合併成 1 則；本月已用 {used}）')
    return 0


def consecutive_failures(runs, current_id):
    n = 1
    for r in runs:
        if str(r.get('databaseId')) == str(current_id) or r.get('status') != 'completed':
            continue
        if r.get('conclusion') == 'failure':
            n += 1
        else:
            break
    return n


def gh_runs(workflow):
    repo = os.environ.get('GITHUB_REPOSITORY', '')
    r = subprocess.run(['gh', 'run', 'list', '-R', repo, '-w', workflow, '-L', '6',
                        '--json', 'databaseId,status,conclusion'], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        print(f'::warning::讀不到前幾次執行結果，照推：{r.stderr.strip()[:200]}')
        return []
    return json.loads(r.stdout)


def selftest():
    fails = 0

    def ck(name, got, want):
        nonlocal fails
        ok = got == want
        fails += not ok
        print(f"{'PASS' if ok else 'FAIL'}｜{name}｜預期 {want!r} 實得 {got!r}")

    sent = []
    ok_push = lambda tk, to, text: sent.append(text) or 200
    ck('額度超過不推、不算錯', send(['m'], 't', 'u', lambda tk: 151, ok_push), 0)
    ck('額度超過時沒有真的推', len(sent), 0)
    ck('額度 150 照推', send(['m'], 't', 'u', lambda tk: 150, ok_push), 0)
    ck('讀不到額度照推', send(['m'], 't', 'u', lambda tk: None, ok_push), 0)
    ck('推送失敗 → 1', send(['m'], 't', 'u', lambda tk: 10, lambda *a: 500), 1)
    ck('缺密鑰且有事要推 → 1', send(['m'], '', 'u'), 1)
    ck('沒事要推 → 0', send([], '', ''), 0)
    ok_run = {'databaseId': 1, 'status': 'completed', 'conclusion': 'success'}
    bad = lambda i: {'databaseId': i, 'status': 'completed', 'conclusion': 'failure'}
    ck('連續第 1 次失敗', consecutive_failures([ok_run], 99), 1)
    ck('連續第 3 次失敗', consecutive_failures([bad(3), bad(2), ok_run], 99), 3)
    print('合計：' + ('全部通過' if not fails else f'{fails} 項失敗'))
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--event', choices=['failure', 'test'])
    ap.add_argument('--workflow', default='publish-scheduled.yml')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if a.event == 'test':
        return send([TEST_MSG])
    if a.event == 'failure':
        n = consecutive_failures(gh_runs(a.workflow), os.environ.get('GITHUB_RUN_ID', ''))
        return send([FAIL_MSG.format(wf=a.workflow)] if n in (1, 3) else [])
    ap.error('需要 --event 或 --selftest')


if __name__ == '__main__':
    sys.exit(main())
