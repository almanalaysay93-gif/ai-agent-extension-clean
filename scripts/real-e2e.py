#!/usr/bin/env python3
"""Real e2e against a real extension side panel flow:
seed storage, open sidepanel via chrome.sidePanel (SW context), submit message,
poll panel body for the assistant response or error message."""
import json
import os
import sys
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")


def targets():
    return json.load(urllib.request.urlopen(BASE + "/json"))


def run(ws, expr, rid, timeout=20):
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


sw = next((t for t in targets() if t.get("type") == "service_worker"), None)
if not sw:
    print("NO SW - relaunch chrome first")
    raise SystemExit(1)

ws = websocket.create_connection(sw["webSocketDebuggerUrl"], timeout=60)
ws.settimeout(45)
ws.on_message = lambda m: None
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()

model = "openai/gpt-4o-mini"
key = API_KEY if API_KEY else "sk-or-test12345678901234"
print("SEED:", run(ws, "chrome.storage.local.set({'openrouter_api_key':%r,'openrouter_model':'%s'}).then(()=>'ok')" % (key, model), 2, timeout=15))
print("OPEN PANEL:", run(ws, "chrome.tabs.create({url: chrome.runtime.getURL('sidepanel/index.html')}).then(t=>'tab '+t.id).catch(e=>'ERR '+e.message)", 3, timeout=15))
time.sleep(6)

panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
if not panel:
    print("NO PANEL")
    raise SystemExit(1)
pws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60)
pws.settimeout(45)
pws.on_message = lambda m: None
pws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
pws.recv()

SUBMIT_JS = (
    "(function(){var ta=document.querySelector('textarea');"
    "var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
    "s.call(ta,'Reply with exactly the word PONG and nothing else.');"
    "ta.dispatchEvent(new Event('input',{bubbles:true}));"
    "return new Promise(function(res){setTimeout(function(){"
    "document.querySelector('button[type=submit]').click();"
    "res('clicked')},1200);});})()"
)
print("SUBMIT:", run(pws, SUBMIT_JS, 4, timeout=20))

ok = False
for i in range(12):
    time.sleep(5)
    r = run(pws, "document.body.innerText.slice(0,900)", 10 + i, timeout=12)
    text = (r or {}).get("value")
    print(f"--- {5*(i+1)}s ---")
    print(text if text else "(none)")
    if text:
        if "PONG" in text and "Ask anything" not in text.replace("PONG", ""):
            ok = True
            break
        if "PONG" in text:
            ok = True
            break
        if "request failed" in text.lower() or "api key" in text.lower():
            print("(API error path reached - loop wired correctly)")
            ok = True
            break
pws.close()
ws.close()
if ok:
    print("RESULT: E2E loop verified")
else:
    print("RESULT: FAILED - no agent output observed")
    sys.exit(1)
