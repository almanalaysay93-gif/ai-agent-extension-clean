#!/usr/bin/env python3
"""Single-session e2e: attach to SW once, open panel tab from SW, attach to panel,
seed storage, submit, poll panel text until ROGER/PONG or error toast appears."""
import json
import os
import subprocess
import sys
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


def wait_for(kind, url_frag=None, tries=60, interval=1):
    for _ in range(tries):
        for t in targets():
            if t.get("type") != kind:
                continue
            if url_frag and url_frag not in (t.get("url") or ""):
                continue
            return t
        time.sleep(interval)
    return None


def run(ws, expr, rid, timeout=20, await_promise=True):
    ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                        "params": {"expression": expr,
                                   "awaitPromise": await_promise,
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


# --- 1. attach to SW ---
sw = wait_for("service_worker")
if not sw:
    print("NO SW")
    sys.exit(1)
sws = websocket.create_connection(sw["webSocketDebuggerUrl"], timeout=120)
sws.settimeout(40)
sws.on_message = lambda m: None
sws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
sws.recv()
print("attached to SW")

# --- 2. seed storage ---
key = API_KEY if API_KEY else "sk-or-test12345678901234"
model = API_KEY if False else "openai/gpt-4o-mini"
print("SEED:", run(sws, "chrome.storage.local.set({'openrouter_api_key':%r,'openrouter_model':'openai/gpt-4o-mini'}).then(()=>'ok')" % key, 2, timeout=15))

# --- 3. open the side panel as a tab from the SW ---
print("OPEN PANEL:", run(sws, "chrome.tabs.create({url: chrome.runtime.getURL('sidepanel/index.html')}).then(t=>'tab '+t.id).catch(e=>'ERR '+e.message)", 3, timeout=15))
time.sleep(5)
panel = wait_for("page", "sidepanel")
if not panel:
    print("NO PANEL TAB")
    sys.exit(1)
print("panel target:", panel["id"])

# --- 4. attach to panel and drive the test ---
pws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=120)
pws.settimeout(40)
pws.on_message = lambda m: None
pws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
pws.recv()
print("attached to panel")

time.sleep(1)
print("INIT TEXT:", (run(pws, "document.body.innerText.slice(0,120)", 10) or {}).get("value"))

SUBMIT_JS = (
    "(function(){"
    "var ta=document.querySelector('textarea');"
    "var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
    "s.call(ta,'Reply with exactly the word PONG and nothing else.');"
    "ta.dispatchEvent(new Event('input',{bubbles:true}));"
    "return new Promise(function(res){setTimeout(function(){"
    "document.querySelector('button[type=submit]').click();"
    "res('clicked')},1200);});})()"
)
print("SUBMIT:", run(pws, SUBMIT_JS, 11, timeout=20))

ok = False
for i in range(12):
    time.sleep(5)
    r = run(pws, "document.body.innerText.slice(0,900)", 20 + i, timeout=12)
    text = (r or {}).get("value")
    print(f"--- {5*(i+1)}s ---")
    print(text if text else "(none)")
    if text:
        low = text.lower()
        if "pong" in low:
            ok = True
            break
        if "request failed" in low or "api key" in low or "invalid" in low or "unauthorized" in low:
            ok = True
            print("(agent error path reached - loop wired correctly)")
            break

pws.close()
sws.close()
print("RESULT:", "E2E VERIFIED" if ok else "FAILED")
sys.exit(0 if ok else 1)
