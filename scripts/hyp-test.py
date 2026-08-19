import json, time, urllib.request, websocket
BASE="http://localhost:9333"
def targets(): return json.load(urllib.request.urlopen(BASE+"/json"))
panel=next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
print("panel url:", (panel.get("url") or "")[:80])
ws=websocket.create_connection(panel["webSocketDebuggerUrl"], timeout=60); ws.settimeout(15)
ws.on_message=lambda m: None
ws.send(json.dumps({"id":1,"method":"Runtime.enable"})); ws.recv()
def run(expr, rid, timeout=20):
    ws.send(json.dumps({"id":rid,"method":"Runtime.evaluate","params":{"expression":expr,"awaitPromise":True,"returnByValue":True}}))
    dl=time.time()+timeout
    while time.time()<dl:
        try: m=json.loads(ws.recv())
        except: return {"error":"eof"}
        if m.get("id")==rid: return m.get("result")
    return {"error":"timeout"}
print("A:", run("(() => { const ta = document.querySelector('textarea'); return 'value='+ta.value+' btnDisabled='+document.querySelector('button[type=submit]').disabled; })()", 2))
print("B:", run("(() => { const ta = document.querySelector('textarea'); const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; s.call(ta,'Test123'); ta.dispatchEvent(new Event('input',{bubbles:true})); return new Promise(res => setTimeout(() => res('valueAfter=' + ta.value + ' disabled=' + document.querySelector('button[type=submit]').disabled), 2000)); })()", 3, timeout=10))
ws.close()
