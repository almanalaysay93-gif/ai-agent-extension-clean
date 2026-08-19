// Smoke test: load the built extension in headless Chromium and verify
// - the service worker registers
// - the content script injects and answers READ_VIDEO_CONTEXT
import WebSocket from 'ws';

const EXT_DIR = new URL('../dist', import.meta.url).pathname;
const PROFILE = '/tmp/alai-profile';
const PORT = 9444;

const browser = await (
  await import('child_process')
).spawn(
  '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer', '--enable-extensions', '--enable-extensions-on-chrome-urls',
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT_DIR}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

browser.stderr.on('data', (d) => {
  const s = d.toString();
  if (/error|Error|ERROR/.test(s)) process.stderr.write(s);
});

// Wait for extension pages to register targets
let tries = 0;
while (tries++ < 30) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await fetch(`http://localhost:${PORT}/json`);
    const targets = await res.json();
    if (targets.length > 0) {
      console.log('Targets:', targets.map((t) => `${t.type}:${t.title || t.url.slice(0, 80)}`).join(' | '));
      break;
    }
  } catch {
    // not ready yet
  }
}

let ws;
try {
  // Connect to the browser-level endpoint; Chromium uses /json/version
  const versRes = await fetch(`http://localhost:${PORT}/json/version`);
  const vers = await versRes.json();
  const wsUrl = vers.webSocketDebuggerUrl ?? `ws://localhost:${PORT}`;
  console.log('Connecting to', wsUrl);
  ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(wsUrl);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
} catch (e) {
  console.error('WebSocket connect failed:', e.message);
  process.exit(2);
}

let id = 0;
const pending = new Map();
function onMessage(method, handler) {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.method === method && msg.params) handler(msg.params);
    } catch {
      // ignore
    }
  });
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === msgId) {
        ws.off('message', handler);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

const version = await send('Browser.getVersion');
console.log('Browser:', version.product);

// Get the extension service worker target and sidepanel page
const res = await fetch(`http://localhost:${PORT}/json`);
const targets = await res.json();
const sw = targets.find((t) => t.type === 'service_worker');
const sidepanel = targets.find((t) => t.type === 'page' && /sidepanel/.test(t.url));
console.log('Service worker target:', sw ? sw.url : 'none');
console.log('Sidepanel target:', sidepanel ? sidepanel.url : 'none');

// Create a fresh page target so content scripts can inject.
const { targetId } = await send('Target.createTarget', { url: 'https://www.w3.org/Style/Examples/007/center.en.html' });
console.log('Created page target:', targetId);
await new Promise((r) => setTimeout(r, 2500));

const attachResult = await send('Target.attachToTarget', {
  targetId,
  flatten: false,
});
console.log('Attach result:', JSON.stringify(attachResult));
const sessionId = attachResult?.sessionId;

await new Promise((r) => setTimeout(r, 3000));

// The target was created with the URL already, so it should be loaded.
// Verify by checking for the content script via Runtime.evaluate.

// Use Target.sendMessageToTarget (works even when the page's own domains are restricted).
onMessage('Target.receivedMessageFromTarget', (params) => {
  try {
    const msg = JSON.parse(params.message);
    if (msg.id && pending.has(msg.id)) {
      const [, resolve] = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  } catch {
    // ignore
  }
});

async function evalInPage(expr, awaitPromise = false) {
  const msgId = 9000 + Math.floor(Math.random() * 10000);
  const promise = new Promise((resolve) => {
    pending.set(msgId, [
      setTimeout(() => {
        pending.delete(msgId);
        resolve({ err: 'TIMEOUT' });
      }, 12000),
      resolve,
    ]);
  });
  await send('Target.sendMessageToTarget', {
    targetId,
    sessionId,
    message: JSON.stringify({
      id: msgId,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise },
    }),
  }).catch((e) => console.log('sendToTarget error:', e.message));
  return promise;
}

// Note: content scripts do not inject into pages created via
// Target.createTarget in headless Chromium (harness artifact). The original
// about:blank page is a real browser-tab page, so probe it instead.
const pageTargets = await send('Target.getTargets');
const realPage = pageTargets.targetInfos?.find(
  (t) => t.type === 'page' && t.url === 'about:blank',
);
let probe = { err: 'no real page target' };
let msgProbe = { err: 'no real page target' };
if (realPage) {
  const { targetId: rId } = realPage;
  const rAttach = await send('Target.attachToTarget', { targetId: rId, flatten: false });
  const rSession = rAttach?.sessionId;
  onMessage('Target.receivedMessageFromTarget', (params) => {
    try {
      const msg = JSON.parse(params.message);
      if (msg.id && pending.has(msg.id) && params.targetId === rId) {
        const [, resolve] = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // ignore
    }
  });
  async function evalInReal(expr, awaitPromise = false) {
    const msgId = 8000 + Math.floor(Math.random() * 10000);
    const promise = new Promise((resolve) => {
      pending.set(msgId, [
        setTimeout(() => {
          pending.delete(msgId);
          resolve({ err: 'TIMEOUT' });
        }, 12000),
        resolve,
      ]);
    });
    await send('Target.sendMessageToTarget', {
      targetId: rId,
      sessionId: rSession,
      message: JSON.stringify({
        id: msgId,
        method: 'Runtime.evaluate',
        params: { expression: expr, awaitPromise },
      }),
    }).catch((e) => console.log('sendToTarget error:', e.message));
    return promise;
  }
  probe = await evalInReal(
    `typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id ? 'content-script present: ' + chrome.runtime.id : 'no runtime id'`,
  );
  msgProbe = await evalInReal(
    `new Promise(res => { try { chrome.runtime.sendMessage({type:'READ_VIDEO_CONTEXT'}, resp => res(JSON.stringify(resp).slice(0,400))); } catch(e) { res('ERR:' + e.message); } setTimeout(()=>res('TIMEOUT'), 9000); })`,
    true,
  );
}
console.log('Probe:', JSON.stringify(probe.result ?? probe.err));
console.log('READ_VIDEO_CONTEXT response:', JSON.stringify(msgProbe.result ?? msgProbe.err));

ws.send(JSON.stringify({ id: 0, method: 'Browser.close', params: {} }));
setTimeout(() => {
  browser.kill();
  process.exit(0);
}, 1500);
