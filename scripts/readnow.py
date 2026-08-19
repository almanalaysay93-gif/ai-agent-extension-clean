#!/usr/bin/env python3
"""Read the panel body text right now."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
print("panel:", panel["id"] if panel else None)
ws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60)
ws.settimeout(20)
ws.on_message = lambda m: None
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()
rid = 2
ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                    "params": {"expression": "document.body.innerText.slice(0,200)",
                               "returnByValue": True}}))
dl = time.time() + 10
got = None
while time.time() < dl:
    try:
        m = json.loads(ws.recv())
    except Exception as e:
        print("exc", e)
        break
    if m.get("id") == rid:
        got = m.get("result")
print("GOT:", (got or {}).get("value") if isinstance(got, dict) else got)
ws.close()
