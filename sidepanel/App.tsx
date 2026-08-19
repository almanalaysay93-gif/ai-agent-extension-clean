import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ModelSelector from './components/ModelSelector';
import type { SidePanelEvent, SidePanelRequest } from '../src/shared/messages';

type Message = {
  role: 'user' | 'assistant';
  text: string;
};

type SettingsState = {
  model: string;
  readPageContext: boolean;
};

const SUGGESTIONS: { label: string; prompt: string }[] = [
  { label: 'Summarize', prompt: 'Summarize this page in 3-4 bullet points.' },
  {
    label: 'Find & click',
    prompt: 'Find the login button on this page and click it.',
  },
  { label: 'Extract data', prompt: 'Extract the main data from this page into a table.' },
  { label: 'Explain', prompt: 'Explain what this page is about in plain language.' },
  { label: 'Read video', prompt: 'Read this video and tell me what it says.' },
  { label: 'Make slides', prompt: 'Turn this page into a PowerPoint presentation.' },
];

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsState>({
    model: 'openai/gpt-4o-mini',
    readPageContext: true,
  });
  const [pageContext, setPageContext] = useState<{
    title: string;
    url: string;
  } | null>(null);
  const [fetchingContext, setFetchingContext] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef('');

  useEffect(() => {
    draftRef.current = input;
  }, [input]);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const send = useCallback((request: SidePanelRequest) => {
    chrome.runtime.sendMessage(request).catch(() => {
      setError('Lost connection to the background service worker.');
    });
  }, []);

  // Listen for events from the background service worker.
  useEffect(() => {
    // Visual guard: never keep the header spinner forever. If the page read
    // hasn't resolved within ~18s, fall back to the "no context" state so
    // the UI stays usable. A later read can still arrive and update it.
    const guardTimer = window.setTimeout(() => setFetchingContext(false), 18000);

    const listener = (event: SidePanelEvent) => {
      if (!event || typeof event !== 'object' || !event.type) return;

      switch (event.type) {
        case 'ROLE_DELTA': {
          const { role, delta } = event.payload;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === role) {
              last.text += delta;
              return next;
            }
            return [...next, { role, text: delta }];
          });
          break;
        }
        case 'MESSAGE_COMPLETE': {
          const { role, text } = event.payload;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === role) {
              last.text = text;
              return next;
            }
            return [...next, { role, text }];
          });
          break;
        }
        case 'AGENT_ACTION':
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              text: `*Agent: ${event.payload.description}*\n\n`,
            },
          ]);
          break;
        case 'ERROR':
          setError(event.payload.message);
          break;
        case 'BUSY':
          setBusy(event.payload.busy);
          break;
        case 'SETTINGS':
          setSettings({
            model: event.payload.model,
            readPageContext: event.payload.readPageContext,
          });
          break;
        case 'PAGE_CONTEXT':
          setPageContext({ title: event.payload.title, url: event.payload.url });
          setFetchingContext(false);
          break;
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    // Bootstrap: pull persisted settings and the page context.
    chrome.storage.local
      .get(['openrouter_model', 'read_page_context'])
      .then((data) => {
        setSettings({
          model: (data.openrouter_model as string) ?? 'openai/gpt-4o-mini',
          readPageContext: (data.read_page_context as boolean) ?? true,
        });
      })
      .catch(() => undefined);
    send({ type: 'GET_PAGE_CONTEXT' });
    setFetchingContext(true);

    return () => {
      window.clearTimeout(guardTimer);
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [send]);

  const handleSubmit = (e?: React.FormEvent, overrideText?: string) => {
    if (e) e.preventDefault();
    const text = (overrideText ?? draftRef.current).trim();
    if (!text || busy) return;
    setInput('');
    setError(null);
    send({ type: 'SEND_MESSAGE', payload: { text } });
  };

  const handleStop = () => send({ type: 'STOP' });
  const handleClear = () => {
    setMessages([]);
    send({ type: 'CLEAR_HISTORY' });
  };

  const toggleContext = () => {
    const next = !settings.readPageContext;
    setSettings((s) => ({ ...s, readPageContext: next }));
    chrome.storage.local.set({ read_page_context: next }).catch(() => undefined);
    if (next) {
      setFetchingContext(true);
      send({ type: 'GET_PAGE_CONTEXT' });
    } else {
      setPageContext(null);
    }
  };

  const refetchContext = () => {
    setFetchingContext(true);
    setError(null);
    send({ type: 'GET_PAGE_CONTEXT' });
  };

  const contextLabel = (() => {
    if (fetchingContext) return 'Reading the page…';
    if (pageContext) return pageContext.title || 'Page loaded';
    return 'No page context available';
  })();

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="ms-header">
        <div className="ms-welcome-logo" style={{ height: 30, width: 30, borderRadius: 8 }}>
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="ms-header-title">AlAi Agent</h1>
          <p className="ms-header-sub">{contextLabel}</p>
        </div>
        {fetchingContext ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 ms-spin" style={{ color: '#9b9b94' }} />
        ) : (
          <button
            onClick={refetchContext}
            title="Re-read the current page"
            className="ms-btn"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
        <button onClick={handleClear} title="Clear conversation" className="ms-btn">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => chrome.runtime.openOptionsPage()}
          title="Open options"
          className="ms-btn"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* Context status row */}
      <div className="ms-context-row">
        <button
          onClick={toggleContext}
          className="ms-context-switch"
          data-on={settings.readPageContext}
          aria-pressed={settings.readPageContext}
        >
          <span className="ms-switch-thumb" />
        </button>
        <span className="ms-context-label">
          {settings.readPageContext ? 'Reads page context' : 'Page context off'}
        </span>
        <span className="ms-context-chip">
          {settings.model.split('/').pop() ?? settings.model}
        </span>
      </div>

      {/* Chat */}
      <div ref={scrollRef} className="ms-chat">
        {messages.length === 0 && !busy && (
          <div className="ms-welcome">
            <div className="ms-welcome-logo">
              <Sparkles className="h-5 w-5" />
            </div>
            <h2 className="ms-welcome-heading">What can I do for you?</h2>
            <p className="ms-welcome-text">
              Ask anything about the current page, or tell the agent to do
              something — it can click, type, scroll and navigate for you.
            </p>
            <div className="ms-chips">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  className="ms-chip"
                  onClick={() => handleSubmit(undefined, s.prompt)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {!pageContext && !fetchingContext && (
              <div className="ms-error" style={{ maxWidth: 340 }}>
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="flex-1">
                  Couldn't read this page yet. Try{' '}
                  <button
                    onClick={refetchContext}
                    className="ms-error-dismiss"
                  >
                    reading it again
                  </button>{' '}
                  or reload the tab. Heavy pages may take a moment.
                </div>
              </div>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className="ms-msg">
            <div
              className={`ms-avatar ${msg.role === 'user' ? 'ms-avatar-user' : 'ms-avatar-assistant'}`}
            >
              {msg.role === 'user' ? <Plus className="h-3 w-3" /> : <Bot className="h-3.5 w-3.5" />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ms-label">
                {msg.role === 'user' ? 'You' : 'AlAi Agent'}
              </div>
              <div
                className={`ms-bubble ${msg.role === 'user' ? 'ms-bubble-user' : 'ms-bubble-assistant'}`}
              >
                {msg.role === 'assistant' ? (
                  <div className="prose-chat">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.text}
                    </ReactMarkdown>
                  </div>
                ) : (
                  msg.text
                )}
              </div>
            </div>
          </div>
        ))}

        {busy && messages.length > 0 && (
          <div className="ms-msg">
            <div className="ms-avatar ms-avatar-assistant">
              <Bot className="h-3.5 w-3.5" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ms-typing">
                <div className="ms-dots">
                  <span />
                  <span />
                  <span />
                </div>
                <span style={{ fontSize: 12, color: '#8a8a84' }}>
                  AlAi is working…
                </span>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="ms-error">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div style={{ flex: 1 }}>{error}</div>
            <div className="ms-error-actions">
              <button
                onClick={() => {
                  setError(null);
                  setFetchingContext(true);
                  send({ type: 'GET_PAGE_CONTEXT' });
                }}
                className="ms-error-retry"
                title="Try reading the page again"
              >
                Re-read page
              </button>
              <button onClick={() => setError(null)} className="ms-error-dismiss">
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="ms-composer-area">
        <div className="ms-model-row">
          <ModelSelector
            value={settings.model}
            onChange={(model) => {
              setSettings((s) => ({ ...s, model }));
              chrome.storage.local
                .set({ openrouter_model: model })
                .catch(() => undefined);
            }}
          />
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'contents' }}>
          <div className="ms-composer">
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Auto-grow: expand to fit the text, capped by CSS max-height.
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder={pageContext ? 'Ask about this page or tell me what to do…' : 'Message the agent…'}
              rows={1}
              className="ms-input"
            />
            {busy ? (
              <button
                type="button"
                onClick={handleStop}
                className="ms-stop-btn"
                title="Stop"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="ms-send-btn"
                title="Send"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export default App;
