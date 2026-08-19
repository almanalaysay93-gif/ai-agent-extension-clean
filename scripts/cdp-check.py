#!/usr/bin/env python3
"""Attach to the extension service worker via CDP and report console errors."""
import json
import sys
import time
import urllib.request

import websocket

targets = json.load(urllib.request.urlopen("http://localhost:9333/json"))
sw = None
for t in targets:
    if t.get("type") == "service_worker":
        sw = t
        break
if not sw:
    print("No service worker target found")
    sys.exit(1)

ws_url = sw["webSocketDebuggerUrl"]
ws = websocket.create_connection(ws_url, timeout=10)

msgs = []

def on_message(message):
    data = json.loads(message)
    params = data.get("params", {})
    entry = params.get("entry", {})
    if data.get("method") == "Runtime.consoleAPICalled":
        msgs.append((entry.get("level"), entry.get("text")))

ws.on_message = on_message
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))

time.sleep(3)
ws.close()

if not msgs:
    print("No console messages from the service worker — it loaded cleanly.")
else:
    for level, text in msgs:
        print(f"[{level}] {text}")
    if any(level in ("error", "severe") for level, _ in msgs):
        sys.exit(1)
