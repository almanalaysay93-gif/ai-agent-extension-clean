#!/usr/bin/env python3
"""Check current target state."""
import json
import urllib.request

BASE = "http://localhost:9333"
for t in json.load(urllib.request.urlopen(f"{BASE}/json")):
    print(t.get("type"), t.get("id"), (t.get("url") or "")[:60])
