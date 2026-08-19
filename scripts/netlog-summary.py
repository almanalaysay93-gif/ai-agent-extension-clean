#!/usr/bin/env python3
"""Summarize openrouter requests in the net log (method, status)."""
import json
import re

txt = open('/tmp/netlog.json', errors='ignore').read()
# net log is line-delimited JSON; parse what we can
ok = 0
for line in txt.splitlines():
    line = line.strip()
    if not line.startswith('{'):
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    p = e.get('params') or {}
    url = p.get('url', '')
    if 'openrouter' in url and e.get('type') == 'HTTP_TRANSACTION_READ_HEADERS':
        status = (p.get('headers') or {}).get('response_line', '')
        ok += 1
        print('RESPONSE:', url[:80], status[:60])
print('total response events:', ok)
