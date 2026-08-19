/**
 * Lightweight OpenRouter client that works in both the extension service
 * worker and the side panel (fetch-based, no node dependencies).
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Multimodal content parts, per the OpenRouter chat-completions schema.
 * A message either carries plain text or an ordered array of parts.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  tool_call_id?: string;
  name?: string;
};

/**
 * OpenRouter plugin declarations sent alongside a request. Only used for the
 * file parser today: PDFs are extracted with the free "pdf-text" engine
 * unless the caller asks for OCR.
 */
export type OpenRouterPlugin = {
  id: string;
  pdf?: { engine: 'pdf-text' | 'mistral-ocr' | 'native' };
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type AssistantChunk = {
  delta: string;
  toolCalls?: ToolCall[];
  stopReason?: string | null;
};

/**
 * Flattens a message's content to plain text. Assistant replies always come
 * back as a string, but the type allows parts, so narrow in one place.
 */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function validateKey(apiKey: string): void {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      'OpenRouter API key is missing. Please add it on the Options page.',
    );
  }
}

/**
 * Chat completion without tool calling (used for streaming answers).
 */
export async function chatCompletion(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
  plugins?: OpenRouterPlugin[],
): Promise<{ text: string; stopReason: string | null }> {
  validateKey(apiKey);

  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://open-ai-agent-extension.example',
      'X-Title': 'AlAi Agent Extension',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(plugins && plugins.length > 0 ? { plugins } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `OpenRouter request failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  return streamSSE(response, onDelta);
}

/**
 * Chat completion with tool calling (non-streaming, used by the agentic loop).
 * Returns the assistant message with optional tool_calls.
 */
export async function chatCompletionWithTools(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: object[],
  signal?: AbortSignal,
  plugins?: OpenRouterPlugin[],
): Promise<{ message: ChatMessage; stopReason: string | null }> {
  validateKey(apiKey);

  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://open-ai-agent-extension.example',
      'X-Title': 'AlAi Agent Extension',
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      ...(plugins && plugins.length > 0 ? { plugins } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `OpenRouter request failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  const data = (await response.json()) as {
    choices?: {
      message?: ChatMessage & { tool_calls?: ToolCall[] };
      finish_reason?: string;
    }[];
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  const choice = data.choices?.[0];
  const message = choice?.message ?? { role: 'assistant', content: '' };
  if (choice?.message?.tool_calls) {
    message.tool_calls = choice.message.tool_calls;
  }
  return {
    message,
    stopReason: choice?.finish_reason ?? null,
  };
}

/**
 * Fetch the full model catalog from OpenRouter.
 */
export async function listModels(): Promise<
  { id: string; name?: string; description?: string }[]
> {
  const response = await fetch(`${OPENROUTER_BASE_URL}/models`);
  if (!response.ok) {
    throw new Error(`Failed to fetch models (${response.status})`);
  }
  const data = (await response.json()) as {
    data?: { id: string; name?: string; description?: string }[];
  };
  const models = data.data ?? [];
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Parse an SSE stream and yield assistant text deltas + tool calls.
 */
async function streamSSE(
  response: Response,
  onDelta: (delta: string) => void,
): Promise<{ text: string; stopReason: string | null }> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response has no readable body');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stopReason: string | null = null;

  try {
    // Read the whole stream; parse chunks incrementally.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          stopReason = 'stop';
          continue;
        }
        try {
          const chunk = JSON.parse(payload) as {
            choices?: {
              delta?: { content?: string; tool_calls?: ToolCall[] };
              finish_reason?: string | null;
            }[];
          };
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            text += delta.content;
            onDelta(delta.content);
          }
          if (chunk.choices?.[0]?.finish_reason) {
            stopReason = chunk.choices[0].finish_reason ?? null;
          }
        } catch {
          // Ignore malformed SSE frames.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text, stopReason };
}
