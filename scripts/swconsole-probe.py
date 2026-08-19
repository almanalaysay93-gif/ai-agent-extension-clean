#!/usr/bin/env python3
"""Capture SW console events while a message is sent from the panel."""
import json
import time
import urllib.request
import websocket

BASE = "http://localhost:9333"

def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))

panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
sw = next((t for t in targets() if t.get("type") == "service_worker"), None)
print("panel:", bool(panel), "sw:", bool(sw))

# Attach to SW with console capture
sws = websocket.create_connection(sw["webSocketDebuggerUrl"], timeout=60)
sws.settimeout(40)
sw_events = []
def on(m):
    d = json.loads(m)
    if d.get("method") == "Runtime.consoleAPICalled":
        sw_events.append(d["params"]["entry"]["text"])
sws.on_message = on
sws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
sws.recv()

# From panel, send STOP
pws = websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60)
pws.settimeout(15)
pws.on_message = lambda m: None
pws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
pws.recv()
pws.send(json.dumps({"id": 5, "method": "Runtime.evaluate",
    "params": {"expression": "new Promise(r=>{chrome.runtime.sendMessage({type:'STOP'},rep=>r('rep='+JSON.stringify(rep)+' le='+JSON.stringify(chrome.runtime.lastError)));setTimeout(()=>r('TO'),6000)})",
    "awaitPromise": True, "returnByValue": True}}))
dl = time.time() + 8
while time.time() < dl:
    try: m = json.loads(pws.recv())
    except: break
    if m.get("id") == 5:
        print("PANEL REPLY:", json.dumps(m.get("result", {}))[:200])
pws.close()
time.sleep(1)
print("SW CONSOLE:", sw_events)
sws.close()
