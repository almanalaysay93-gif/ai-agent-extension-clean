#!/usr/bin/env python3
"""End-to-end smoke test for the unpacked extension via CDP.

Steps:
1. Open the extension options page, save a dummy API key (sk-or-test12345678901234).
2. Open the side panel page.
3. Type a message and hit Enter.
4. Read console messages for evidence of the agentic loop (fetch errors to
   openrouter.ai are expected with a dummy key — the point is the loop runs).
"""
import json
import sys
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
        events.append((params.get("type"), entry.get("level"), entry.get("text")))


def attach(target):
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=15)
    ws.on_message = on_message
    ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
    ws.recv()  # enable ack
    return ws


def run_cmd(ws, expression, timeout=20):
    req_id = int(time.time() * 1000) % 100000
    ws.send(json.dumps({"id": req_id, "method": "Runtime.evaluate", "params": {"expression": expression,
                                   "awaitPromise": True,
                                   "returnByValue": True}}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = json.loads(ws.recv())
        if msg.get("id") == req_id:
            result = msg.get("result")
            return result if isinstance(result, dict) else {"raw": msg}
    return {"error": "timeout"}


def main():
    targets = json.load(urllib.request.urlopen(f"{BASE}/json"))
    ext_id = None
    for t in targets:
        url = t.get("url", "")
        if url.startswith("chrome-extension://"):
            ext_id = url.split("/")[2]
            break
    if not ext_id:
        print("Extension not loaded!")
        sys.exit(1)
    print("Extension id:", ext_id)

    # --- 1. Options page: save dummy key (open it first if not already open) ---
    opts = next((t for t in targets if t.get("url", "").endswith("/options/index.html")), None)
    if opts is None:
        about = next((t for t in targets if (t.get("url") or "").startswith("about:")), None)
        if about is None:
            print("No attachable target available")
            sys.exit(1)
        # Use CDP Target.createTarget to open the options page (tabs API is
        # extension-context only).
        ws = attach(about)
        ws.send(json.dumps({"id": 99, "method": "Target.createTarget",
                            "params": {"url": f"chrome-extension://{ext_id}/options/index.html"}}))
        ws.recv()
        ws.close()
        for _ in range(10):
            time.sleep(1.5)
            targets = json.load(urllib.request.urlopen(f"{BASE}/json"))
            if any(t.get("url", "").endswith("/options/index.html") for t in targets):
                break
        else:
            print("Options tab never appeared. Targets:")
            for t in targets:
                print(" -", t.get("type"), t.get("url"))
            sys.exit(1)
        opts = next(t for t in targets if t.get("url", "").endswith("/options/index.html"))
    ws = attach(opts)
    r = run_cmd(ws, """
    (async () => {
      const input = document.querySelector('#api-key');
      input.value = 'sk-or-test12345678901234';
      input.dispatchEvent(new Event('input', {bubbles: true}));
      document.querySelector('button[type=submit]').click();
      await new Promise(r => setTimeout(r, 6000));
      return document.body.innerText.slice(0, 600);
    })()
    """, timeout=30)
    if r.get("value") is not None:
        print("OPTIONS RESULT:", str(r.get("value"))[:300])
    else:
        print("OPTIONS RESULT (raw):", str(r)[:300])

    # --- 2. Open side panel via extension action click on a normal page ---
    # Navigate a normal tab, then open side panel with chrome.sidePanel API.
    page_target = next((t for t in targets if (t.get("url") or "").startswith("http")), None)
    if page_target is None:
        # open a normal page
        pass
    # Instead, directly open sidepanel html in a new tab for the smoke test:
    print("Opening side panel page...")
    ws.send(json.dumps({"id": 99, "method": "Target.createTarget",
                        "params": {"url": f"chrome-extension://{ext_id}/sidepanel/index.html"}}))
    ws.recv()
    ws.close()
    time.sleep(3)

    # --- 3. Interact with side panel ---
    targets = json.load(urllib.request.urlopen(f"{BASE}/json"))
    panel = next((t for t in targets if "sidepanel/index.html" in (t.get("url") or "")), None)
    if not panel:
        print("Side panel target not found; checking console events so far.")
    else:
        ws = attach(panel)
        # Re-enable console capture now that we're on the panel page.
        ws.send(json.dumps({"id": 2, "method": "Runtime.enable"}))
        ws.recv()
        r = run_cmd(ws, """
        (async () => {
          const ta = document.querySelector('textarea');
          ta.value = 'Summarize this page in one sentence.';
          ta.dispatchEvent(new Event('input', {bubbles: true}));
          ta.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
          await new Promise(r => setTimeout(r, 14000));
          return document.body.innerText.slice(0, 600);
        })()
        """, timeout=30)
        if r.get("value") is not None:
            print("PANEL AFTER SEND:", str(r.get("value"))[:600])
        else:
            print("PANEL AFTER SEND (raw):", str(r)[:400])
        ws.close()

    time.sleep(2)
    targets = json.load(urllib.request.urlopen(f"{BASE}/json"))
    # Collect any remaining console output from all extension contexts.
    print("\n--- Console events ---")
    for typ, level, text in events:
        if text:
            print(f"[{level}] {text[:200]}")
    if any("error" == lvl or "severe" == lvl for _, lvl, _ in events):
        print("\nSEVERE errors detected")
        sys.exit(1)
    print("\nDone.")


if __name__ == "__main__":
    main()
