#!/usr/bin/env python3
"""Debug side panel message sending via CDP (fresh rebuild)."""
import json
import time
import urllib.request

import websocket

BASE = "http://localhost:9333"
events = []


def on_message(ws, message):
    data = json.loads(message)
    params = data.get("params", {})
    entry = params.get("entry", {})
    if data.get("method") == "Runtime.consoleAPICalled":
        events.append((entry.get("level"), entry.get("text")))
    elif data.get("method") == "Runtime.exceptionThrown":
        exc = data.get("params", {}).get("exceptionDetails", {})
        events.append(("error", exc.get("text")))


def get_targets():
    return json.load(urllib.request.urlopen(f"{BASE}/json"))


def attach(target):
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=60)
    ws.settimeout(30)
    ws.on_message = on_message
    ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
    ws.recv()
    return ws


def run(ws, expression, rid, timeout=30):
    ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                        "params": {"expression": expression,
                                   "awaitPromise": True,
                                   "returnByValue": True}}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            msg = json.loads(ws.recv())
        except Exception as e:
            return {"error": str(e)}
        if msg.get("id") == rid:
            return msg.get("result")
    return {"error": "timeout"}


def main():
    targets = get_targets()
    ext_id = None
    for t in targets:
        url = t.get("url", "")
        if url.startswith("chrome-extension://"):
            ext_id = url.split("/")[2]
            break
    if not ext_id:
        print("Extension not loaded!")
        return

    # Close stale extension tabs and open a fresh sidepanel tab.
    for t in targets:
        url = t.get("url", "")
        if "sidepanel" in url or "options" in url:
            ws = attach(t)
            run(ws, "window.close()", 99, timeout=5)
            ws.close()
    time.sleep(1)

    ws = attach(next(t for t in get_targets() if (t.get("url") or "").startswith("about:")))
    ws.send(json.dumps({"id": 99, "method": "Target.createTarget",
                        "params": {"url": f"chrome-extension://{ext_id}/sidepanel/index.html"}}))
    ws.recv()
    ws.close()
    time.sleep(3)

    panel = next((t for t in get_targets() if "sidepanel/index.html" in (t.get("url") or "")), None)
    if not panel:
        print("Panel tab not found")
        return
    ws = attach(panel)

    # Set API key via storage from the panel context too (fresh profile).
    r = run(ws, "chrome.storage.local.set({'openrouter_api_key':'sk-or-test12345678901234','openrouter_model':'openai/gpt-4o-mini'}).then(()=>'ok')", 3)
    print("SEED:", r)

    r = run(ws, """
    (() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, 'Reply with exactly the word PONG and nothing else.');
      ta.dispatchEvent(new Event('input', {bubbles: true}));
      ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      return 'submitted';
    })()
    """, 4)
    print("SUBMIT:", r)

    for i in range(7):
        time.sleep(4)
        r = run(ws, "document.body.innerText.slice(0, 800)", 20 + i, timeout=15)
        text = (r or {}).get("value")
        print(f"--- t={4*(i+1)}s ---")
        print(text or "(none)")
        if text and ("PONG" in text or "PONG" in str(text)):
            print("SUCCESS: agent responded")
            break
    ws.close()
    print("EVENTS:")
    for lvl, txt in events[-15:]:
        print(f"[{lvl}] {str(txt)[:180]}")


if __name__ == "__main__":
    main()
