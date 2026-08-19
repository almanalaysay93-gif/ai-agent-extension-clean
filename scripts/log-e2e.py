#!/usr/bin/env python3
"""Log-based e2e: seed, submit, then inspect chrome.log for OpenRouter network activity."""
import json
import os
import re
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


sw = wait_for("service_worker")
if not sw:
    print("NO SW"); sys.exit(1)
sws = websocket.create_connection(sw["webSocketDebuggerUrl"], timeout=120)
sws.settimeout(40)
sws.on_message = lambda m: None
sws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
sws.recv()

key = API_KEY if API_KEY else "sk-or-v1-12345678901234567890123456789012"
print("SEED:", run(sws, "chrome.storage.local.set({'openrouter_api_key':%r,'openrouter_model':'openai/gpt-4o-mini'}).then(()=>'ok')" % key, 2, 15))
print("OPEN PANEL:", run(sws, "chrome.tabs.create({url: chrome.runtime.getURL('sidepanel/index.html')}).then(t=>'tab '+t.id).catch(e=>'ERR '+e.message)", 3, 15))
time.sleep(5)

panel = wait_for("page", "sidepanel")
if not panel:
    print("NO PANEL"); sys.exit(1)
pws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=120)
pws.settimeout(40)
pws.on_message = lambda m: None
pws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
pws.recv()

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
print("Waiting for agent loop network activity...")
time.sleep(40)
pws.close()
sws.close()
