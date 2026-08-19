# AlAi Agent — Agentic Chrome Extension (Manifest V3)

A production-ready, Manifest V3 Chrome extension that turns any webpage into a workspace for an AI agent. It uses **OpenRouter** as the AI backend and runs an autonomous tool-calling loop that can read the current page, click elements, type text, scroll, press keys, and navigate — all driven by a chat interface in the Chrome Side Panel.

Architecture and best practices were informed by close study of [nanobrowser](https://github.com/nicepkg/nicepkg), [page-assist](https://github.com/nicepkg/page-assist), [midscene](https://github.com/nicepkg/nicepkg), [browser-use](https://github.com/browser-use/browser-use), [stagehand](https://github.com/nicepkg/nicepkg), and [Scrapling](https://github.com/D4Vinci/Scrapling).

## Features

- **Chat with your page.** The Side Panel reads the active tab's DOM (via [@mozilla/readability](https://github.com/mozilla/readability) + Turndown), converts it to clean Markdown, and prepends it as page context so the model answers grounded in what you see.
- **Autonomous tool use.** The background service worker runs an agentic observe–act loop: the model is given `click_element`, `type_text`, `scroll_page`, `press_key`, `open_url`, and `get_page_context` tools, executes them in the active tab through a lightweight content script, and continues until the task is done.
- **Any OpenRouter model.** Pick from the full OpenRouter catalog at runtime (options page or panel), from ultra-cheap frontier models to Claude, GPT, Gemini, Llama, and beyond.
- **Streaming UI.** Assistant text streams token-by-token; agent actions appear as live status chips.
- **Zero external dependencies at runtime.** React + Vite bundle; the extension ships as a static `dist` folder.

## Quick start (load the unpacked extension)

1. Unzip the package and open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select the `dist` folder.
4. Click the extension icon (or the puzzle-piece menu → pin) to open the Side Panel.
5. Go to the **Options page** (right-click the icon → Options), paste your [OpenRouter API key](https://openrouter.ai/keys) (starts with `sk-or-`), optionally pick a model, and save.
5b. On the same Options page, open the **Skills** section to add your own skills: each skill has a name, a short description, and step-by-step instructions that reference the built-in tools (`click_element`, `type_text`, `scroll_page`, `press_key`, `get_page_context`, `open_url`). The agent follows enabled skills as part of its system prompt — you can start from the two included examples.
6. Open any webpage, type a message, and hit Enter — the agent takes it from there.

## One-zip install

The `ai-agent-extension-all-in-one.zip` archive contains everything: the full source plus a ready-to-load `dist/` folder. Unzip it anywhere, then point **Load unpacked** at `ai-agent-extension/dist`.

## Using a real API key

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys). Free-tier models (e.g. `openai/gpt-4o-mini`, `google/gemini-flash-1.5`) work well for testing. The extension sends `HTTP-Referer` and `X-Title` headers so usage shows up under your app in the OpenRouter dashboard.

## Project structure

```
ai-agent-extension/
├── manifest.config.ts      # MV3 manifest source (built to dist/manifest.json)
├── vite.config.ts          # Vite + @crxjs/vite-plugin build config
├── src/
│   ├── background/index.ts # Service worker: agentic tool-calling loop
│   ├── content/index.ts    # Content script: DOM extraction + action executor
│   └── shared/             # OpenRouter client, message protocol, storage helpers
├── sidepanel/              # React chat UI (ModelSelector, streaming bubbles)
├── options/                # API key + model configuration page
└── scripts/                # E2E verification scripts (headless Chromium via CDP)
```

## Architecture overview

| Component | Role |
| --- | --- |
| `sidepanel` (React) | Chat UI; sends `SEND_MESSAGE`/`STOP`/`GET_PAGE_CONTEXT` to the service worker, renders streamed deltas and agent actions. |
| `background` (service worker) | Maintains per-session conversation state; runs the observe–act loop with `MAX_TOOL_STEPS = 10`; calls OpenRouter (streaming for answers, non-streaming with tools for the loop); dispatches tool calls to the active tab. |
| `content` script | Extracts page context (Readability → Turndown Markdown), executes atomic actions (click/type/scroll/keypress) against the DOM using stable, human-readable selectors, and returns results. |
| `shared/openrouter` | Fetch-based client: `chatCompletion` (SSE streaming), `chatCompletionWithTools`, `listModels`. |
| `shared/messages` | Typed request/event protocol between panel, worker, and content script. |
| `shared/storage` | All persistent settings, including user-managed `Skill[]`; `getEnabledSkillInstructions()` formats enabled skills into the agent's system prompt. |

The agent loop follows the midscene/browser-use observe–act pattern: *observe* (page context or previous action result) → *reason with tools* (OpenRouter structured tool use) → *act* (content-script action) → repeat until the model returns plain text.

## Development

```bash
pnpm install
pnpm run build      # outputs dist/
pnpm run dev        # HMR via @crxjs/vite-plugin (use crx:reload helper in Chrome)
```

## Notes

- **Privacy:** your API key never leaves the browser; all requests go directly from the extension to OpenRouter.
- **Manifest V3:** the service worker may go idle after ~30 s of inactivity (Chrome policy); it wakes automatically on the next message. Long conversations are preserved in memory while the panel is open.
- **Permissions:** `sidePanel`, `storage`, `activeTab`, `scripting`, `tabs`, and `host_permissions: <all_urls>` (needed to inject the content script and read page context on any site).
