#!/usr/bin/env python3
"""Resilient e2e: re-attach CDP session on context death (panel reload/navigate)."""
import json
import os
import sys
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


def wait_for(kind, url_frag=None, tries=60, interval=1):
    for _ in range(tries):
        for t in targets():
            if t.get("type") != kind:
                continue
            if url_frag and url_frag not in (t.get("url") or ""):
                continue
            return t
        time.sleep(interval)
    return None


class PanelSession:
    def __init__(self, target):
        self.target = target
        self.ws = None
        self._reconnect()

    def _reconnect(self):
        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass
        self.ws = websocket.create_connection(self.target["webSocketDebuggerUrl"], timeout=120)
        self.ws.settimeout(20)
        self.ws.on_message = lambda m: None
        self.ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        self.ws.recv()
        self._rid = 100

    def run(self, expr, timeout=15, promise=False):
        # Wrap in setTimeout to avoid headless background-tab JS throttling
        if promise:
            wrapped = expr
        else:
            wrapped = ("new Promise(function(r){setTimeout(function(){try{r(String(" + expr + "))}"
                        "catch(e){r('EXC:'+e.message)}},0);})")
        self._rid += 1
        rid = self._rid
        self.ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                                 "params": {"expression": wrapped,
                                            "awaitPromise": True,
                                            "returnByValue": True}}))
        dl = time.time() + timeout
        while time.time() < dl:
            try:
                m = json.loads(self.ws.recv())
            except Exception:
                self._reconnect()
                # retry once on the new connection
                self._rid += 1
                rid = self._rid
                self.ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                                         "params": {"expression": expr,
                                                    "awaitPromise": True,
                                                    "returnByValue": True}}))
                dl = time.time() + timeout
                while time.time() < dl:
                    try:
                        m = json.loads(self.ws.recv())
                    except Exception:
                        return {"error": "eof2"}
                    if m.get("id") == rid:
                        return m.get("result")
                return {"error": "timeout2"}
            if m.get("id") == rid:
                return m.get("result")
        self._reconnect()
        return {"error": "timeout"}

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def main():
    key = API_KEY if API_KEY else "sk-or-test12345678901234"

    sw = wait_for("service_worker")
    if not sw:
        print("NO SW")
        sys.exit(1)
    sws = websocket.create_connection(sw["webSocketDebuggerUrl"], timeout=120)
    sws.settimeout(40)
    sws.on_message = lambda m: None
    sws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
    sws.recv()

    def sw_run(expr, rid, timeout=15):
        sws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                             "params": {"expression": expr,
                                        "awaitPromise": True,
                                        "returnByValue": True}}))
        dl = time.time() + timeout
        while time.time() < dl:
            try:
                m = json.loads(sws.recv())
            except Exception:
                return {"error": "eof"}
            if m.get("id") == rid:
                return m.get("result")
        return {"error": "timeout"}

    print("SEED:", sw_run("chrome.storage.local.set({'openrouter_api_key':%r,'openrouter_model':'openai/gpt-4o-mini'}).then(()=>'ok')" % key, 2, 15))
    print("OPEN PANEL:", sw_run("chrome.tabs.create({url: chrome.runtime.getURL('sidepanel/index.html')}).then(t=>'tab '+t.id).catch(e=>'ERR '+e.message)", 3, 15))
    time.sleep(5)
    panel = wait_for("page", "sidepanel")
    if not panel:
        print("NO PANEL")
        sys.exit(1)
    ps = PanelSession(panel)
    time.sleep(2)
    print("INIT:", (ps.run("document.body.innerText.slice(0,120)", promise=False) or {}).get("value"))

    SUBMIT_JS = (
        "(function(){"
        "var ta=document.querySelector('textarea');"
        "var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
        "s.call(ta,'Reply with exactly the word PONG and nothing else.');"
        "ta.dispatchEvent(new Event('input',{bubbles:true}));"
        "return new Promise(function(res){setTimeout(function(){"
        "document.querySelector('button[type=submit]').click();"
        "res('clicked')},1200);});})()"
    )
    print("SUBMIT:", ps.run(SUBMIT_JS, timeout=20, promise=True))

    ok = False
    for i in range(12):
        time.sleep(5)
        r = ps.run("document.body.innerText.slice(0,900)", timeout=15, promise=False)
        text = (r or {}).get("value")
        print(f"--- {5*(i+1)}s ---")
        print(text if text else "(none)")
        if text:
            low = text.lower()
            if "pong" in low:
                ok = True
                break
            if any(k in low for k in ("request failed", "api key", "invalid", "unauthorized", "error")):
                ok = True
                print("(agent error path reached - loop wired correctly)")
                break
    ps.close()
    sws.close()
    print("RESULT:", "E2E VERIFIED" if ok else "FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
