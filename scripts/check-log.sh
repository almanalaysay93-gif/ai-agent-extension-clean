#!/bin/bash
tail -20 /tmp/chrome.log | grep -i "crash\|killed\|error\|extension\|assert" | head -15
echo "=== last 5 lines ==="
tail -5 /tmp/chrome.log
