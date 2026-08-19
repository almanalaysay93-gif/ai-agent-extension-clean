#!/usr/bin/env python3
"""Verify panel state in current chrome session: set value, check button disabled after wait."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
ws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60)
ws.settimeout(25)
ws.on_message = lambda m: None
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()
rid = 7


def run(expr, timeout=20):
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


print("INIT:", (run("(() => { const ta = document.querySelector('textarea'); return 'val=' + ta.value + ' dis=' + document.querySelector('button[type=submit]').disabled; })()", 10) or {}).get("value"))

js = (
    "(function(){"
    "var ta=document.querySelector('textarea');"
    "var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
    "s.call(ta,'HelloTest');"
    "ta.dispatchEvent(new Event('input',{bubbles:true}));"
    "return new Promise(function(res){setTimeout(function(){"
    "res('val=' + ta.value + ' dis=' + document.querySelector('button[type=submit]').disabled)},1500);});})()"
)
print("AFTER SET:", (run(js, 10) or {}).get("value"))

# Now click submit and read text 2s later
js2 = (
    "(function(){"
    "document.querySelector('button[type=submit]').click();"
    "return new Promise(function(res){setTimeout(function(){res(document.body.innerText.slice(0,400))},2500);});})()"
)
print("AFTER CLICK:", (run(js2, 11) or {}).get("value"))
ws.close()
