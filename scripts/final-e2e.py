#!/usr/bin/env python3
"""Full e2e: open panel from SW context, seed key, send message, poll for agent response."""
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
sw_events = []


def on(m):
    d = json.loads(m)
    if d.get("method") == "Runtime.consoleAPICalled":
        sw_events.append(d["params"]["entry"]["text"])


ws.on_message = on
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()


def run(ws, expression, rid, timeout=40):
    ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                        "params": {"expression": expression,
                                   "awaitPromise": True,
                                   "returnByValue": True}}))
    dl = time.time() + timeout
    while time.time() < dl:
        try:
            raw = ws.recv()
        except Exception:
            return {"error": "eof"}
        try:
            m = json.loads(raw)
        except Exception:
            print("non-json frame:", repr(raw)[:80])
            continue
        if m.get("id") == rid:
            return m.get("result")
        if rid >= 10 and m.get("method"):
            print("  evt:", m.get("method"))
    return {"error": "timeout"}


print("SEED:", run(ws, "chrome.storage.local.set({'openrouter_api_key':'sk-or-test12345678901234','openrouter_model':'openai/gpt-4o-mini'}).then(()=>'ok')", 2, timeout=15))
print("OPEN PANEL:", run(ws, "chrome.tabs.create({url: chrome.runtime.getURL('sidepanel/index.html')}).then(t=>'tab '+t.id).catch(e=>'ERR '+e.message)", 3, timeout=15))
time.sleep(5)

panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
pws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60)
pws.settimeout(45)
pws.on_message = lambda m: None
pws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
pws.recv()

print("SUBMIT:", run(pws, (
    "(()=>{const ta=document.querySelector('textarea');"
    "const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
    "s.call(ta,'Reply with exactly the word ROGER and nothing else.');"
    "ta.dispatchEvent(new Event('input',{bubbles:true}));"
    "document.querySelector('button[type=submit]').click();"
    "return 'clicked'})()"
), 4, timeout=15))

print("TARGETS RIGHT AFTER SUBMIT:")
for t in targets():
    print(" ", t.get("type"), t.get("id"), (t.get("url") or "")[:55])

for i in range(7):
    time.sleep(4)
    r = run(pws, "document.body.innerText.slice(0,700)", 10 + i, timeout=12)
    text = (r or {}).get("value") if isinstance(r, dict) else None
    print(f"--- {4*(i+1)}s ---", "TEXT:", text)
    if text and "ROGER" in text:
        print("SUCCESS: agent answered!")
        break
    if text and ("Error" in text or "error" in text.lower()) and "missing" in text.lower():
        print("API KEY ERROR (expected with dummy key) — loop works!")
        break
pws.close()
print("BG CONSOLE EVENTS:", sw_events[-8:])
ws.close()
