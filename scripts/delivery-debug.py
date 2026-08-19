#!/usr/bin/env python3
"""Check SW liveness and whether sendMessage delivery actually fails (lastError)."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


t0 = targets()
sw = next((t for t in t0 if t.get("type") == "service_worker"), None)
print("SW alive:", bool(sw))

panel = next((t for t in t0 if "sidepanel" in (t.get("url") or "")), None)
ws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60)
ws.settimeout(15)
ws.on_message = lambda m: None
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()


def run(expr, rid, timeout=20):
    ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                        "params": {"expression": expr,
                                   "awaitPromise": True,
                                   "returnByValue": True}}))
    dl = time.time() + timeout
    while time.time() < dl:
        try:
            m = json.loads(ws.recv())
        except Exception:
            return {"error": "eof"}
        if m.get("id") == rid:
            return m.get("result")
    return {"error": "timeout"}


# Test sendMessage delivery with explicit reply handling.
print("PING TEST:", run(
    "(function(){"
    "return new Promise(function(res){"
    "chrome.runtime.sendMessage({type:'STOP'}, function(reply){"
    "res('reply=' + JSON.stringify(reply) + ' lastError=' + JSON.stringify(chrome.runtime.lastError));"
    "});"
    "setTimeout(function(){res('TIMEOUT')},6000);"
    "});})()",
    2, timeout=15))
ws.close()
