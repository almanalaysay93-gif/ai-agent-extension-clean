/**
 * Background Service Worker — the brain of the extension.
 *
 * Coordinates the OpenRouter tool-calling loop:
 * 1. Receives user messages from the Side Panel.
 * 2. Optionally fetches the active tab's page context from the Content Script.
 * 3. Calls OpenRouter with tool definitions (click, type, scroll, press key).
 * 4. Forwards tool calls to the Content Script, collects results, and
 *    feeds them back into the model until a final answer is produced.
 * 5. Streams the final assistant text back to the Side Panel.
 */
import {
  chatCompletion,
  chatCompletionWithTools,
  contentToText,
  type ChatMessage,
  type ContentPart,
  type OpenRouterPlugin,
  type ToolCall,
} from '../shared/openrouter';
import { getEnabledSkillInstructions, getSettings } from '../shared/storage';
import type {
  Attachment,
  ContentScriptRequest,
  ContentScriptResponse,
  SidePanelEvent,
  SidePanelRequest,
} from '../shared/messages';

/* ------------------------------------------------------------------ */
/* First-run defaults                                                  */
/* ------------------------------------------------------------------ */
// No API key ships with the extension. Each user adds their own
// OpenRouter key on the Options page; it is stored in chrome.storage.local
// on their machine and never leaves it except in calls to OpenRouter.
const DEFAULT_MODEL_ID = 'deepseek/deepseek-v4-flash';

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'click_element',
      description:
        'Clicks an interactive element on the active webpage. Prefer CSS selectors taken from the page context (e.g. button.nav-button, a[href*="/login"]). If the selector might change, describe the element text instead.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector or stable identifier of the element to click.',
          },
        },
        required: ['selector'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description:
        'Fills text into an input field or textarea on the active webpage. Use this for search boxes, form fields and message composers.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector of the input element.',
          },
          text: {
            type: 'string',
            description: 'The exact text to type into the element.',
          },
        },
        required: ['selector', 'text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_page',
      description:
        'Scrolls the active webpage up or down to reveal more content.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down'],
            description: 'Direction to scroll.',
          },
          amount: {
            type: 'number',
            description: 'Pixels to scroll. Defaults to 600.',
          },
        },
        required: ['direction'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description:
        'Presses a keyboard key on the currently focused element of the active webpage (e.g. Enter to submit a form).',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Key to press, e.g. "Enter", "Escape", "Tab".',
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_page_context',
      description:
        'Re-fetches the current page content (markdown) from the active tab. Use this when the page has changed (after navigation, clicks, or searches) and you need fresh context. If the tool result says page content could not be extracted, retry at most ONE more time and then stop calling this tool.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_video_context',
      description:
        'Extracts what a video on the current page is saying. Works on any video page: YouTube transcripts (including auto-generated captions), any HTML5 <video> with caption tracks (VTT or SRT), Vimeo captions, or generic video metadata (duration, source, state) when no captions exist. Use this whenever the user asks about the content of a video on the active page.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pptx',
      description:
        'Builds a PowerPoint (.pptx) file from structured slide content and triggers a download to the user\'s Downloads folder. Use this whenever the user asks for slides, a presentation, or a deck. Distill the source content into concise bullets before calling; never pass raw paragraphs.',
      parameters: {
        type: 'object',
        properties: {
          fileName: {
            type: 'string',
            description:
              'File name for the download, e.g. "presentation.pptx". Defaults to "slides.pptx".',
          },
          slides: {
            type: 'array',
            description: 'Slides in order. Title slide optional as first entry.',
            items: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: 'Slide title.',
                },
                bullets: {
                  type: 'array',
                  description: 'Bullet points for the slide (omit for a title-only slide).',
                  items: { type: 'string' },
                },
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: ['slides'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description:
        'Navigates the active tab to a URL. Only use this when explicitly needed; prefer clicking links instead.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to open in the active tab.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
];

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const conversation: ChatMessage[] = [];
const MAX_HISTORY = 20;
let abortController: AbortController | null = null;
let busy = false;

const AGENT_SYSTEM_PROMPT = `You are an agentic AI browser assistant living inside a Chrome extension side panel. The user is viewing a webpage and chatting with you.

You have access to browser control tools that let you interact with the ACTIVE tab of the user's browser: clicking elements, typing into inputs, scrolling, pressing keys, re-fetching the page context, and opening URLs.

Rules:
1. When the user's request requires interacting with the page (searching, clicking a link, filling a form, scrolling to content), use the provided tools to perform the actions step by step.
2. Before clicking or typing, derive selectors from the page context or describe elements precisely so the content script can resolve them.
3. After navigating or changing the page, call get_page_context if you need fresh information before answering.
4. Never invent page content. If you cannot find an element, report that to the user.
4a. If get_page_context returns a "could not extract page content" error twice in a row, STOP calling it. Web apps and embedded frames often cannot be read as articles. Instead interact directly with the page (click, type, scroll, open_url) or ask the user to share the URL or paste the relevant text.
5. When you have enough information or have completed the requested actions, stop using tools and give the user a clear, concise final answer.
6. Do not open new tabs or windows. Never attempt to log into user accounts or enter credentials.
7. On any video page (YouTube, Vimeo, or a page with a <video>), use read_video_context to extract the transcript or video metadata before answering questions about the video.
8. When the user asks for slides or a presentation, distill the available content and use create_pptx — keep bullets short and meaningful.
9. Be terse with tool explanations; save detail for your final message.`;

/* ------------------------------------------------------------------ */
/* Page context helpers                                                */
/* ------------------------------------------------------------------ */

/*
 * MV3 port-closure workaround:
 * In Manifest V3, chrome.scripting.executeScript with a `func` that returns a
 * Promise and sends a chrome.runtime.sendMessage suffers from a known Chromium
 * race — the messaging port is sometimes torn down before the content script's
 * sendResponse reply arrives, yielding "The message port closed before a
 * response was received." To sidestep that entirely, the content script
 * answers tool requests through request-id-keyed one-shot listeners in the
 * background instead of a sendMessage round-trip.
 */
const pendingToolResponses = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request && request.type === 'TOOL_RESPONSE' && typeof request.requestId === 'string') {
    if (sender.tab?.id === undefined) {
      console.log('[bg] TOOL_RESPONSE from non-tab sender (url:', sender.url, ') req=', request.requestId);
    }
  }
  return false;
});

let requestIdCounter = 0;

/*
 * Context cache: heavy pages can take many seconds to read. Cache the last
 * successful context per tab so repeat reads (header refresh, re-sends) are
 * instant when the page URL hasn't changed.
 */
const contextCache = new Map<
  number,
  {
    url: string;
    context: { markdown: string; title: string; url: string };
    timestamp: number;
  }
>();
const CONTEXT_CACHE_TTL_MS = 30_000;

chrome.runtime.onMessage.addListener((request, sender) => {
  // Accept every TOOL_RESPONSE regardless of sender.tab: the request-id key
  // uniquely matches replies to pending tool requests. In some Chrome
  // configurations sender.tab can be undefined for legitimate content-script
  // senders (e.g. non-frame main documents in certain extension loading
  // orders), and filtering those out silently kills every page read — the
  // exact failure behind persistent "Could not read this page" errors.
  if (
    request &&
    request.type === 'TOOL_RESPONSE' &&
    typeof request.requestId === 'string'
  ) {
    console.log('[bg] TOOL_RESPONSE received for', request.requestId, 'from tab', sender.tab?.id, 'len=', request.payload?.payload?.markdown?.length ?? (request.payload?.payload?.description ?? '').length);
    const pending = pendingToolResponses.get(request.requestId);
    if (pending) {
      pendingToolResponses.delete(request.requestId);
      clearTimeout(pending.timer);
      pending.resolve(request.payload);
    }
    // Keep a recent log of responses (even unmatched ones) in storage so
    // read failures can be diagnosed if a page still cannot be read.
    try {
      chrome.storage.local
        .get(['response_log'])
        .then((data) => {
          const log = ((data.response_log as object[]) ?? []).slice(-19);
          log.push({
            requestId: request.requestId,
            pending: Boolean(pending),
            tabId: sender.tab?.id,
            ts: Date.now(),
          });
          chrome.storage.local.set({ response_log: log }).catch(() => {});
        })
        .catch(() => {});
    } catch {
      // Best-effort diagnostic only.
    }
  }
});

async function sendToolRequest(
  tabId: number,
  request: ContentScriptRequest,
  timeoutMs = 15000,
): Promise<ContentScriptResponse | null> {
  return new Promise<ContentScriptResponse | null>((resolve) => {
    const requestId = `req-${++requestIdCounter}-${Date.now()}`;
    const startedAt = Date.now();
    let retryTimer: ReturnType<typeof setInterval> | undefined;
    const deadline = setTimeout(() => {
      if (retryTimer) clearInterval(retryTimer);
      pendingToolResponses.delete(requestId);
      resolve(null);
    }, timeoutMs);
    pendingToolResponses.set(requestId, {
      resolve: (value) => {
        if (retryTimer) clearInterval(retryTimer);
        clearTimeout(deadline);
        pendingToolResponses.delete(requestId);
        resolve((value ?? null) as ContentScriptResponse | null);
      },
      reject: () => {
        if (retryTimer) clearInterval(retryTimer);
        resolve(null);
      },
      timer: deadline,
    });
    // Ask the content script for the tool response.
    //
    // The dispatch runs in the SERVICE WORKER, not in the page: chrome.tabs
    // is not part of the content-script API surface, so an injected function
    // calling chrome.tabs.sendMessage throws immediately and the request can
    // never be delivered. chrome.tabs.sendMessage from the worker addresses
    // the content script directly. The callback is deliberately ignored --
    // the content script answers with its own one-way TOOL_RESPONSE message
    // carrying the requestId, which the listener registered above resolves,
    // so no callback port needs to stay open (the MV3 "message port closed"
    // race).
    const dispatch = () => {
      void ensureContentScript(tabId).then(() => {
        try {
          void chrome.tabs
            .sendMessage(tabId, {
              ...request,
              requestId,
            } as unknown as object)
            .catch(() => {
              // No listener yet in this tab; the retry loop tries again.
            });
        } catch {
          // Tab gone or not scriptable; the deadline resolves the request.
        }
      });
    };
    // Dispatch immediately, then retry until a TOOL_RESPONSE arrives or the
    // deadline passes. Retries recover from late listener registration and
    // transient injection failures (e.g. heavy pages whose JS thread is
    // busy when the first dispatch lands).
    dispatch();
    retryTimer = setInterval(() => {
      if (Date.now() - startedAt >= timeoutMs - 2500) {
        if (retryTimer) clearInterval(retryTimer);
        retryTimer = undefined;
        return;
      }
      dispatch();
    }, 2500);
  });
}

/**
 * Self-contained page extraction run inside an injected script. Used as a
 * last-resort fallback when the content-script message round-trip never
 * resolves (e.g. framed apps or pages where the listener registration
 * races with the dispatch). It cannot carry Readability/Turndown (no
 * module graph in an injected function), so it builds a readable markdown
 * approximation from headings and visible text nodes.
 */
function runWithBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(null);
    }, budgetMs);
    promise.then(
      (value) => {
        if (!settled) {
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          clearTimeout(timer);
          resolve(null);
        }
      },
    );
  });
}

async function extractPageFallback(
  tabId: number,
): Promise<ContentScriptResponse | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        const title = document.title ?? '';
        const url = window.location.href;
        const walker = document.createTreeWalker(
          document.body ?? document.documentElement,
          NodeFilter.SHOW_ELEMENT,
        );
        const lines: string[] = [];
        const seen = new Set<Node>();
        while (walker.nextNode()) {
          const el = walker.currentNode as HTMLElement;
          const tag = el.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'IFRAME' || tag === 'SVG') {
            continue;
          }
          if (tag.startsWith('H') && el.textContent?.trim()) {
            const level = Math.min(6, Math.max(1, Number(tag.slice(1)) || 1));
            lines.push(`${'#'.repeat(level)} ${el.textContent.trim()}`);
          } else if ((tag === 'P' || tag === 'LI' || tag === 'TD' || tag === 'DT' || tag === 'DD' || tag === 'BLOCKQUOTE') && el.textContent?.trim()) {
            const text = el.textContent.trim().replace(/\s+/g, ' ');
            if (!seen.has(el) && text.length > 1) {
              seen.add(el);
              lines.push(tag === 'LI' ? `- ${text}` : text);
            }
          }
        }
        let markdown = lines.join('\n\n');
        if (!markdown.trim()) {
          markdown = (document.body?.innerText ?? '').trim();
        }
        if (markdown.length > 40000) {
          markdown = markdown.slice(0, 40000) + '\n\n[...content truncated for length...]';
        }
        return { type: 'PAGE_CONTEXT', payload: { markdown, title, url } } as ContentScriptResponse;
      },
    });
    const entry = results?.[0];
    const payload = entry?.result as ContentScriptResponse | undefined;
    if (payload?.type === 'PAGE_CONTEXT') {
      return payload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensures the content script is present in the target tab. Manifest V3
 * auto-injection is unreliable in some environments (e.g. headless Chrome
 * and extension test harnesses), so the content chunk is injected
 * explicitly via chrome.scripting.executeScript. Re-running the chunk is
 * harmless: it registers another message listener and re-runs Readability
 * helpers without side effects.
 */
function contentScriptFiles(): string[] {
  // Derive the injectable file list from the manifest instead of hardcoding
  // a name. `pnpm build` post-processes the hashed Vite chunk into the stable
  // assets/content-script.js, but `pnpm dev` (vite build --watch) does not,
  // and injecting a filename that is not in the bundle makes every injection
  // throw "Could not load file".
  const manifest = chrome.runtime.getManifest();
  const files = new Set<string>();
  for (const entry of manifest.content_scripts ?? []) {
    for (const js of entry.js ?? []) files.add(js);
  }
  return [...files];
}

/**
 * True for URLs no extension is allowed to script: browser-internal pages,
 * the Web Store, other extensions, and (unless the user enabled file access)
 * local files. Detecting these up front turns a silent injection failure into
 * an accurate message.
 */
function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  if (/^(chrome|edge|brave|about|devtools|view-source|chrome-extension|chrome-untrusted|moz-extension):/i.test(url)) {
    return true;
  }
  if (/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)) {
    return true;
  }
  return false;
}

async function ensureContentScript(tabId: number): Promise<void> {
  const files = contentScriptFiles();
  if (files.length === 0) {
    const trace = { kind: 'ensure-fail', err: 'no content_scripts declared in manifest', ts: Date.now() };
    chrome.storage.local.set({ probe_trace: trace }).catch(() => {});
    return;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      files,
    });
    const trace = {
      kind: 'ensure-ok',
      files,
      docs: results?.map((r) => ({ doc: r.documentId, ok: r.result !== undefined })),
      ts: Date.now(),
    };
    console.log('[bg] ensureContentScript injected ok, results=', trace.docs);
    chrome.storage.local.set({ probe_trace: trace }).catch(() => {});
  } catch (error) {
    // Injection failure is non-fatal; the auto-injected content script
    // (when present) will handle the request instead.
    const trace = { kind: 'ensure-fail', files, err: String(error), ts: Date.now() };
    console.warn('ensureContentScript failed, continuing anyway', error);
    chrome.storage.local.set({ probe_trace: trace }).catch(() => {});
  }
}


async function getPageContext(
  tabId: number,
  opts: { budgetMs?: number; useCache?: boolean } = {},
): Promise<{ markdown: string; title: string; url: string } | null> {
  // Serve a fresh cached context instantly when the page hasn't changed —
  // this removes the visible hang on heavy pages when the user re-sends or
  // re-opens the panel.
  if (opts.useCache !== false) {
    const cached = contextCache.get(tabId);
    if (cached && Date.now() - cached.timestamp < CONTEXT_CACHE_TTL_MS) {
      return cached.context;
    }
  }
  try {
    const budgetMs = opts.budgetMs ?? 15000;
    // The direct injected extractor is tried FIRST because it is
    // self-contained (no content-script dependency, no message round-trip
    // and no MV3 port-closure risk) and succeeds on virtually every page
    // the content script can reach. The messaging round-trip remains as a
    // secondary path when the injection cannot run (e.g. blocked hosts).
    const direct = await runWithBudget(extractPageFallback(tabId), budgetMs);
    if (direct?.type === 'PAGE_CONTEXT') {
      contextCache.set(tabId, {
        url: direct.payload.url,
        context: direct.payload,
        timestamp: Date.now(),
      });
      return direct.payload;
    }
    const result = await sendToolRequest(tabId, { type: 'GET_PAGE_CONTEXT' }, budgetMs);
    if (result?.type === 'PAGE_CONTEXT') {
      contextCache.set(tabId, {
        url: result.payload.url,
        context: result.payload,
        timestamp: Date.now(),
      });
      return result.payload;
    }
    return null;
  } catch (error) {
    console.error('Failed to get page context', error);
    return null;
  }
}

async function executeToolInTab(
  tabId: number,
  toolCall: ToolCall,
): Promise<string> {
  const params = JSON.parse(toolCall.function.arguments || '{}');

  if (toolCall.function.name === 'open_url') {
    try {
      await chrome.tabs.update(tabId, { url: params.url });
      return `Navigated the active tab to ${params.url}.`;
    } catch (error) {
      return `Failed to open URL: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // --- read_video_context: fetches video/transcript context from the tab. ---
  if (toolCall.function.name === 'read_video_context') {
    try {
      const result = await sendToolRequest(tabId, { type: 'READ_VIDEO_CONTEXT' }, 15000);
      if (result?.type === 'VIDEO_CONTEXT') {
        return formatVideoContext(result.payload);
      }
      return 'No video found on the active page.';
    } catch (error) {
      return `Failed to read the video: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // --- create_pptx: builds a real .pptx locally and triggers a download. ---
  if (toolCall.function.name === 'create_pptx') {
    try {
      const slides = (params.slides ?? []) as Array<{
        title: string;
        bullets?: string[];
      }>;
      if (!Array.isArray(slides) || slides.length === 0) {
        return 'create_pptx received no slides. Pass slides: [{title, bullets}].';
      }
      const fileName = await buildAndDownloadPptx(
        slides,
        String(params.fileName ?? 'slides.pptx'),
      );
      return `Created the presentation "${fileName}" and downloaded it to your Downloads folder (${slides.length} slide${slides.length === 1 ? '' : 's'}).`;
    } catch (error) {
      return `Failed to create the presentation: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  try {
    const result = await sendToolRequest(tabId, {
      type: 'EXECUTE_ACTION',
      payload: { action: toolCall.function.name, params },
    });
    const cannotRead =
      'Could not extract page content — the page may be a web app, an ' +
      'embedded frame, or its scripts are too busy. Retry at most once, ' +
      'then stop re-fetching and answer from memory or use ' +
      'click_element / type_text / open_url to interact directly.';
    if (result?.type === 'ACTION_RESULT') {
      return result.payload.description;
    }
    if (toolCall.function.name === 'get_page_context') {
      return cannotRead;
    }
    return 'Action returned no result.';
  } catch (error) {
    return `Action execution failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Formats a VIDEO_CONTEXT payload into an agent-readable markdown summary.
 */
function formatVideoContext(payload: {
  source: string;
  url: string;
  title?: string;
  metadata?: Record<string, unknown>;
  transcriptText?: string;
}): string {
  const lines: string[] = [];
  lines.push(`## Video found on this page`);
  if (payload.title) lines.push(`Title: ${payload.title}`);
  lines.push(`Source: ${payload.source}`);
  lines.push(`Page: ${payload.url}`);
  if (payload.metadata && Object.keys(payload.metadata).length > 0) {
    lines.push(
      `Metadata: ${Object.entries(payload.metadata)
        .map(([k, v]) => `${k}=${v === null ? 'n/a' : String(v)}`)
        .join(', ')}`,
    );
  }
  if (payload.transcriptText) {
    const text =
      payload.transcriptText.length > 10000
        ? payload.transcriptText.slice(0, 10000) + '\n[...transcript truncated for length...]'
        : payload.transcriptText;
    lines.push('');
    lines.push('## Transcript');
    lines.push(text);
  } else {
    lines.push(
      'No captions or transcript available for this video — the agent can ' +
        'only reason about the video\'s metadata.',
    );
  }
  return lines.join('\n');
}

const OFFSCREEN_PATH = 'offscreen/index.html';
const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * Creates the offscreen document if it is not already open. Chrome allows a
 * single offscreen document per extension, and createDocument throws if one
 * already exists, so concurrent calls are serialised through one promise.
 */
let offscreenReady: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    if (existing.length > 0) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS' as chrome.offscreen.Reason],
        justification: 'Build .pptx files, which needs a DOM that the service worker lacks.',
      });
    } catch (error) {
      // A racing call may have created it first; anything else is fatal.
      if (!String(error).includes('Only a single offscreen')) throw error;
    }
  })();
  try {
    await offscreenReady;
  } catch (error) {
    offscreenReady = null;
    throw error;
  }
}

/**
 * Waits for a started download to reach a terminal state so the agent only
 * claims success once the file actually exists (or reports the real reason
 * it does not, including the user cancelling the Save As dialog).
 */
function waitForDownload(downloadId: number): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const finish = (result: { ok: boolean; reason?: string }) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(result);
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') finish({ ok: true });
      if (delta.state?.current === 'interrupted') {
        finish({ ok: false, reason: delta.error?.current ?? 'interrupted' });
      }
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timed out' }), 120000);
    chrome.downloads.onChanged.addListener(onChanged);
    // The download may already have finished before the listener attached.
    chrome.downloads.search({ id: downloadId }, (items) => {
      const item = items[0];
      if (item?.state === 'complete') finish({ ok: true });
      if (item?.state === 'interrupted') finish({ ok: false, reason: item.error ?? 'interrupted' });
    });
  });
}

/**
 * Builds a .pptx in the offscreen document and downloads it.
 *
 * The build cannot happen here: a service worker has no DOM for PptxGenJS,
 * forbids runtime import(), and does not expose URL.createObjectURL. The
 * offscreen document returns base64, which chrome.downloads accepts as a
 * data: URL.
 */
async function buildAndDownloadPptx(
  slides: Array<{ title: string; bullets?: string[] }>,
  fileName: string,
): Promise<string> {
  await ensureOffscreenDocument();

  // The document may still be parsing when the first message goes out, so
  // retry briefly until its listener is live.
  let response: { ok: boolean; base64?: string; error?: string } | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      response = (await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_BUILD_PPTX',
        slides,
      })) as { ok: boolean; base64?: string; error?: string } | undefined;
      if (response) break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!response && lastError) {
    throw new Error(`the file builder never answered (${String(lastError)})`);
  }

  if (!response?.ok || !response.base64) {
    throw new Error(response?.error ?? 'the file builder returned nothing');
  }

  let safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  if (!/\.pptx$/i.test(safeName)) safeName += '.pptx';

  const downloadId = await chrome.downloads.download({
    url: `data:${PPTX_MIME};base64,${response.base64}`,
    filename: safeName,
    saveAs: false,
  });

  const result = await waitForDownload(downloadId);
  if (!result.ok) {
    throw new Error(`the download did not finish (${result.reason})`);
  }
  return safeName;
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

/**
 * Turns the composer's attachments into OpenRouter content parts.
 *
 * Images and PDFs go up as native multimodal parts. Text-like files are
 * inlined as fenced blocks instead: that works on every model, needs no
 * parser plugin, and costs nothing beyond the tokens themselves.
 */
function buildUserContent(text: string, attachments: Attachment[]): string | ContentPart[] {
  if (attachments.length === 0) return text;

  const parts: ContentPart[] = [];
  const inlined: string[] = [];

  for (const file of attachments) {
    if (file.kind === 'text' && file.text) {
      inlined.push(
        ['### Attached file: ' + file.name, '', '```', file.text, '```'].join('\n'),
      );
    }
  }

  const prompt = inlined.length > 0 ? [text, ...inlined].join('\n\n') : text;
  parts.push({ type: 'text', text: prompt });

  for (const file of attachments) {
    if (file.kind === 'image' && file.dataUrl) {
      parts.push({ type: 'image_url', image_url: { url: file.dataUrl } });
    } else if (file.kind === 'pdf' && file.dataUrl) {
      parts.push({
        type: 'file',
        file: { filename: file.name, file_data: file.dataUrl },
      });
    }
  }

  return parts;
}

/**
 * PDFs need OpenRouter's file parser. "pdf-text" is the free engine and
 * handles ordinary text PDFs; scanned documents need the paid OCR engine,
 * which the user opts into on the Options page.
 */
async function pluginsForAttachments(
  attachments: Attachment[],
): Promise<OpenRouterPlugin[] | undefined> {
  if (!attachments.some((file) => file.kind === 'pdf')) return undefined;
  const stored = await chrome.storage.local.get('pdf_ocr_engine');
  const engine = stored['pdf_ocr_engine'] === 'mistral-ocr' ? 'mistral-ocr' : 'pdf-text';
  return [{ id: 'file-parser', pdf: { engine } }];
}

/* ------------------------------------------------------------------ */
/* Agentic tool-calling loop                                           */
/* ------------------------------------------------------------------ */

const MAX_TOOL_STEPS = 10;

async function runAgentLoop(
  tabId: number,
  notify: (event: SidePanelEvent) => void,
  plugins?: OpenRouterPlugin[],
): Promise<void> {
  const { apiKey, model } = await getSettings();

  const messages: ChatMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...conversation.slice(-MAX_HISTORY),
  ];

  // Mechanically cap get_page_context failures within this run: the model
  // sometimes ignores the "retry once" instruction, so enforce it in code to
  // bound the worst-case loop time (2 failed reads × 10s each = 20s max,
  // instead of burning the whole step budget on repeated failed reads).
  let pageReadFailures = 0;
  const MAX_PAGE_READ_FAILURES = 2;
  const pageReadFailMessage =
    'Could not extract page content after two attempts — the page may be a ' +
    'web app, an embedded frame, or its scripts are too busy. Stop calling ' +
    'this tool and answer from memory or use click_element / type_text / open_url.';

  const skillInstructions = getEnabledSkillInstructions((await getSettings()).skills);
  if (skillInstructions) {
    messages[0] = {
      role: 'system',
      content: `${AGENT_SYSTEM_PROMPT}${skillInstructions}\nWhen acting, follow the custom skill instructions that match the user's current request.\n\n---\n\nRules:\n1. Use skills as a guide for HOW to act; still use the browser tools for actual page interaction.\n2. If multiple skills could apply, prefer the most specific one.\n3. Follow a skill's steps in order, adapting selectors to the actual page when possible.`,
    };
  }

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const { message, stopReason } = await chatCompletionWithTools(
      apiKey,
      model,
      messages,
      AGENT_TOOLS,
      abortController?.signal,
      plugins,
    );

    messages.push(message);

    const toolCalls = (message as ChatMessage & { tool_calls?: ToolCall[] })
      .tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // No more tool calls — stream the final answer.
      if (message.content) {
        notify({
          type: 'MESSAGE_COMPLETE',
          payload: { role: 'assistant', text: contentToText(message.content) },
        });
      }
      return;
    }

    if (stopReason === 'tool_calls' || stopReason === 'length') {
      // Execute each tool call in the active tab and append results.
      for (const toolCall of toolCalls) {
        notify({
          type: 'AGENT_ACTION',
          payload: {
            description: describeToolCall(toolCall),
          },
        });

        // Short-circuit repeated page reads: after two failures within
        // this run, inject the stop-retrying message without spending
        // another 10s on the content-script round-trip.
        let toolContent: string;
        if (toolCall.function.name === 'get_page_context' && pageReadFailures >= MAX_PAGE_READ_FAILURES) {
          toolContent = pageReadFailMessage;
        } else {
          toolContent = await executeToolInTab(tabId, toolCall);
          if (toolCall.function.name === 'get_page_context' && toolContent.includes('Could not extract page content')) {
            pageReadFailures += 1;
          }
        }
        const toolResult: ChatMessage = {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: toolContent,
        };
        messages.push(toolResult);
      }
      // Loop back and ask the model to continue with the tool results.
      continue;
    }

    // Reached a stop without tool calls; emit whatever content exists.
    if (message.content) {
      notify({
        type: 'MESSAGE_COMPLETE',
        payload: { role: 'assistant', text: contentToText(message.content) },
      });
    }
    return;
  }

  notify({
    type: 'AGENT_ACTION',
    payload: { description: 'Reached the maximum number of tool-calling steps.' },
  });
  const { apiKey: apiKey2, model: model2 } = await getSettings();
  const { text } = await chatCompletion(
    apiKey2,
    model2,
    messages,
    (delta) => notify({ type: 'ROLE_DELTA', payload: { role: 'assistant', delta } }),
    abortController?.signal,
    plugins,
  );
  if (text) {
    notify({ type: 'MESSAGE_COMPLETE', payload: { role: 'assistant', text } });
  }
}

function describeToolCall(toolCall: ToolCall): string {
  try {
    const args = JSON.parse(toolCall.function.arguments || '{}');
    switch (toolCall.function.name) {
      case 'click_element':
        return `Clicking: ${args.selector ?? ''}`;
      case 'type_text':
        return `Typing into ${args.selector ?? ''}: "${String(args.text ?? '').slice(0, 40)}"`;
      case 'scroll_page':
        return `Scrolling ${args.direction ?? 'down'}`;
      case 'press_key':
        return `Pressing key: ${args.key ?? ''}`;
      case 'get_page_context':
        return 'Re-fetching page context';
      case 'open_url':
        return `Opening URL: ${args.url ?? ''}`;
      default:
        return `Using tool: ${toolCall.function.name}`;
    }
  } catch {
    return `Using tool: ${toolCall.function.name}`;
  }
}

/* ------------------------------------------------------------------ */
/* Side panel message handling                                         */
/* ------------------------------------------------------------------ */

async function handleSidePanelMessage(request: SidePanelRequest): Promise<void> {
  const { apiKey, readPageContext } = await getSettings();
  // A service worker has no "current window", so currentWindow can resolve to
  // the wrong window (or nothing) when the side panel has focus. lastFocusedWindow
  // is the correct lookup here, with a plain active-tab query as a last resort.
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab?.id) {
    [tab] = await chrome.tabs.query({ active: true });
  }

  const notify = (event: SidePanelEvent) => {
    chrome.runtime.sendMessage(event).catch(() => {
      // Side panel may have closed.
    });
  };

  try {
    if (request.type === 'GET_PAGE_CONTEXT') {
      if (!tab?.id) {
        notify({ type: 'PAGE_CONTEXT', payload: { markdown: '', title: '', url: '' } });
        return;
      }
      // Bounded budget: never leave the header spinner running forever.
      const context = await getPageContext(tab.id, { budgetMs: 10000 });
      if (context) {
        notify({
          type: 'PAGE_CONTEXT',
          payload: { markdown: context.markdown, title: context.title, url: context.url },
        });
      } else {
        // Attach the last content-script injection probe trace so the
        // failure is self-diagnosing instead of a silent spin.
        const trace = await chrome.storage.local.get('probe_trace');
        const probeTrace = trace.probe_trace as
          | { kind?: string; err?: string; docs?: unknown }
          | undefined;
        const probe = probeTrace?.kind ?? 'unknown';
        const detail = probeTrace?.err ? ` ${probeTrace.err}` : '';
        notify({
          type: 'ERROR',
          payload: {
            message: isRestrictedUrl(tab.url)
              ? `Chrome does not allow extensions to read this page (${tab.url ?? 'unknown URL'}). ` +
                'Browser pages, the Web Store and other extensions are off limits. Switch to a normal http(s) tab.'
              : `Could not read this page (extraction probe: ${probe}).${detail} ` +
                'Try reloading the tab, or disable "Reads page context" and ask a question directly — the agent can still interact with the page.',
          },
        });
      }
      return;
    }

    if (request.type === 'CLEAR_HISTORY') {
      conversation.length = 0;
      return;
    }

    if (request.type === 'STOP') {
      abortController?.abort();
      abortController = null;
      busy = false;
      notify({ type: 'BUSY', payload: { busy: false } });
      return;
    }

    if (request.type === 'SEND_MESSAGE') {
      if (busy) {
        notify({ type: 'ERROR', payload: { message: 'Already working on a previous request. Use Stop to cancel it first.' } });
        return;
      }
      if (!apiKey) {
        notify({
          type: 'ERROR',
          payload: { message: 'OpenRouter API key is missing. Open the extension Options page to add your key first.' },
        });
        return;
      }
      if (!tab?.id) {
        notify({ type: 'ERROR', payload: { message: 'No active tab found.' } });
        return;
      }

      const userText = request.payload.text.trim();
      const attachments = request.payload.attachments ?? [];
      if (!userText && attachments.length === 0) return;

      conversation.push({
        role: 'user',
        content: buildUserContent(userText, attachments),
      });
      const attachmentNote =
        attachments.length > 0
          ? '\n\n_Attached: ' + attachments.map((file) => file.name).join(', ') + '_'
          : '';
      notify({
        type: 'MESSAGE_COMPLETE',
        payload: { role: 'user', text: `${userText}${attachmentNote}` },
      });

      // Let the user see activity immediately; the page read then runs
      // within a bounded budget so a slow page never freezes the panel.
      abortController = new AbortController();
      busy = true;
      notify({ type: 'BUSY', payload: { busy: true } });

      // Prepend page context if enabled and the user hasn't disabled it.
      if (readPageContext) {
        const context = await getPageContext(tab.id, { budgetMs: 10000 });
        if (context) {
          conversation.push({
            role: 'user',
            content: `Here is the current page context for "${context.title}" (${context.url}):\n\n${context.markdown}`,
          });
          notify({
            type: 'PAGE_CONTEXT',
            payload: { markdown: context.markdown, title: context.title, url: context.url },
          });
        }
      }

      await runAgentLoop(tab.id, notify, await pluginsForAttachments(attachments));
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error('[bg] runAgentLoop failed:', message);
    const friendly = message.toLowerCase().includes('aborted')
      ? 'Stopped.'
      : message;
    notify({ type: 'ERROR', payload: { message: friendly } });
  } finally {
    abortController = null;
    busy = false;
    notify({ type: 'BUSY', payload: { busy: false } });
  }
}

chrome.runtime.onMessage.addListener(
  (request: SidePanelRequest | { type: string }, sender) => {
    console.log('[bg] onMessage', request?.type, 'tab?', !!sender.tab);
    if (request?.type === 'TEST_DONE' && sender.tab === undefined) {
      // Test-only hook: acknowledge the loop finished.
      return false;
    }
    const fromExtensionContext =
      sender.url && sender.url.startsWith('chrome-extension://');
    if (
      fromExtensionContext &&
      request &&
      typeof request.type === 'string' &&
      sender.url !== undefined &&
      isExtensionPage(sender.url)
    ) {
      // Messages from the side panel or other extension pages
      // (the real side panel has sender.tab undefined; a tab opened with
      // chrome.tabs.create has sender.tab set — accept both).
      void handleSidePanelMessage(request as SidePanelRequest);
    }
    return false;
  },
);

function isExtensionPage(url: string): boolean {
  // Accept the side panel and options pages (and any in-extension page like
  // popup.html if added later). This excludes chrome.scripting.executeScript
  // injected contexts, whose sender.url is chrome-extension://<id>/ but not
  // one of the extension's own pages.
  if (url.endsWith('/sidepanel/index.html')) return true;
  if (url.endsWith('/options/index.html')) return true;
  if (/chrome-extension:\/\/[^/]+\/(popup\.html|index\.html)$/i.test(url)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Toolbar action → open side panel                                    */
/* ------------------------------------------------------------------ */

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id !== undefined) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  console.log('AlAi Agent extension installed.');
  // Seed the model choice only. The API key stays empty until the user
  // enters their own on the Options page.
  const existing = await chrome.storage.local.get([
    'openrouter_model',
    'read_page_context',
  ]);
  if (!existing['openrouter_model']) {
    await chrome.storage.local.set({
      openrouter_model: DEFAULT_MODEL_ID,
      read_page_context: true,
    });
    console.log('AlAi Agent seeded default settings.');
  }
});
