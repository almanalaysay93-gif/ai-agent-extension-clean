#!/usr/bin/env python3
"""Test chrome.runtime.connect from panel and chrome.tabs.sendMessage from SW."""
import json, time, urllib.request, websocket
BASE = "http://localhost:9333"
def targets(): return json.load(urllib.request.urlopen(BASE + "/json"))
def run(ws, expr, rid, timeout=20):
    ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                        "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}}))
    dl = time.time() + timeout
    while time.time() < dl:
        try: m = json.loads(ws.recv())
        except: return {"error": "eof"}
        if m.get("id") == rid: return m.get("result")
    return {"error": "timeout"}
panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
if not panel:
    print("NO PANEL")
    raise SystemExit(1)
sw = next((t for t in targets() if t.get("type") == "service_worker"), None)
ev = []
def on(m):
    d = json.loads(m)
    if d.get("method") == "Runtime.consoleAPICalled": ev.append(d["params"]["entry"]["text"])
sws = None
if sw:
    sws = websocket.create_connection(sw["webSocketDebuggerUrl"], timeout=60)
    sws.settimeout(30)
    sws.on_message = on
    sws.send(json.dumps({"id": 1, "method": "Runtime.enable"})); sws.recv()
pws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60); pws.settimeout(15)
pws.on_message = lambda m: None
pws.send(json.dumps({"id":1,"method":"Runtime.enable"})); pws.recv()
JS = ("new Promise(function(r){try{"
        "var p=chrome.runtime.connect({name:'probe'});"
        "p.onMessage.addListener(function(m){r('onMsg:'+JSON.stringify(m))});"
        "p.postMessage({type:'PROBE'});setTimeout(function(){r('TO')},5000);"
        "}catch(e){r('EXC '+e.message)}})")
print("PANEL CONNECT TEST:", run(pws, JS, 2, timeout=10))
print("SW EVENTS:", ev)
pws.close()
if sws:
    sws.close()
