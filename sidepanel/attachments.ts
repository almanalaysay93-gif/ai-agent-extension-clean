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
 * 8 MB per file as picked from disk. Images are downscaled below
 * MAX_IMAGE_BYTES before they are sent, so a large screenshot is accepted
 * rather than rejected.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling on the encoded image actually sent. Vision providers commonly
 * reject images past ~5 MB, and base64 adds a third on top, so keep the
 * encoded payload well under that.
 */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** Longest edge kept when an image is downscaled — plenty for OCR-grade reads. */
const MAX_IMAGE_EDGE = 1568;

/**
 * Cap on inlined file text. A few hundred KB of text is already a large
 * prompt; without a cap a 6 MB log becomes ~1.5M tokens and every model
 * rejects the request.
 */
export const MAX_TEXT_CHARS = 100_000;

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

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Shrinks an image that is larger than the send ceiling or longer than
 * MAX_IMAGE_EDGE, re-encoding as JPEG. Returns the original data URL when no
 * shrink is needed, or when the browser cannot decode the file (SVG, exotic
 * formats), which then falls back to the size check in readAttachment.
 */
async function encodeImage(file: File): Promise<{ dataUrl: string; resized: boolean }> {
  const needsShrink = file.size > MAX_IMAGE_BYTES;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { dataUrl: await readAsDataUrl(file), resized: false };
  }

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, MAX_IMAGE_EDGE / longest);
  if (!needsShrink && scale === 1) {
    bitmap.close();
    return { dataUrl: await readAsDataUrl(file), resized: false };
  }

  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  );
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return { dataUrl: await readAsDataUrl(file), resized: false };
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  // Step the quality down until the encoded image clears the ceiling.
  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (blob.size <= MAX_IMAGE_BYTES) {
      return { dataUrl: await readAsDataUrl(blob), resized: true };
    }
  }
  const last = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.4 });
  return { dataUrl: await readAsDataUrl(last), resized: true };
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
    const raw = await file.text();
    if (raw.length <= MAX_TEXT_CHARS) return { ...base, text: raw };
    return {
      ...base,
      truncated: true,
      text:
        raw.slice(0, MAX_TEXT_CHARS) +
        `\n\n[... truncated: ${file.name} is ${raw.length.toLocaleString()} characters, ` +
        `only the first ${MAX_TEXT_CHARS.toLocaleString()} were sent ...]`,
    };
  }

  if (kind === 'image') {
    const { dataUrl, resized } = await encodeImage(file);
    // Undecodable images (SVG, corrupt files) skip the downscale path, so
    // check the encoded size here rather than sending something a provider
    // will reject.
    if (dataUrl.length > MAX_IMAGE_BYTES * 1.4) {
      throw new Error(
        `${file.name} could not be shrunk below ${formatSize(MAX_IMAGE_BYTES)}. Try a smaller image.`,
      );
    }
    return { ...base, dataUrl, truncated: resized };
  }

  const dataUrl = await readAsDataUrl(file);
  if (dataUrl.length > MAX_ATTACHMENT_BYTES * 1.4) {
    throw new Error(`${file.name} is too large to send.`);
  }
  return { ...base, dataUrl };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
