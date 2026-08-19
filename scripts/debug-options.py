#!/usr/bin/env python3
"""Debug the options page form submission via CDP."""
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


targets = json.load(urllib.request.urlopen(f"{BASE}/json"))
opts = next(t for t in targets if t.get("url", "").endswith("/options/index.html"))
ws = websocket.create_connection(opts["webSocketDebuggerUrl"], timeout=15)
ws.on_message = on_message
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()


def run(expression, rid, timeout=25):
    ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                        "params": {"expression": expression,
                                   "awaitPromise": True,
                                   "returnByValue": True}}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = json.loads(ws.recv())
        if msg.get("id") == rid:
            return msg.get("result")
    return {"error": "timeout"}


# Use React-compatible native setters.
r = run("""
(() => {
  const input = document.querySelector('#api-key');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'sk-or-test12345678901234');
  input.dispatchEvent(new Event('input', {bubbles: true}));
  const btn = document.querySelector('button[type=submit]');
  btn.click();
  return 'clicked, value now: ' + input.value;
})()
""", 10)
print("FORM:", r)

time.sleep(7)

r = run("document.body.innerText.slice(0, 500)", 11)
print("PAGE TEXT:", (r or {}).get("value"))
print("EVENTS:", events)

# Also verify storage directly.
r = run("chrome.storage.local.get('openrouter_api_key').then(d => JSON.stringify(d))", 12)
print("STORAGE:", r)
ws.close()
