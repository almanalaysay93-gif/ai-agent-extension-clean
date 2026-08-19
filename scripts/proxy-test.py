#!/usr/bin/env python3
"""Send a SEND_MESSAGE from a page context and watch for bg listener console log."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


t0 = targets()
about = next(t for t in t0 if (t.get("url") or "") == "about:blank")
ws = websocket.create_connection(about["webSocketDebuggerUrl"], timeout=60)
ws.settimeout(30)
ev = []


def on(m):
    d = json.loads(m)
    if d.get("method") == "Runtime.consoleAPICalled":
        ev.append(d["params"]["entry"]["text"])


ws.on_message = on
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()
rid = 1
ws.send(json.dumps({
    "id": rid, "method": "Runtime.evaluate",
    "params": {
        "expression": (
            "new Promise(res=>{"
            "chrome.runtime.onMessage.addListener((r,s)=>{"
            "if(s.tab)return;"
            "res('GOT: '+JSON.stringify(r));});"
            "chrome.runtime.sendMessage({type:'SEND_MESSAGE',payload:{text:'Say OK'}});"
            "setTimeout(()=>res('TIMEOUT'),12000);"
            "})"
        ),
        "awaitPromise": True, "returnByValue": True,
    },
}))
dl = time.time() + 15
while time.time() < dl:
    try:
        m = json.loads(ws.recv())
    except Exception:
        print("eof")
        break
    if m.get("id") == rid:
        print("RESULT:", m.get("result"))
print("BG CONSOLE LOGS:", ev)
time.sleep(3)
for t in targets():
    print(t.get("type"), t.get("id"), (t.get("url") or "")[:55])
ws.close()
