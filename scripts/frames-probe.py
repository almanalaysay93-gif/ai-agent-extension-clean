#!/usr/bin/env python3
"""Inspect raw CDP frames from the panel target."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
print("panel:", panel["id"] if panel else None)
if not panel:
    raise SystemExit(1)
ws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60)
ws.settimeout(20)
ws.on_message = lambda m: None
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()
ws.send(json.dumps({"id": 7, "method": "Runtime.evaluate",
                    "params": {"expression": "document.body.innerText.slice(0,100)",
                               "returnByValue": True}}))
dl = time.time() + 8
while time.time() < dl:
    try:
        raw = ws.recv()
    except Exception as e:
        print("EXC", e)
        break
    try:
        m = json.loads(raw)
    except Exception:
        print("raw:", repr(raw)[:100])
        continue
    print("MSG:", json.dumps(m)[:300])
ws.close()
