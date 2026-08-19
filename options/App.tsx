import { useEffect, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  GripVertical,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Wand2,
} from 'lucide-react';
import {
  generateSkillId,
  getSettings,
  type Skill,
  STORAGE_KEYS,
} from '../src/shared/storage';
import { OPENROUTER_BASE_URL } from '../src/shared/openrouter';

const EXAMPLE_SKILLS: { name: string; description: string; instructions: string }[] = [
  {
    name: 'Page to slides',
    description:
      'Turn the current page (or video transcript) into a PowerPoint deck and download it as a .pptx file.',
    instructions:
      '1. Get the page context with get_page_context; if the page is a video page (YouTube, Vimeo, or has a <video>), call read_video_context instead to get the transcript.\n2. Distill the content into 4-8 slides worth of key points.\n3. Call create_pptx with slides: [{title, bullets: [string]}] — keep each bullet under ~12 words and put at most 6 bullets per slide.\n4. Confirm the file was downloaded and tell the user where it landed (Downloads folder).',
  },
  {
    name: 'Video reader',
    description:
      'Understand and summarize any video: YouTube transcripts, caption files, or generic video metadata.',
    instructions:
      '1. On any video page (YouTube watch, Vimeo, or pages with HTML5 <video>), call read_video_context.\n2. If the result includes transcriptText, summarize the video from the transcript and include a few timestamped highlights.\n3. If only video_metadata is available, describe what is known (duration, playback state, source) and politely explain that the video has no captions available.\n4. Never invent what happens in a video you could not read.',
  },
  {
    name: 'Search and summarize',
    description: 'When asked to research a topic, use Google, collect results, and summarize them.',
    instructions:
      "1. Use get_page_context on the current page if it is a search engine or relevant source.\n2. If no useful context exists, use open_url to navigate to a search engine and type_text the query into the search box, then press_key Enter.\n3. Re-fetch page context after loading results.\n4. Open the 2-3 most relevant results one at a time with open_url and summarize each.\n5. Return a concise summary with source URLs.",
  },
  {
    name: 'Fill forms',
    description: 'Carefully complete web forms field by field.',
    instructions:
      "1. Get the page context first to see all form fields.\n2. Fill fields in order using type_text with the values the user provided; if a value is missing, ask the user.\n3. After each field, confirm the value landed in the right input by re-fetching context when uncertain.\n4. Click the submit button with click_element only after every required field is filled.",
  },
];

const EMPTY_SKILL: Skill = {
  id: '',
  name: '',
  description: '',
  instructions: '',
  enabled: true,
};

export default function OptionsPage() {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState('openai/gpt-4o-mini');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [saved, setSaved] = useState(false);
  const [skillsSaved, setSkillsSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{
    kind: 'ok' | 'error';
    message: string;
  } | null>(null);

  // Skill editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Skill>(EMPTY_SKILL);

  useEffect(() => {
    getSettings()
      .then((settings) => {
        setApiKey(settings.apiKey);
        setModel(settings.model);
        setSkills(settings.skills);
      })
      .finally(() => setLoading(false));
  }, []);

  /* ------------------------------------------------------------------ */
  /* API key / model                                                     */
  /* ------------------------------------------------------------------ */

  const validateKey = (key: string): string | null => {
    const trimmed = key.trim();
    if (!trimmed) return 'The API key cannot be empty.';
    if (trimmed.length < 20) return 'This does not look like a valid OpenRouter key (sk-or-…).';
    if (!trimmed.startsWith('sk-or-'))
      return 'OpenRouter keys should start with sk-or-.';
    return null;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const error = validateKey(apiKey);
    if (error) {
      setStatus({ kind: 'error', message: error });
      setSaved(false);
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.apiKey]: apiKey.trim(),
        [STORAGE_KEYS.model]: model.trim() || 'openai/gpt-4o-mini',
      });

      const probe = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      });
      if (!probe.ok) {
        if (probe.status === 401 || probe.status === 403) {
          setStatus({ kind: 'error', message: 'The key was rejected by OpenRouter (401/403). Please check it.' });
          setSaved(false);
          setSaving(false);
          return;
        }
        setStatus({ kind: 'ok', message: 'Saved, but the key could not be verified right now.' });
      } else {
        setStatus({ kind: 'ok', message: 'API key saved and verified. The side panel is ready to use.' });
      }
      setSaved(true);
    } catch {
      setStatus({ kind: 'error', message: 'Failed to save settings. Please try again.' });
      setSaved(false);
    } finally {
      setSaving(false);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Skills                                                              */
  /* ------------------------------------------------------------------ */

  const persistSkills = async (next: Skill[]) => {
    setSkills(next);
    setSkillsSaved(false);
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.skills]: next });
      setSkillsSaved(true);
      setTimeout(() => setSkillsSaved(false), 2500);
    } catch {
      setStatus({ kind: 'error', message: 'Failed to save skills. Please try again.' });
    }
  };

  const openNewSkill = () => {
    setEditing({ ...EMPTY_SKILL, id: generateSkillId() });
    setEditorOpen(true);
  };

  const openEditSkill = (skill: Skill) => {
    setEditing({ ...skill });
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditing(EMPTY_SKILL);
  };

  const saveSkill = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing.name.trim()) return;
    if (!editing.id) editing.id = generateSkillId();
    const exists = skills.some((s) => s.id === editing.id);
    const next = exists
      ? skills.map((s) => (s.id === editing.id ? editing : s))
      : [...skills, editing];
    void persistSkills(next);
    closeEditor();
  };

  const deleteSkill = (id: string) => {
    void persistSkills(skills.filter((s) => s.id !== id));
    if (editing.id === id) closeEditor();
  };

  const toggleSkill = (id: string) => {
    void persistSkills(
      skills.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
    );
  };

  const addExample = (example: (typeof EXAMPLE_SKILLS)[number]) => {
    if (skills.some((s) => s.name === example.name)) return;
    void persistSkills([
      ...skills,
      {
        id: generateSkillId(),
        name: example.name,
        description: example.description,
        instructions: example.instructions,
        enabled: true,
      },
    ]);
  };

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading settings…
      </div>
    );
  }

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <div className="app-shell min-h-screen py-12">
      <div className="mx-auto w-full max-w-xl px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-[0_4px_14px_rgba(99,102,241,0.5)]">
            <Bot className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white">
              AlAi Agent — Options
            </h1>
            <p className="text-sm text-indigo-100/70">
              Configure your OpenRouter connection and agent skills.
            </p>
          </div>
        </div>

        {/* ---------- Connection ---------- */}
        <form onSubmit={handleSave} className="glass mt-8 space-y-5 rounded-2xl p-6">
          <div>
            <label
              htmlFor="api-key"
              className="mb-1.5 block text-sm font-medium text-indigo-100/90"
            >
              OpenRouter API key
            </label>
            <div className="relative">
              <input
                id="api-key"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setSaved(false);
                }}
                placeholder="sk-or-…"
                autoComplete="off"
                spellCheck={false}
                className="glass-input w-full rounded-lg py-2 pr-10 pl-3 text-sm"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="glass-btn absolute top-1/2 right-2 -translate-y-1/2 h-7 w-7 p-0"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-indigo-100/60">
              Get your key free at{' '}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 underline"
              >
                openrouter.ai/keys
              </a>
              . It is stored locally in chrome.storage and never leaves your
              browser except in requests to OpenRouter.
            </p>
          </div>

          <div>
            <label
              htmlFor="model"
              className="mb-1.5 block text-sm font-medium text-indigo-100/90"
            >
              Default model
            </label>
            <input
              id="model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="openai/gpt-4o-mini"
              spellCheck={false}
              className="glass-input w-full rounded-lg px-3 py-2 text-sm"
            />
            <p className="mt-1.5 text-xs text-indigo-100/60">
              Use the model selector in the side panel to switch models
              per-conversation. Any valid OpenRouter model id works here.
            </p>
          </div>

          {status && (
            <div
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                status.kind === 'ok'
                  ? 'border border-emerald-300/30 bg-emerald-400/15 text-emerald-100'
                  : 'border border-red-300/30 bg-red-400/15 text-red-100'
              }`}
            >
              {status.kind === 'ok' ? (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              ) : (
                <ShieldCheck className="h-4 w-4 shrink-0" />
              )}
              {status.message}
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="glass-btn-primary inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : saved ? (
              <>
                <CheckCircle2 className="h-4 w-4" />
                Saved
              </>
            ) : (
              'Save settings'
            )}
          </button>
        </form>

        {/* ---------- Skills ---------- */}
        <div className="glass mt-8 rounded-2xl p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400/20 text-amber-200 ring-1 ring-amber-300/30">
                <Wand2 className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-white">Skills</h2>
                <p className="text-xs text-indigo-100/60">
                  Reusable instruction sets the agent follows when acting on the
                  page. {enabledCount} enabled.
                </p>
              </div>
            </div>
            <button
              onClick={openNewSkill}
              className="glass-btn-primary inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"
            >
              <Plus className="h-3.5 w-3.5" />
              Add skill
            </button>
          </div>

          {/* Editor */}
          {editorOpen && (
            <form
              onSubmit={saveSkill}
              className="glass-subtle mt-5 space-y-4 rounded-xl p-4"
            >
              <div>
                <label htmlFor="skill-name" className="mb-1 block text-sm font-medium text-indigo-100/90">
                  Name
                </label>
                <input
                  id="skill-name"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="e.g. LinkedIn outreach"
                  spellCheck={false}
                  className="glass-input w-full rounded-lg px-3 py-2 text-sm focus:border-amber-400/70 focus:shadow-[0_0_0_3px_rgba(251,191,36,0.2)]"
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="skill-desc" className="mb-1 block text-sm font-medium text-indigo-100/90">
                  Short description
                </label>
                <input
                  id="skill-desc"
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  placeholder="When to use this skill"
                  spellCheck={false}
                  className="glass-input w-full rounded-lg px-3 py-2 text-sm focus:border-amber-400/70 focus:shadow-[0_0_0_3px_rgba(251,191,36,0.2)]"
                />
              </div>
              <div>
                <label htmlFor="skill-instructions" className="mb-1 block text-sm font-medium text-indigo-100/90">
                  Instructions
                </label>
                <textarea
                  id="skill-instructions"
                  rows={7}
                  value={editing.instructions}
                  onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
                  placeholder={"Step-by-step instructions the agent follows, e.g.:\n1. Get the page context to see the form fields.\n2. type_text the user's name into #full-name.\n3. click_element the submit button."}
                  spellCheck={false}
                  className="glass-input w-full rounded-lg px-3 py-2 font-mono text-xs leading-relaxed focus:border-amber-400/70 focus:shadow-[0_0_0_3px_rgba(251,191,36,0.2)]"
                />
                <p className="mt-1 text-xs text-indigo-100/60">
                  Reference the built-in tools: click_element, type_text,
                  scroll_page, press_key, get_page_context, open_url.
                </p>
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={closeEditor}
                  className="glass-btn px-3 py-1.5 text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!editing.name.trim() || !editing.instructions.trim()}
                  className="glass-btn-primary bg-gradient-to-br from-amber-500/90 to-orange-500/90 border-amber-300/50 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                >
                  Save skill
                </button>
              </div>
            </form>
          )}

          {/* Skill list */}
          <ul className="mt-5 divide-y divide-white/10">
            {skills.length === 0 && !editorOpen && (
              <li className="py-6 text-center text-sm text-indigo-100/50">
                No skills yet. Add one to teach the agent common workflows, or
                start from an example below.
              </li>
            )}
            {skills.map((skill) => {
              const open = editing.id === skill.id && editorOpen;
              return (
                <li key={skill.id} className="py-3">
                  <div className="flex items-start gap-3">
                    <GripVertical className="mt-1 h-4 w-4 shrink-0 text-indigo-200/40" />
                    <button
                      type="button"
                      onClick={() => toggleSkill(skill.id)}
                      className="mt-0.5 shrink-0"
                      aria-label={skill.enabled ? 'Disable skill' : 'Enable skill'}
                    >
                      {skill.enabled ? (
                        <ToggleRight className="h-6 w-6 text-indigo-300" />
                      ) : (
                        <ToggleLeft className="h-6 w-6 text-indigo-200/30" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-medium ${skill.enabled ? 'text-white' : 'text-indigo-200/40 line-through'}`}
                        >
                          {skill.name}
                        </span>
                      </div>
                      {skill.description && (
                        <p className={`mt-0.5 text-xs ${skill.enabled ? 'text-indigo-100/70' : 'text-indigo-200/30'}`}>
                          {skill.description}
                        </p>
                      )}
                      {open && (
                        <pre className="glass-inset mt-2 whitespace-pre-wrap rounded-lg p-2 text-xs text-indigo-100/80">
                          {skill.instructions}
                        </pre>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => (open ? closeEditor() : openEditSkill(skill))}
                      className="shrink-0 text-indigo-200/50 hover:text-white"
                      aria-label={open ? 'Collapse skill' : 'Expand skill'}
                    >
                      {open ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSkill(skill.id)}
                      className="shrink-0 text-indigo-200/30 hover:text-red-300"
                      aria-label="Delete skill"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Examples */}
          {EXAMPLE_SKILLS.length > 0 && (
              <div className="mt-5 border-t border-white/10 pt-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-indigo-300/60">
                Example skills
              </p>
              <div className="flex flex-wrap gap-2">
                {EXAMPLE_SKILLS.map((example) => {
                  const exists = skills.some((s) => s.name === example.name);
                  return (
                    <button
                      key={example.name}
                      type="button"
                      onClick={() => addExample(example)}
                      disabled={exists}
                      className="glass-chip px-3 py-1 text-xs transition-colors hover:bg-indigo-400/25 disabled:cursor-default disabled:opacity-50"
                    >
                      {exists ? `✓ ${example.name}` : `+ ${example.name}`}
                    </button>
                  );
                })}
              </div>
              {skillsSaved && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-200">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Skills saved — the agent picks them up on the next message.
                </p>
              )}
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-indigo-100/40">
          AlAi Agent · powered by OpenRouter
        </p>
      </div>
    </div>
  );
}
