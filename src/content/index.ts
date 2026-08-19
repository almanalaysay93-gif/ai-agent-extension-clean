/**
 * Content Script — the eyes & hands of the agent.
 *
 * Extracts page context with @mozilla/readability + turndown, and executes
 * DOM actions (click, type, scroll) with adaptive selector fallbacks inspired
 * by Scrapling's resilient element tracking: if the exact selector fails,
 * the script re-searches the DOM using attribute heuristics so actions
 * survive minor DOM shifts.
 */
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type {
  ContentScriptRequest,
  ContentScriptResponse,
  TranscriptSegment,
  VideoContext,
} from '../shared/messages';

/* ------------------------------------------------------------------ */
/* Page context extraction                                             */
/* ------------------------------------------------------------------ */

function extractPageContext(): ContentScriptResponse {
  const url = window.location.href;
  const title = document.title ?? '';

  // Clone the document so Readability never mutates the live page.
  const clone = document.cloneNode(true) as Document;
  const article = new Readability(clone).parse();
  let markdown: string;

  if (article?.content) {
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
    turndown.remove(['script', 'style', 'noscript', 'iframe']);
    markdown = `# ${article.title ?? title}\n\n${turndown.turndown(article.content)}`;
  } else {
    // Fallback: strip junk nodes and convert the whole body to markdown.
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
    turndown.remove(['script', 'style', 'noscript', 'iframe']);
    markdown = turndown.turndown(document.body);
  }

  // Cap the context at a safe token-approximate length (40k chars ≈ 10k tokens).
  const MAX_CHARS = 40000;
  if (markdown.length > MAX_CHARS) {
    markdown =
      markdown.slice(0, MAX_CHARS) +
      '\n\n[...content truncated for length...]';
  }

  return {
    type: 'PAGE_CONTEXT',
    payload: { markdown, title, url },
  };
}

/* ------------------------------------------------------------------ */
/* Universal video context extraction                                  */
/* ------------------------------------------------------------------ */

/**
 * Extract what a video on the current page is saying — universally:
 * 1. YouTube transcript from the page's embedded player response (caption
 *    tracks XML endpoint). Works for every YouTube video with captions
 *    (including auto-generated ones).
 * 2. HTML5 <video> elements with <track> caption/subtitle files — any site
 *    that ships VTT/SRT captions.
 * 3. Vimeo player config captions.
 * 4. Generic video metadata (src, duration, state) so the agent can still
 *    reason about any video page without captions.
 */
async function extractVideoContext(): Promise<ContentScriptResponse> {
  const url = window.location.href;
  const title = document.title ?? '';

  // --- 1. YouTube transcript (embedded ytInitialPlayerResponse) ---------
  try {
    const yt = await extractYouTubeTranscript();
    if (yt) {
      return {
        type: 'VIDEO_CONTEXT',
        payload: {
          ...yt,
          url,
          title: title || yt.title,
        },
      };
    }
  } catch {
    // fall through to the next strategies
  }

  // --- 2. HTML5 <video> with <track> captions --------------------------
  const video = document.querySelector('video') as HTMLVideoElement | null;
  const tracks = video
    ? ([...video.querySelectorAll('track[src]')] as HTMLTrackElement[]).filter(
        (t) =>
          (t.kind ?? 'subtitles').match(/^(subtitles|captions|descriptions)$/i),
      )
    : [];
  if (tracks.length > 0) {
    try {
      const segments = await fetchTrackCaptions(
        tracks.slice(0, 3).map((t) => (t as HTMLTrackElement).src),
      );
      if (segments.length > 0 || video) {
        const metadata = video ? describeVideoElement(video) : {};
        return {
          type: 'VIDEO_CONTEXT',
          payload: {
            source: segments.length > 0 ? 'html5_track_captions' : 'video_metadata',
            url,
            title,
            metadata,
            ...(segments.length > 0
              ? { transcript: segments, transcriptText: joinTranscript(segments) }
              : {}),
          },
        };
      }
    } catch {
      // fall through
    }
  }

  // --- 3. Vimeo captions via player config -----------------------------
  try {
    const vimeo = extractVimeoCaptions();
    if (vimeo) {
      return { type: 'VIDEO_CONTEXT', payload: { ...vimeo, url, title } };
    }
  } catch {
    // fall through
  }

  // --- 4. Generic video metadata (any page with a <video>) -------------
  if (video) {
    return {
      type: 'VIDEO_CONTEXT',
      payload: {
        source: 'video_metadata',
        url,
        title,
        metadata: describeVideoElement(video),
      },
    };
  }

  return {
    type: 'VIDEO_CONTEXT',
    payload: { source: 'none', url, title },
  };
}

/* ---------- YouTube helpers ---------- */

type YtPlayerResponse = {
  videoDetails?: { title?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl?: string;
        languageCode?: string;
        vssId?: string;
        kind?: string;
      }>;
    };
  };
};

/**
 * Reads YouTube's player response out of the page's inline scripts.
 *
 * The content script runs in the ISOLATED world, where page globals such as
 * window.ytInitialPlayerResponse are invisible (measured: ISOLATED reports
 * undefined while MAIN reports the object). The same data is embedded as
 * text in an inline script, which the isolated world can read through the
 * DOM, so parse it from there.
 */
function readYtPlayerResponse(): YtPlayerResponse | null {
  // Anything the page already exposed to this world wins (cheapest path).
  const live = (window as unknown as Record<string, unknown>)
    .ytInitialPlayerResponse as YtPlayerResponse | undefined;
  if (live?.captions) return live;

  for (const script of [...document.querySelectorAll('script')]) {
    const text = script.textContent ?? '';
    const marker = text.indexOf('ytInitialPlayerResponse');
    if (marker === -1) continue;
    const braceStart = text.indexOf('{', marker);
    if (braceStart === -1) continue;
    const json = sliceBalancedJson(text, braceStart);
    if (!json) continue;
    try {
      return JSON.parse(json) as YtPlayerResponse;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Returns the JSON object starting at `from`, tracking string state so
 * braces inside string literals do not end the object early.
 */
function sliceBalancedJson(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

async function extractYouTubeTranscript(): Promise<VideoContext | null> {
  if (!/youtube\.com\/watch|youtube\.com\/shorts/i.test(window.location.href)) {
    return null;
  }

  const player = readYtPlayerResponse();
  const tracks =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) return null;

  // Prefer English, then a manually written track, then whatever exists
  // (auto-generated tracks carry kind "asr").
  const preferred =
    tracks.find((t) => (t.languageCode ?? '') === 'en' && t.kind !== 'asr') ??
    tracks.find((t) => (t.languageCode ?? '') === 'en') ??
    tracks.find((t) => t.kind !== 'asr') ??
    tracks[0];
  if (!preferred.baseUrl) return null;

  const resp = await fetch(`${preferred.baseUrl}&fmt=json3`);
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>;
  };
  const segments: TranscriptSegment[] = (data.events ?? [])
    .map((e) => ({
      start: (e.tStartMs ?? 0) / 1000,
      text: (e.segs ?? []).map((seg) => seg.utf8 ?? '').join(''),
    }))
    .filter((seg) => seg.text.trim().length > 0);

  if (segments.length === 0) return null;
  return {
    source: 'youtube_transcript',
    url: window.location.href,
    title: player?.videoDetails?.title,
    transcript: segments,
    transcriptText: joinTranscript(segments),
  };
}

function joinTranscript(segments: TranscriptSegment[]): string {
  return segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
}

/* ---------- HTML5 track captions ---------- */

async function fetchTrackCaptions(srcs: string[]): Promise<TranscriptSegment[]> {
  for (const src of srcs) {
    try {
      const resp = await fetch(src);
      if (!resp.ok) continue;
      const text = await resp.text();
      if (/WEBVTT/.test(text)) {
        const segs = parseVtt(text);
        if (segs.length > 0) return segs;
      } else if (/\d\d:\d\d:\d\d/.test(text) || /\[.*\]/.test(text)) {
        // Assume SRT-ish; parse generic timestamp blocks.
        const segs = parseSrt(text);
        if (segs.length > 0) return segs;
      }
    } catch {
      continue;
    }
  }
  return [];
}

function parseVtt(text: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const m = block.match(
      /(\d{2}:)?(\d{2}):(\d{2})\.\d+\s*-->\s*(\d{2}:)?(\d{2}):(\d{2})\.\d+(.*)/s,
    );
    if (!m) continue;
    const start =
      (parseInt(m[1] ?? '0', 10) * 3600 +
        parseInt(m[2], 10) * 60 +
        parseInt(m[3], 10));
    const text = m[7]
      .replace(/<\/?[^>]+>/g, '')
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    if (text) segments.push({ start, text });
  }
  return segments;
}

function parseSrt(text: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const m = block.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d+)\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d+)([\s\S]*)/,
    );
    if (!m) continue;
    const start = m[1].replace(',', '.').split(':').reduce(
      (acc, p, i) => acc + parseFloat(p) * ([3600, 60, 1][i] ?? 0),
      0,
    );
    const text = m[3]
      .replace(/<\/?[^>]+>/g, '')
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    if (text) segments.push({ start, text });
  }
  return segments;
}

function describeVideoElement(video: HTMLVideoElement): Record<string, unknown> {
  return {
    src: (video.currentSrc || video.src || '').slice(0, 300),
    durationSeconds: isFinite(video.duration) ? Math.round(video.duration) : null,
    currentTimeSeconds: isFinite(video.currentTime) ? Math.round(video.currentTime) : null,
    paused: video.paused,
    muted: video.muted,
    playbackRate: video.playbackRate,
    readyState: video.readyState,
  };
}

/* ---------- Vimeo helpers ---------- */

function extractVimeoCaptions(): VideoContext | null {
  if (!/vimeo\.com/i.test(window.location.href)) return null;
  // Vimeo embeds its player config into inline scripts.
  const scripts = [...document.querySelectorAll('script')];
  for (const script of scripts) {
    const text = script.textContent ?? '';
    const m = text.match(/"video"\s*:\s*\{([^}]*(?:"captions"[^}]*)[^}]*)\}/);
    if (!m) continue;
    try {
      // Locate the captions block directly.
      const cap = text.match(/"captions"\s*:\s*\{([^}]*)\}/);
      if (!cap) continue;
      return {
        source: 'vimeo_captions',
        url: window.location.href,
        title: document.title,
        metadata: { captionsConfig: cap[1].slice(0, 2000) },
      };
    } catch {
      continue;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Robust element resolution (Scrapling-style adaptive tracking)       */
/* ------------------------------------------------------------------ */

type Candidate = {
  el: Element;
  score: number;
  reason: string;
};

/**
 * Try to resolve an element from a selector with adaptive fallbacks.
 * 1. Exact CSS selector
 * 2. Selector with quotes / whitespace normalized
 * 3. Element search by stable attributes (id, aria-label, name, value,
 *    placeholder, href) — the "adaptive scraping" port from Scrapling
 * 4. Element search by visible text content
 */
function resolveElement(selector: string): { el: Element; reason: string } | null {
  const trimmed = selector.trim();

  // Attempt 1: exact selector
  let el = safeQuerySelector(trimmed);
  if (el) return { el, reason: `exact selector "${trimmed}"` };

  // Attempt 2: normalize quotes and whitespace
  const normalized = trimmed
    .replaceAll('\u201C', '"')
    .replaceAll('\u201D', '"')
    .replaceAll('\u2018', "'")
    .replaceAll('\u2019', "'")
    .replaceAll(/\s+/g, ' ');
  if (normalized !== trimmed) {
    el = safeQuerySelector(normalized);
    if (el) return { el, reason: `normalized selector "${normalized}"` };
  }

  // Attempt 3: stable-attribute heuristics
  const candidates: Candidate[] = [];
  const add = (found: Element | null, score: number, reason: string) => {
    if (found && !candidates.some((c) => c.el === found)) {
      candidates.push({ el: found, score, reason });
    }
  };

  // Try as id
  if (trimmed.startsWith('#')) {
    add(document.getElementById(trimmed.slice(1)), 90, `id="${trimmed.slice(1)}"`);
  }

  const byAttr = (name: string): Element | null => {
    const found = document.querySelector(
      `[${name}="${trimmed}"]`,
    ) as Element | null;
    if (found) return found;
    // Fuzzy match: attribute contains the token sequence
    const tokens = trimmed
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (tokens.length === 0) return null;
    let best: Element | null = null;
    let bestScore = 0;
    document.querySelectorAll(`[${name}]`).forEach((node) => {
      const val = node.getAttribute(name)?.toLowerCase() ?? '';
      const matched = tokens.filter((t) => val.includes(t)).length;
      if (matched > bestScore) {
        bestScore = matched;
        best = node;
      }
    });
    return bestScore >= tokens.length * 0.6 ? best : null;
  };

  add(byAttr('id'), 95, `id="${trimmed}"`);
  add(byAttr('aria-label'), 90, `aria-label="${trimmed}"`);
  add(byAttr('name'), 80, `name="${trimmed}"`);
  add(byAttr('placeholder'), 75, `placeholder="${trimmed}"`);
  add(byAttr('href'), 85, `href="${trimmed}"`);

  // Attempt 4: visible text match
  if (trimmed.length >= 3) {
    const needle = trimmed.toLowerCase();
    const interactive = document.querySelectorAll(
      'a, button, [role="button"], input, textarea, label, h1, h2, h3, h4, h5, h6, span, div, li, td, th',
    );
    for (const node of interactive) {
      const text = (node.textContent ?? '').toLowerCase();
      if (text.includes(needle) && text.length < 400) {
        candidates.push({
          el: node,
          score: 60,
          reason: `text content "${trimmed}"`,
        });
        break;
      }
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return { el: candidates[0].el, reason: candidates[0].reason };
  }

  return null;
}

function safeQuerySelector(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function scrollIntoView(el: Element): void {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ------------------------------------------------------------------ */
/* Action execution                                                    */
/* ------------------------------------------------------------------ */

async function executeAction(
  action: string,
  params: Record<string, unknown>,
): Promise<ContentScriptResponse> {
  try {
    switch (action) {
      case 'click_element': {
        const selector = String(params.selector ?? '');
        const resolved = resolveElement(selector);
        if (!resolved) {
          return {
            type: 'ACTION_RESULT',
            payload: {
              success: false,
              description: `No element found for selector "${selector}" or any adaptive fallback.`,
            },
          };
        }
        scrollIntoView(resolved.el);
        await sleep(150);
        (resolved.el as HTMLElement).click();
        // For <a href> and some SPA controls, also dispatch native events.
        resolved.el.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
        );
        resolved.el.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, cancelable: true }),
        );
        return {
          type: 'ACTION_RESULT',
          payload: {
            success: true,
            description: `Clicked element via ${resolved.reason}.`,
          },
        };
      }

      case 'type_text': {
        const selector = String(params.selector ?? '');
        const text = String(params.text ?? '');
        const resolved = resolveElement(selector);
        if (!resolved) {
          return {
            type: 'ACTION_RESULT',
            payload: {
              success: false,
              description: `No input element found for selector "${selector}" or any adaptive fallback.`,
            },
          };
        }
        scrollIntoView(resolved.el);
        await sleep(150);
        const input = resolved.el as HTMLInputElement | HTMLTextAreaElement;
        input.focus();
        // Set value through the native setter so React/Vue state updates fire.
        const setter = Object.getOwnPropertyDescriptor(
          input.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype,
          'value',
        )?.set;
        if (setter) setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          type: 'ACTION_RESULT',
          payload: {
            success: true,
            description: `Typed "${text.slice(0, 40)}" into element via ${resolved.reason}.`,
          },
        };
      }

      case 'scroll_page': {
        const direction = String(params.direction ?? 'down');
        const amount = typeof params.amount === 'number' ? params.amount : 600;
        window.scrollBy({
          top: direction === 'up' ? -amount : amount,
          behavior: 'smooth',
        });
        return {
          type: 'ACTION_RESULT',
          payload: {
            success: true,
            description: `Scrolled ${direction} by ${amount}px.`,
          },
        };
      }

      case 'press_key': {
        const key = String(params.key ?? 'Enter');
        const target =
          (document.activeElement as Element | null) ?? document.body;
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
        target.dispatchEvent(
          new KeyboardEvent('keyup', { key, bubbles: true }),
        );
        return {
          type: 'ACTION_RESULT',
          payload: {
            success: true,
            description: `Pressed key "${key}".`,
          },
        };
      }

      default:
        return {
          type: 'ACTION_RESULT',
          payload: {
            success: false,
            description: `Unknown action: ${action}`,
          },
        };
    }
  } catch (error) {
    return {
      type: 'ACTION_RESULT',
      payload: {
        success: false,
        description: `Action failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Message listener                                                    */
/* ------------------------------------------------------------------ */

function replyTool(
  requestId: string | undefined,
  response: ContentScriptResponse,
): void {
  if (!requestId) return;
  // One-way reply: the background awaits this through a request-id-keyed
  // listener, so no callback port needs to stay open. This avoids the MV3
  // "message port closed before a response was received" race that occurs
  // when chrome.scripting.executeScript waits on a sendMessage callback.
  console.log('[cs] sending TOOL_RESPONSE for', requestId, 'type=', response.type);
  chrome.runtime.sendMessage({
    type: 'TOOL_RESPONSE',
    requestId,
    payload: response,
  });
}

chrome.runtime.onMessage.addListener(
  (
    request: ContentScriptRequest,
    _sender,
    sendResponse: (response: ContentScriptResponse) => void,
  ) => {
    if (request.type === 'GET_PAGE_CONTEXT') {
      if (request.requestId) {
        replyTool(request.requestId, extractPageContext());
      } else {
        sendResponse(extractPageContext());
      }
      return false; // synchronous response
    }
    if (request.type === 'READ_VIDEO_CONTEXT') {
      // Async: fetching captions may hit the network.
      extractVideoContext().then((response) => {
        if (request.requestId) {
          replyTool(request.requestId, response);
        } else {
          sendResponse(response);
        }
      });
      return true; // keep the message channel open
    }
    if (request.type === 'EXECUTE_ACTION') {
      // Asynchronous actions resolve via async sendResponse.
      executeAction(request.payload.action, request.payload.params).then(
        (response) => {
          if (request.requestId) {
            replyTool(request.requestId, response);
          } else {
            sendResponse(response);
          }
        },
      );
      return true; // keep the message channel open
    }
    return false;
  },
);
