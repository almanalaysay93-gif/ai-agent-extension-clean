/**
 * Composer attachments: turn a picked File into the wire shape the background
 * sends to OpenRouter.
 *
 * Images and PDFs travel as base64 data URLs (OpenRouter's multimodal content
 * parts take data URLs directly). Everything else is read as text in the panel
 * and inlined into the prompt, which works on every model with no parser
 * plugin and no per-page charge.
 */
import type { Attachment } from '../src/shared/messages';

/**
 * 8 MB per file. Base64 inflates by roughly a third, and the encoded payload
 * rides inside a single chrome.runtime message, so this keeps a comfortable
 * margin under the messaging limit.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Cap on files per message, to keep one send from blowing the token budget. */
export const MAX_ATTACHMENTS = 5;

/** Text-ish files by extension, for types the OS reports as octet-stream. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'xml', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'r', 'sql',
  'sh', 'bat', 'ps1', 'ini', 'toml', 'cfg', 'log', 'srt', 'vtt',
]);

export function classify(file: File): Attachment['kind'] | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type.startsWith('text/')) return 'text';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (file.type === 'application/json') return 'text';
  return null;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Reads one file into an Attachment. Throws with a message meant for the
 * user: size limits and unsupported types are ordinary outcomes here, not
 * bugs, so the panel shows the reason rather than failing silently.
 */
export async function readAttachment(file: File): Promise<Attachment> {
  const kind = classify(file);
  if (!kind) {
    throw new Error(
      `${file.name}: unsupported file type. Attach images, PDFs, or text files.`,
    );
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    throw new Error(`${file.name} is ${mb} MB. The limit is 8 MB per file.`);
  }

  const base: Attachment = {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    kind,
  };

  if (kind === 'text') {
    return { ...base, text: await file.text() };
  }
  return { ...base, dataUrl: await readAsDataUrl(file) };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
