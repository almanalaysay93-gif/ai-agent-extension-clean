// Post-build step: remove `crossorigin` attributes from extension page
// HTML. Extension resources can fail CORS checks in some Chromium builds
// (headless Chromium in particular), silently breaking JS/CSS loads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const pages = ['sidepanel/index.html', 'options/index.html'];

let changed = 0;
for (const rel of pages) {
  const file = path.join(distDir, rel);
  if (!fs.existsSync(file)) continue;
  let html = fs.readFileSync(file, 'utf8');
  const cleaned = html.replace(/\s*crossorigin/g, '');
  if (cleaned !== html) {
    fs.writeFileSync(file, cleaned);
    changed += 1;
  }
}
console.log(`strip-crossorigin: cleaned ${changed} page(s)`);
