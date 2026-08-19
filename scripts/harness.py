#!/usr/bin/env python3
"""Reusable CDP harness using run_forever for reliable event dispatch."""
import json
import sys
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"


class CDP:
    def __init__(self, url):
        self.ws = websocket.WebSocketApp(url, on_message=self._on)
        self._results = {}
        self._events = []
        self._lock_done = None
        import threading
        self._thread = threading.Thread(target=self.ws.run_forever, daemon=True)
        self._thread.start()

    def _on(self, ws, message):
        try:
            m = json.loads(message)
        except Exception:
            return
        rid = m.get("id")
        if rid is not None:
            self._results[rid] = m.get("result")
        else:
            self._events.append(m)

    def send(self, expr, rid, await_promise=True, timeout=40):
        self.ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                                 "params": {"expression": expr,
                                            "awaitPromise": await_promise,
                                            "returnByValue": True}}))
        dl = time.time() + timeout
        while time.time() < dl and rid not in self._results:
            time.sleep(0.1)
        return self._results.get(rid)

    def console_texts(self):
        out = []
        for e in self._events:
            if e.get("method") == "Runtime.consoleAPICalled":
                out.append(e["params"]["entry"]["text"])
        return out

    def close(self):
        self.ws.close()


def targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "state":
        for t in targets():
            print(t.get("type"), t.get("id"), (t.get("url") or "")[:60])
    elif cmd == "panel-text":
        panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
        if not panel:
            print("NO PANEL")
            sys.exit(1)
        cdp = CDP(panel["webSocketDebuggerUrl"])
        time.sleep(1)
        print((cdp.send("document.body.innerText.slice(0,900)", 1) or {}).get("value"))
        cdp.close()
    elif cmd == "seed":
        panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
        cdp = CDP(panel["webSocketDebuggerUrl"])
        time.sleep(1)
        print(cdp.send("chrome.storage.local.set({'openrouter_api_key':'sk-or-test12345678901234','openrouter_model':'openai/gpt-4o-mini'}).then(()=>'ok')", 1))
        cdp.close()
    elif cmd == "submit":
        panel = next((t for t in targets() if "sidepanel" in (t.get("url") or "")), None)
        cdp = CDP(panel["webSocketDebuggerUrl"])
        time.sleep(1)
        js = (
            "(function(){"
            "var ta=document.querySelector('textarea');"
            "var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;"
            "s.call(ta,'Reply with exactly the word PONG and nothing else.');"
            "ta.dispatchEvent(new Event('input',{bubbles:true}));"
            "return new Promise(function(res){setTimeout(function(){"
            "document.querySelector('button[type=submit]').click();"
            "res('clicked')},1200);});})()"
        )
        print(cdp.send(js, 2, timeout=20))
        cdp.close()
