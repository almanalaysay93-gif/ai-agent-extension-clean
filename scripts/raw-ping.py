#!/usr/bin/env python3
"""Print raw CDP response frames for a simple evaluate."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"
targets = json.load(urllib.request.urlopen(f"{BASE}/json"))
t = next((x for x in targets if "sidepanel" in (x.get("url") or "")), None)
ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=10)
ws.settimeout(6)
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.send(json.dumps({"id": 7, "method": "Runtime.evaluate",
                    "params": {"expression": "1+1", "returnByValue": True}}))
dl = time.time() + 5
while time.time() < dl:
    try:
        raw = ws.recv()
    except Exception as e:
        print("EXC", e)
        break
    try:
        m = json.loads(raw)
    except Exception:
        print("RAW:", repr(raw)[:200])
        continue
    print("FRAME:", json.dumps(m)[:250])
ws.close()
