#!/bin/bash
# Launch Chromium with the unpacked extension, killing any previous instance first.
pkill -f "remote-debugging-port=9333" 2>/dev/null || true
sleep 1
rm -rf /tmp/ext-profile
mkdir -p /tmp/ext-profile
nohup /usr/bin/chromium \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --remote-debugging-port=9333 \
  --remote-allow-origins=* \
  --user-data-dir=/tmp/ext-profile \
  --load-extension=/home/ubuntu/ai-agent-extension/dist \
  --disable-extensions-http-throttling \
  --disable-logging \
  --enable-logging=stderr \
  --v=0 \
  about:blank --log-net-log=/tmp/netlog.json > /tmp/chrome.log 2>&1 &
sleep 5
curl -s http://localhost:9333/json | python3 -c "
import json,sys
for t in json.load(sys.stdin):
    print(t.get('type'), '|', (t.get('url') or '')[:90])
"
echo "--- LOG ERRORS ---"
grep -iE "service.?worker|background|uncaught|crash|extension" /tmp/chrome.log | head -10
