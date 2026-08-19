#!/usr/bin/env python3
"""Ping every page target with a simple expression to find which are alive."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"
targets = json.load(urllib.request.urlopen(f"{BASE}/json"))
for t in targets:
    if t.get("type") != "page":
        continue
    try:
        ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=10)
        ws.settimeout(6)
        ws.on_message = lambda m: None
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                            "params": {"expression": "1+1", "returnByValue": True}}))
        got = None
        dl = time.time() + 5
        while time.time() < dl:
            try:
                m = json.loads(ws.recv())
            except Exception as e:
                got = "EXC " + str(e)[:40]
                break
            if m.get("id") == 1:
                got = "OK " + str(m.get("result", {}).get("value"))
                break
        ws.close()
    except Exception as e:
        got = "CONN_FAIL " + str(e)[:40]
    print(t.get("id"), (t.get("url") or "")[:50], "->", got)
