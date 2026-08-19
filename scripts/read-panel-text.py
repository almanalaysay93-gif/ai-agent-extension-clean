#!/usr/bin/env python3
"""Read the side panel's innerText (setTimeout-wrapped to survive headless throttling)."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"

targets = json.load(urllib.request.urlopen(f"{BASE}/json"))
t = next((x for x in targets if "sidepanel" in (x.get("url") or "")), None)
if not t:
    print("no panel tab")
    raise SystemExit(1)

ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=30)
ws.settimeout(20)
ws.on_message = lambda m: None
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()

expr = (
    "new Promise(function(r){setTimeout(function(){try{"
    "r(String(document.body.innerText.slice(0,800)))}catch(e){r('EXC:'+e.message)}},0);})"
)
ws.send(json.dumps({"id": 7, "method": "Runtime.evaluate",
                    "params": {"expression": expr,
                               "awaitPromise": True,
                               "returnByValue": True}}))
dl = time.time() + 18
out = None
while time.time() < dl:
    try:
        m = json.loads(ws.recv())
    except Exception as e:
        out = "recv-error: " + str(e)[:60]
        break
    if m.get("id") == 7:
        res = m.get("result") or {}
        out = res.get("value")
        break
ws.close()
print(out if out is not None else "timeout")
