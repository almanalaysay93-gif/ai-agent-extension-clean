#!/usr/bin/env python3
"""Verify that every asset referenced in dist HTML/JS exists on disk."""
import json
import os
import re
import sys

DIST = os.path.join(os.path.dirname(__file__), '..', 'dist')
errors = []
checked = 0

for root, _, files in os.walk(DIST):
    for f in files:
        if f.endswith(('.html', '.js', '.css', '.json')):
            path = os.path.join(root, f)
            with open(path, errors='replace') as fh:
                content = fh.read()
        else:
            continue
        # find referenced asset paths
        for ref in re.findall(r'["\'](assets/[^"\'\s]+)["\']', content):
            checked += 1
            target = os.path.join(DIST, ref)
            if not os.path.exists(target):
                errors.append(f'{path} -> {ref}')
        if f == 'service-worker-loader.js':
            for ref in re.findall(r"import '([^']+)'", content):
                checked += 1
                target = os.path.join(os.path.dirname(path), ref.lstrip('./'))
                if not os.path.exists(target):
                    errors.append(f'{path} -> {ref}')

# Check manifest content scripts + icons
m = json.load(open(os.path.join(DIST, 'manifest.json')))
for cs in m.get('content_scripts', []):
    for js in cs.get('js', []):
        checked += 1
        if not os.path.exists(os.path.join(DIST, js)):
            errors.append(f'manifest content_script -> {js}')
for size, icon in m.get('icons', {}).items():
    checked += 1
    if not os.path.exists(os.path.join(DIST, icon)):
        errors.append(f'manifest icon {size} -> {icon}')

print(f'Checked {checked} references.')
if errors:
    print('MISSING:')
    for e in errors:
        print(' -', e)
    sys.exit(1)
print('All referenced assets present.')
