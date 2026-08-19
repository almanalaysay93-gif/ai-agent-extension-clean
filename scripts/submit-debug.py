#!/usr/bin/env python3
"""Debug submit: capture panel console errors during submit, read text immediately after click."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
ws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60)
ws.settimeout(15)
errors = []
console = []


def on(m):
    d = json.loads(m)
    if d.get("method") == "Runtime.consoleAPICalled":
        console.append(d["params"]["entry"]["text"])
    if d.get("method") == "Runtime.exceptionThrown":
        errors.append(d["params"]["exceptionDetails"].get("text", "")[:150])


ws.on_message = on
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


# Reset storage first
print("SEED:", run("chrome.storage.local.set({'openrouter_api_key':'sk-or-test12345678901234','openrouter_model':'openai/gpt-4o-mini'}).then(()=>'ok')", 2, timeout=10))

# Set value + wait + click + immediately read innerText + state introspection
print("SUBMIT:", run(
    "(function(){var ta=document.querySelector('textarea');"
    "var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
    "s.call(ta,'Reply ROGER');ta.dispatchEvent(new Event('input',{bubbles:true}));"
    "return new Promise(function(res){setTimeout(function(){"
    "var btn=document.querySelector('button[type=submit]');"
    "var info='beforeClick disabled='+btn.disabled;"
    "btn.click();"
    "setTimeout(function(){res(info+' afterClick body='+document.body.innerText.slice(0,300).replace(/\\n/g,' | '))},300);"
    "},1500);});})()",
    3, timeout=20))

print("CONSOLE:", console[-10:])
print("ERRORS:", errors[-10:])

# Poll a bit more
for i in range(3):
    time.sleep(3)
    r = run("document.body.innerText.slice(0,300)", 10 + i)
    print(f"--- {3*(i+1)}s ---", (r or {}).get("value", "NONE"))
ws.close()
