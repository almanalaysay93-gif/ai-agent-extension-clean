import json, time, urllib.request, websocket
BASE="http://localhost:9333"
def targets(): return json.load(urllib.request.urlopen(BASE+"/json"))
panel=next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
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
js1=("(function(){window.__sub=0;document.addEventListener('submit',function(e){e.preventDefault();window.__sub=1;});"
     "var ta=document.querySelector('textarea');"
     "var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
     "s.call(ta,'TestValue');"
     "ta.dispatchEvent(new Event('input',{bubbles:true}));"
     "return new Promise(function(res){setTimeout(function(){var btn=document.querySelector('button[type=submit]');btn.click();res('afterClick: sub='+window.__sub+' value='+ta.value+' btnDis='+btn.disabled)},2000);});})()")
print("R1:", run(js1, 2, timeout=15))
time.sleep(1)
print("TEXT:", (run("document.body.innerText.slice(0,250)", 3) or {}).get("value"))
ws.close()
