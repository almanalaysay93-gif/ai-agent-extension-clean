#!/usr/bin/env python3
"""Send SEND_MESSAGE from the SW's own CDP context immediately after launch."""
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
ws.settimeout(45)
ev = []


def on(m):
    d = json.loads(m)
    if d.get("method") == "Runtime.consoleAPICalled":
        ev.append(d["params"]["entry"]["text"])


ws.on_message = on
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()


def run(expression, rid, timeout=40):
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


print("SEED:", run("chrome.storage.local.set({'openrouter_api_key':'sk-or-test12345678901234','openrouter_model':'openai/gpt-4o-mini'}).then(()=>'ok')", 2, timeout=15))

# Send SEND_MESSAGE from the SW context itself (SW can receive its own messages?
# No — onMessage does not fire for self. Use a content script page instead.
# Better: open the sidepanel as an extension tab via SW context? SW can't open tabs...
# Actually SW has chrome.tabs.create access.
print("OPEN PANEL:", run(
    "chrome.tabs.create({url: chrome.runtime.getURL('sidepanel/index.html')}).then(t=>'tab '+t.id).catch(e=>'ERR '+e.message)", 3, timeout=15))
time.sleep(5)

targets_list = targets()
panel = next((t for t in targets_list if "sidepanel" in (t.get("url") or "")), None)
print("PANEL TARGET:", panel)
if panel:
    pws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60)
    pws.settimeout(20)
    pws.on_message = lambda m: None
    pws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
    pws.recv()
    # From the panel context, check chrome.runtime availability
    r = json.loads(pws.recv().__str__()) if False else None
    rid = 2
    pws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                         "params": {"expression": "typeof chrome !== 'undefined' ? chrome.runtime.id : 'NO_CHROME'",
                                    "returnByValue": True}}))
    dl = time.time() + 10
    while time.time() < dl:
        try:
            m = json.loads(pws.recv())
        except Exception:
            print("eof"); break
        if m.get("id") == rid:
            print("PANEL CHROME:", json.dumps(m.get("result", {}))[:150])
            break
    pws.close()

print("CONSOLE EVENTS:", ev)
ws.close()
