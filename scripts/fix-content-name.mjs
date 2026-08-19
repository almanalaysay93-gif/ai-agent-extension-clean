// Post-build step: give the content script chunk a stable filename so the
// background service worker can always inject it by name
// (chrome.scripting.executeScript does not accept hashed filenames).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const manifestPath = path.join(distDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const assetsDir = path.join(distDir, 'assets');
const files = fs.readdirSync(assetsDir);

// Content chunk is the index.ts-*.js file registered in content_scripts.
let hashed = null;
for (const entry of manifest.content_scripts) {
  for (const js of entry.js) {
    const name = path.basename(js);
    if (files.includes(name)) {
      hashed = name;
      break;
    }
  }
  if (hashed) break;
}
if (!hashed) {
  console.error('content chunk not found in assets:', files);
  process.exit(1);
}

const stableName = 'content-script.js';
const src = path.join(assetsDir, hashed);
const dst = path.join(assetsDir, stableName);
fs.copyFileSync(src, dst);

// Register the stable name alongside the hashed one (keeps auto-injection
// working and lets the background inject the same code by stable name).
for (const entry of manifest.content_scripts) {
  if (!entry.js.includes(`assets/${stableName}`)) {
    entry.js.push(`assets/${stableName}`);
  }
}
if (manifest.web_accessible_resources) {
  for (const war of manifest.web_accessible_resources) {
    if (!war.resources.includes(`assets/${stableName}`)) {
      war.resources.push(`assets/${stableName}`);
    }
  }
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`content chunk ${hashed} -> assets/${stableName} (manifest updated)`);
