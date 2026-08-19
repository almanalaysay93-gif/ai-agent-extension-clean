/**
 * Shared storage helper used by the options page, side panel and background
 * service worker. All persistent state lives in chrome.storage.local.
 */

export const STORAGE_KEYS = {
  apiKey: 'openrouter_api_key',
  model: 'openrouter_model',
  readPageContext: 'read_page_context',
  skills: 'agent_skills',
} as const;

export type Skill = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
};

export function generateSkillId(): string {
  return `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getEnabledSkillInstructions(skills: Skill[]): string {
  const enabled = skills.filter((s) => s.enabled && s.instructions.trim());
  if (enabled.length === 0) return '';
  const blocks = enabled
    .map(
      (s) =>
        `## ${s.name.trim() || 'Unnamed skill'}\n\n${s.instructions.trim()}`,
    )
    .join('\n\n---\n\n');
  return `\n\n# Custom Skills\n\n${blocks}\n`;
}

export type Settings = {
  apiKey: string;
  model: string;
  readPageContext: boolean;
  skills: Skill[];
};

export const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export function getSettings(): Promise<Settings> {
  return chrome.storage.local.get([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.model,
    STORAGE_KEYS.readPageContext,
    STORAGE_KEYS.skills,
  ]).then(
    (data) => ({
      apiKey: (data[STORAGE_KEYS.apiKey] as string) ?? '',
      model: (data[STORAGE_KEYS.model] as string) ?? DEFAULT_MODEL,
      readPageContext: (data[STORAGE_KEYS.readPageContext] as boolean) ?? true,
      skills: (Array.isArray(data[STORAGE_KEYS.skills])
        ? (data[STORAGE_KEYS.skills] as Skill[])
        : []) as Skill[],
    }),
    () => ({
      apiKey: '',
      model: DEFAULT_MODEL,
      readPageContext: true,
      skills: [],
    }),
  );
}

export async function patchSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({
    [STORAGE_KEYS.apiKey]: next.apiKey,
    [STORAGE_KEYS.model]: next.model,
    [STORAGE_KEYS.readPageContext]: next.readPageContext,
    [STORAGE_KEYS.skills]: Array.isArray(next.skills) ? next.skills : [],
  });
  return next;
}
