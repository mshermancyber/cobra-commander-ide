import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve, relative, isAbsolute, basename } from 'node:path';

interface Attachment {
  name: string;
  path: string;
  type: 'text' | 'image' | 'binary';
  content: string;   // text content or base64 for binary/images
  size: number;
  mediaType?: string; // MIME type for images (e.g., 'image/png')
  base64Data?: string; // base64 data for images (without data URI prefix)
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
const TEXT_EXTS = ['.ts', '.js', '.py', '.go', '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.html', '.css', '.sql', '.sh', '.env', '.tsx', '.jsx'];

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

const attachments: Attachment[] = [];

export function readImageAsBase64(filePath: string): { base64: string; mediaType: string } | null {
  const ext = extname(filePath).toLowerCase();
  const mediaType = IMAGE_MIME_TYPES[ext];
  if (!mediaType) return null;
  if (!existsSync(filePath)) return null;
  const buf = readFileSync(filePath);
  return { base64: buf.toString('base64'), mediaType };
}

/**
 * Resolve a path within the allowed workDir, blocking path traversal attempts.
 */
function resolveSafe(filePath: string, workDir: string): string {
  const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(workDir, filePath);
  const relToWork = relative(workDir, resolved);
  if (relToWork.startsWith('..') || isAbsolute(relToWork)) {
    throw new Error(`Path traversal blocked: "${filePath}" is outside the project directory`);
  }
  return resolved;
}

export function addAttachment(filePath: string, workDir: string): Attachment | null {
  const absPath = resolveSafe(filePath, workDir);
  if (!existsSync(absPath)) return null;

  const ext = extname(absPath).toLowerCase();
  const name = basename(absPath);

  let type: 'text' | 'image' | 'binary';
  let content: string;
  let mediaType: string | undefined;
  let base64Data: string | undefined;

  if (IMAGE_EXTS.includes(ext)) {
    type = 'image';
    const buf = readFileSync(absPath);
    content = buf.toString('base64');
    mediaType = IMAGE_MIME_TYPES[ext] || 'image/png';
    base64Data = content;
  } else if (TEXT_EXTS.includes(ext) || ext === '') {
    type = 'text';
    content = readFileSync(absPath, 'utf-8');
    if (content.length > 50000) {
      content = content.slice(0, 50000) + '\n... (truncated)';
    }
  } else {
    type = 'binary';
    const buf = readFileSync(absPath);
    content = buf.toString('base64');
  }

  const size = readFileSync(absPath).length;
  const att: Attachment = { name, path: filePath, type, content, size, mediaType, base64Data };
  attachments.push(att);
  return att;
}

export function getAttachments(): Attachment[] {
  return [...attachments];
}

export function clearAttachments(): void {
  attachments.length = 0;
}

export function formatAttachmentsForPrompt(): string {
  if (attachments.length === 0) return '';

  const parts = attachments.map(att => {
    if (att.type === 'text') {
      return `## Attached: ${att.name}\n\`\`\`\n${att.content}\n\`\`\``;
    } else if (att.type === 'image') {
      return `## Attached image: ${att.name} (${(att.size / 1024).toFixed(1)}KB)\n[base64 image data — ${att.size} bytes]`;
    } else {
      return `## Attached binary: ${att.name} (${(att.size / 1024).toFixed(1)}KB)\n[binary data — ${att.size} bytes]`;
    }
  });

  return '\n---\n## Attachments\n\n' + parts.join('\n\n');
}

export function popAttachmentsForMessage(): string {
  const formatted = formatAttachmentsForPrompt();
  clearAttachments();
  return formatted;
}

export function getImageAttachments(): Attachment[] {
  return attachments.filter(a => a.type === 'image');
}

export { Attachment };
