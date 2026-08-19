#!/usr/bin/env python3
"""Drive the agentic loop directly from the service worker CDP target."""
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
    if data.get("method") == "Inspector.targetCrashed":
        events.append(("crash", "target crashed"))
    elif data.get("method") == "Runtime.exceptionThrown":
        exc = data.get("params", {}).get("exceptionDetails", {})
        events.append(("error", exc.get("text") + ": " + str(exc.get("exception", {}).get("description", ""))[:200]))


sw = None
# Wake the service worker by opening the extension options page first.
try:
    about = next(t for t in json.load(urllib.request.urlopen(f"{BASE}/json")) if (t.get("url") or "").startswith("about:"))
    tmp = websocket.create_connection(about["webSocketDebuggerUrl"], timeout=15)
    tmp.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                         "params": {"expression": "1+1", "returnByValue": True}}))
    tmp.recv(); tmp.close()
except Exception:
    pass
time.sleep(1)
for _ in range(12):
    targets = json.load(urllib.request.urlopen(f"{BASE}/json"))
    sw = next((t for t in targets if t.get("type") == "service_worker"), None)
    if sw:
        break
    time.sleep(2)
if not sw:
    print("Service worker target never appeared")
    raise SystemExit(1)
ws = websocket.create_connection(sw["webSocketDebuggerUrl"], timeout=60)
ws.on_message = on_message
ws.settimeout(30)
ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
ws.recv()


def run(expression, rid, timeout=40):
    ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                        "params": {"expression": expression,
                                   "awaitPromise": True,
                                   "returnByValue": True}}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            msg = json.loads(ws.recv())
        except Exception as e:
            return {"error": f"recv failed: {e}"}
        if msg.get("id") == rid:
            return msg.get("result")
    return {"error": "timeout"}


# Seed storage with the dummy API key (profile was reset on relaunch).
r = run("chrome.storage.local.set({'openrouter_api_key':'sk-or-test12345678901234','openrouter_model':'openai/gpt-4o-mini'}).then(() => 'set')", 4)
print("SEED STORAGE:", r)

# Confirm storage contents from SW context.
r = run("chrome.storage.local.get(['openrouter_api_key','openrouter_model']).then(d => JSON.stringify(d))", 5)
print("SW STORAGE:", r)

# Check active tab exists for getPageContext.
r = run("chrome.tabs.query({active: true, currentWindow: true}).then(tabs => JSON.stringify(tabs.map(t => t.id)))", 6)
print("ACTIVE TABS:", r)

# Send a SEND_MESSAGE request to the SW like the panel would, watching events.
r = run("""
new Promise(resolve => {
  const seen = [];
  chrome.runtime.onMessage.addListener(function listener(req, sender) {
    if (sender.tab !== undefined) return;
    if (!req || !req.type) return;
    seen.push(req.type + '::' + JSON.stringify(req.payload || {}).slice(0, 120));
    if (req.type === 'MESSAGE_COMPLETE' && req.payload && String(req.payload.text).includes('PING')) {
      chrome.runtime.onMessage.removeListener(listener);
      resolve(seen.join(' | '));
    }
  });
  try {
    chrome.runtime.sendMessage({type: 'SEND_MESSAGE', payload: {text: 'Reply with exactly the word PING and nothing else.'}});
  } catch (e) {
    seen.push('THREW: ' + e.message);
  }
  setTimeout(() => resolve('TIMEOUT events: ' + seen.join(' | ')), 20000);
})
""", 7, timeout=40)
print("LOOP RESULT:", r)

time.sleep(2)
print("CONSOLE EVENTS:")
for lvl, text in events[-20:]:
    print(f"[{lvl}] {str(text)[:200]}")
if not events:
    print("(no events captured — sendMessage may not have been delivered)")
ws.close()
