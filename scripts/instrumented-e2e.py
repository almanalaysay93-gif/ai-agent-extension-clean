#!/usr/bin/env python3
"""Instrumented e2e: seed key, submit from panel, dump every CDP frame + poll text."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
if not panel:
    print("NO PANEL")
    raise SystemExit(1)
ws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60)
ws.settimeout(15)
ws.on_message = lambda m: None
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()


def run(expression, rid, timeout=30):
    ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                        "params": {"expression": expression,
                                   "awaitPromise": True,
                                   "returnByValue": True}}))
    dl = time.time() + timeout
    frames = []
    while time.time() < dl:
        try:
            raw = ws.recv()
        except Exception:
            break
        try:
            m = json.loads(raw)
        except Exception:
            continue
        frames.append(m)
        if m.get("id") == rid:
            return m.get("result"), frames
    return {"error": "timeout"}, frames


def show_frames(frames):
    for m in frames:
        if m.get("method") == "Runtime.consoleAPICalled":
            print("  console:", m["params"]["entry"]["text"])
        elif m.get("method") == "Runtime.exceptionThrown":
            print("  EXC:", m["params"]["exceptionDetails"].get("text", "")[:120])
        elif m.get("id") is not None:
            r = m.get("result", {})
            print("  reply id=%s" % m["id"], json.dumps(r)[:160])


r, f = run("chrome.storage.local.set({'openrouter_api_key':'sk-or-test12345678901234','openrouter_model':'openai/gpt-4o-mini'}).then(()=>'ok')", 2)
print("SEED:", r)
show_frames(f)

r, f = run((
    "(()=>{const ta=document.querySelector('textarea');"
    "const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
    "s.call(ta,'Reply with exactly the word ROGER and nothing else.');"
    "ta.dispatchEvent(new Event('input',{bubbles:true}));"
    "return new Promise(res=>setTimeout(()=>{document.querySelector('button[type=submit]').click();res('clicked')},1500));})()"
), 3, timeout=20)
print("SUBMIT:", r)
show_frames(f)

for i in range(6):
    time.sleep(5)
    r, f = run("document.body.innerText.slice(0,700)", 10 + i)
    text = (r or {}).get("value")
    print(f"--- {5*(i+1)}s --- TEXT:", repr(text)[:200])
    show_frames(f)
    if text and "ROGER" in text:
        print("SUCCESS")
        break
ws.close()
