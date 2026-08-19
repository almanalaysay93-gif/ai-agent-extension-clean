#!/bin/bash
# Load the unpacked extension into headless Chromium and capture console output.
set -e
PROFILE=$(mktemp -d)
LOGFILE=$(mktemp)
/usr/bin/chromium \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --remote-debugging-port=9333 \
  --user-data-dir="$PROFILE" \
  --load-extension=/home/ubuntu/ai-agent-extension/dist \
  --disable-extensions-http-throttling \
  about:blank &
CHROME_PID=$!
sleep 6
# Dump console logs from the extension service worker and pages.
curl -s http://localhost:9333/json | python3 -c "
import json,sys
targets = json.load(sys.stdin)
for t in targets:
    print(t.get('type'), '|', t.get('title'), '|', t.get('url','')[:80])
"
sleep 2
kill $CHROME_PID 2>/dev/null
rm -rf "$PROFILE"
echo "LOG FILE: $LOGFILE"
