import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ModelSelector from './components/ModelSelector';
import type {
  Attachment,
  SidePanelEvent,
  SidePanelRequest,
} from '../src/shared/messages';
import { formatSize, readAttachment, MAX_ATTACHMENTS } from './attachments';
import { createDictation, type Dictation } from './dictation';

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [listening, setListening] = useState(false);
  const [dragging, setDragging] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dictationRef = useRef<Dictation | null>(null);
  // Text that was already committed when dictation started, so interim
  // results replace each other instead of stacking up in the box.
  const dictationBaseRef = useRef('');
  // The last value dictation itself wrote. If the box no longer matches it,
  // the user typed while the mic was on, and their edit becomes the new base.
  const dictationWroteRef = useRef('');
  const attachmentsRef = useRef<Attachment[]>([]);

  useEffect(() => {
    draftRef.current = input;
  }, [input]);

  /** Keeps the auto-grow height in sync when the value is set from code. */
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, []);

  const setDraft = useCallback(
    (text: string) => {
      setInput(text);
      draftRef.current = text;
      // Height is driven by the input handler during typing; dictation and
      // clearing bypass it, so resize on the next frame once React has painted.
      requestAnimationFrame(resizeTextarea);
    },
    [resizeTextarea],
  );

  /**
   * Mirrors the attachment list synchronously. State updates are batched, so
   * two quick picks would both read the same stale count and slip past the
   * cap; the ref is current the moment it is written.
   */
  const applyAttachments = useCallback(
    (next: (current: Attachment[]) => Attachment[]) => {
      attachmentsRef.current = next(attachmentsRef.current);
      setAttachments(attachmentsRef.current);
    },
    [],
  );

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const picked = [...files];
      if (picked.length === 0) return;

      const read: Attachment[] = [];
      for (const file of picked) {
        try {
          read.push(await readAttachment(file));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      if (read.length === 0) return;

      const room = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length);
      const overflow = read.length - Math.min(read.length, room);
      if (room > 0) {
        applyAttachments((current) => [...current, ...read.slice(0, room)]);
      }
      if (overflow > 0) {
        setError(
          `Only ${MAX_ATTACHMENTS} files fit in one message — ${overflow} were not attached.`,
        );
      }
    },
    [applyAttachments],
  );

  const removeAttachment = (index: number) =>
    applyAttachments((current) => current.filter((_, i) => i !== index));

  const toggleDictation = () => {
    if (!dictationRef.current) {
      dictationRef.current = createDictation({
        onTranscript: (text, isFinal) => {
          // Respect edits made while the mic is on: if the box differs from
          // what dictation last wrote, the user typed, so start from theirs.
          if (draftRef.current !== dictationWroteRef.current) {
            dictationBaseRef.current = draftRef.current.trim();
          }
          const base = dictationBaseRef.current;
          const joined = base ? `${base} ${text}` : text;
          setDraft(joined);
          dictationWroteRef.current = joined;
          if (isFinal) dictationBaseRef.current = joined;
        },
        onError: (message) => setError(message),
        onListeningChange: setListening,
      });
    }
    const dictation = dictationRef.current;
    if (!dictation.supported) {
      setError('This browser has no speech recognition support.');
      return;
    }
    if (dictation.listening()) {
      dictation.stop();
      return;
    }
    setError(null);
    dictationBaseRef.current = draftRef.current.trim();
    dictationWroteRef.current = draftRef.current;
    void dictation.start();
  };

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
    if ((!text && attachments.length === 0) || busy) return;
    if (listening) dictationRef.current?.stop();
    setDraft('');
    dictationBaseRef.current = '';
    setError(null);
    send({
      type: 'SEND_MESSAGE',
      payload: { text, ...(attachments.length > 0 ? { attachments } : {}) },
    });
    applyAttachments(() => []);
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
        {attachments.length > 0 && (
          <div className="ms-attachments">
            {attachments.map((file, index) => (
              <div className="ms-attach-chip" key={`${file.name}-${index}`}>
                {file.kind === 'image' ? (
                  <ImageIcon className="h-3 w-3 shrink-0" />
                ) : (
                  <FileText className="h-3 w-3 shrink-0" />
                )}
                <span className="ms-attach-chip-name" title={file.name}>
                  {file.name}
                </span>
                <span className="ms-attach-chip-size">{formatSize(file.size)}</span>
                <button
                  type="button"
                  className="ms-attach-chip-remove"
                  onClick={() => removeAttachment(index)}
                  title={`Remove ${file.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf,text/*,.md,.csv,.json,.yaml,.yml,.srt,.vtt,.log"
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <form onSubmit={handleSubmit} style={{ display: 'contents' }}>
          <div
            className={`ms-composer ${dragging ? 'ms-composer-dragging' : ''}`}
            // A drop only fires when dragover is cancelled, so the whole
            // composer opts in — dropping anywhere on it attaches the files.
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                if (!dragging) setDragging(true);
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragging(false);
              }
            }}
            onDrop={(e) => {
              setDragging(false);
              if (e.dataTransfer.files.length > 0) {
                e.preventDefault();
                void addFiles(e.dataTransfer.files);
              }
            }}
          >
            <button
              type="button"
              className="ms-icon-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Attach images, PDFs, or text files"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={`ms-icon-btn ${listening ? 'ms-icon-btn-active' : ''}`}
              onClick={toggleDictation}
              title={listening ? 'Stop dictation' : 'Dictate a message'}
            >
              <Mic className="h-3.5 w-3.5" />
            </button>
            <textarea
              ref={textareaRef}
              value={input}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
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
                disabled={!input.trim() && attachments.length === 0}
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
