#!/usr/bin/env python3
"""Send SEND_MESSAGE from the options page (a genuine extension context)."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


def attach(target):
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=60)
    ws.settimeout(40)
    ws.on_message = lambda m: None
    ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
    ws.recv()
    return ws


def run(ws, expression, rid, timeout=40):
    ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                        "params": {"expression": expression,
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


# Seed storage via the about blank page (storage API works in any origin)
about = next(t for t in targets() if (t.get("url") or "") == "about:blank")
ws = attach(about)
r = run(ws, "chrome.storage.local.set({'openrouter_api_key':'sk-or-test12345678901234','openrouter_model':'openai/gpt-4o-mini'}).then(()=>'ok')", 2)
print("SEED:", r)
ws.close()

# Open the options page in a new tab (extension context).
ws = attach(about)
ws.send(json.dumps({"id": 99, "method": "Target.createTarget",
                    "params": {"url": next(t for t in targets() if (t.get("url") or "").startswith("chrome-extension://"))["url"].rsplit("/", 1)[0] + "/options/index.html"}}))
ws.recv()
ws.close()
time.sleep(4)

opts = next((t for t in targets() if "options" in (t.get("url") or "")), None)
if not opts:
    print("options tab not found")
    raise SystemExit(1)
ws = attach(opts)

# Verify chrome.runtime exists in options context and send SEND_MESSAGE.
r = run(ws, "chrome.runtime.id + '::' + typeof chrome.runtime.sendMessage", 3)
print("CTX:", r)

r = run(ws, (
    "new Promise(res=>{"
    "chrome.runtime.onMessage.addListener((req,s)=>{"
    "if(s.tab)return;"
    "res('BG_REPLY:'+JSON.stringify(req).slice(0,100));});"
    "chrome.runtime.sendMessage({type:'SEND_MESSAGE',payload:{text:'Reply with OK'}});"
    "setTimeout(()=>res('TIMEOUT'),20000);"
    "})"
), 4, timeout=35)
print("MSG RESULT:", r)

# Also seed key AGAIN (options tab is different origin = same storage partition though; verify)
r = run(ws, "chrome.storage.local.get('openrouter_api_key').then(d=>JSON.stringify(d))", 5, timeout=15)
print("KEY IN STORAGE:", r)

time.sleep(6)
r = run(ws, "document.body.innerText.slice(0,300)", 6, timeout=12)
print("OPTIONS TEXT:", r)
ws.close()
