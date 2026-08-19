#!/usr/bin/env python3
"""Attach to SW via CDP, capture console, run a console.log probe."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


sw = next((t for t in targets() if t.get("type") == "service_worker"), None)
if not sw:
    print("NO SW")
    raise SystemExit(1)
ws = websocket.create_connection(sw["webSocketDebuggerUrl"], timeout=60)
ws.settimeout(30)
ev = []


def on(m):
    d = json.loads(m)
    if d.get("method") == "Runtime.consoleAPICalled":
        ev.append(d["params"]["entry"]["text"])


ws.on_message = on
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()
rid = 1
ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                    "params": {"expression": "console.log('SW PROBE'); chrome.runtime.id",
                               "returnByValue": True}}))
dl = time.time() + 10
while time.time() < dl:
    try:
        m = json.loads(ws.recv())
    except Exception:
        print("eof")
        break
    if m.get("id") == rid:
        print("RESULT:", json.dumps(m.get("result", {}))[:200])
print("EVENTS:", ev)
ws.close()
