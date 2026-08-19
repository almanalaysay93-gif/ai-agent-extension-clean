#!/bin/bash
echo "--- curl openrouter ---"
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" --max-time 15 https://openrouter.ai/api/v1/models
echo "--- curl from sandbox ---"
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" --max-time 15 https://example.com
