import { useEffect, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { OPENROUTER_BASE_URL } from '../../src/shared/openrouter';

type Model = {
  id: string;
  name?: string;
};

const QUICK_MODELS: string[] = [
  'deepseek/deepseek-v4-flash',
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-haiku-4.5',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'meta-llama/llama-3.3-70b-instruct',
  'deepseek/deepseek-chat',
  'mistralai/mistral-small-3.1-24b-instruct',
];

type Props = {
  value: string;
  onChange: (model: string) => void;
};

/**
 * A two-tier model selector: a curated quick list plus the full OpenRouter
 * catalog loaded dynamically from /api/v1/models.
 */
export default function ModelSelector({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (loaded) return;
      setLoading(true);
      try {
        const response = await fetch(`${OPENROUTER_BASE_URL}/models`);
        if (!response.ok) return;
        const data = (await response.json()) as {
          data?: { id: string; name?: string }[];
        };
        if (!cancelled) {
          setCatalog(data.data ?? []);
          setLoaded(true);
        }
      } catch {
        // Silently fall back to the curated list.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    // Load lazily when the selector is opened.
    if (open) void load();
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  const currentLabel =
    QUICK_MODELS.includes(value) || loaded
      ? value
      : `${value} (custom)`;

  const filtered = search.trim()
    ? catalog.filter((m) =>
        m.id.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : catalog;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="ms-model-btn w-auto px-2.5 py-1.5 text-left text-xs text-[#5b5b56]"
      >
        <span className="truncate font-medium">{currentLabel}</span>
        {loading ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[#9b9b94]" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 text-[#9b9b94]" />
        )}
      </button>

      {open && (
        <div
          className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-72 overflow-hidden rounded-xl border border-[#e7e7e4] bg-white shadow-lg"
        >
          <div className="border-b border-[#e7e7e4] p-1.5">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models…"
              className="w-full rounded-lg border border-[#e7e7e4] bg-white px-2 py-1 text-xs text-[#1a1a1a] outline-none focus:border-[#c9c9c3]"
            />
          </div>
          <div className="max-h-60 overflow-y-auto">
            {!search && (
              <>
                <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#9b9b94]">
                  Quick pick
                </div>
                {QUICK_MODELS.map((id) => (
                  <button
                    key={`q-${id}`}
                    type="button"
                    onClick={() => {
                      onChange(id);
                      setOpen(false);
                    }}
                    className={`block w-full px-2.5 py-1.5 text-left text-xs transition-colors ${
                      value === id
                        ? 'bg-[#f0f0ee] font-medium text-[#1a1a1a]'
                        : 'text-[#3d3d38] hover:bg-[#f7f7f6]'
                    }`}
                  >
                    {id}
                  </button>
                ))}
              </>
            )}
            <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#9b9b94]">
              All OpenRouter models
            </div>
            {filtered.slice(0, 500).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={`block w-full px-2.5 py-1.5 text-left text-xs ${
                  value === m.id
                    ? 'bg-[#f0f0ee] font-medium text-[#1a1a1a]'
                    : 'text-[#3d3d38] hover:bg-[#f7f7f6]'
                }`}
              >
                {m.id}
              </button>
            ))}
            {filtered.length === 0 && !loading && (
              <div className="px-2.5 py-2 text-xs text-indigo-200/50">
                No models found.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
