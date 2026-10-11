import {
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

export interface TruncationResult {
  text: string;
  truncated: boolean;
  fullPath?: string;
}

// --- Managed output directory (single dir, not per-call mkdtemp) ---

const MANAGED_DIR = join(tmpdir(), 'cc-tool-output');

function ensureManagedDir(): string {
  if (!existsSync(MANAGED_DIR)) {
    mkdirSync(MANAGED_DIR, { recursive: true });
  }
  return MANAGED_DIR;
}

/**
 * Delete files in the managed dir with mtime older than 24 hours.
 * Wrapped in try/catch — must never throw.
 */
function reapTempFiles(): void {
  try {
    if (!existsSync(MANAGED_DIR)) return;
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24h
    for (const entry of readdirSync(MANAGED_DIR)) {
      try {
        const fullPath = join(MANAGED_DIR, entry);
        const st = statSync(fullPath);
        if (st.isFile() && now - st.mtimeMs > maxAge) {
          unlinkSync(fullPath);
        }
      } catch {
        // skip individual file errors
      }
    }
  } catch {
    // reaper must never throw
  }
}

// Reap on module load
reapTempFiles();

// Reap hourly (unref so it doesn't keep the process alive)
setInterval(reapTempFiles, 60 * 60 * 1000).unref();

// --- Byte-clamp helpers ---

const LINE_CLAMP_BYTES = 4096;
const PREVIEW_CLAMP_BYTES = 32768;
const CLAMP_SUFFIX = '…[clamped]';
const CLAMP_SUFFIX_BYTES = Buffer.byteLength(CLAMP_SUFFIX, 'utf-8');

/**
 * Clamp a string to at most maxBytes, walking back from the cut point
 * to avoid splitting a multi-byte UTF-8 character.
 */
function clampBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, 'utf-8') <= maxBytes) return str;
  const buf = Buffer.from(str, 'utf-8');
  let end = maxBytes;
  // Continuation bytes are 10xxxxxx (0x80–0xBF). Walk back to a start byte.
  while (end > 0 && (buf[end - 1] & 0xC0) === 0x80) {
    end--;
  }
  return buf.slice(0, end).toString('utf-8');
}

/** Clamp a single line to LINE_CLAMP_BYTES, appending `…[clamped]` if cut. */
function clampLine(line: string): string {
  if (Buffer.byteLength(line, 'utf-8') <= LINE_CLAMP_BYTES) return line;
  return clampBytes(line, LINE_CLAMP_BYTES - CLAMP_SUFFIX_BYTES) + CLAMP_SUFFIX;
}

/** Clamp the total preview to PREVIEW_CLAMP_BYTES, appending `…[clamped]` if cut. */
function clampPreview(preview: string): string {
  if (Buffer.byteLength(preview, 'utf-8') <= PREVIEW_CLAMP_BYTES) return preview;
  return clampBytes(preview, PREVIEW_CLAMP_BYTES - CLAMP_SUFFIX_BYTES) + CLAMP_SUFFIX;
}

// --- Shared write-full-output helper ---

function writeFullOutput(output: string): string {
  const dir = ensureManagedDir();
  const timestamp = Date.now();
  const suffix = randomBytes(4).toString('hex');
  const fullPath = join(dir, `output-${timestamp}-${suffix}.txt`);
  writeFileSync(fullPath, output, 'utf-8');
  return fullPath;
}

// --- Public functions (signatures unchanged) ---

/**
 * Truncate tool output when it exceeds line or byte limits.
 * When truncated, the full output is written to a temp file and the returned
 * text contains a preview (first 50 lines + last 20 lines) with a path to the
 * full output so the caller can read_file or grep it.
 */
export function truncateToolOutput(
  output: string,
  maxLines: number = 2000,
  maxBytes: number = 50000,
): TruncationResult {
  const lines = output.split('\n');
  const byteLength = Buffer.byteLength(output, 'utf-8');

  const exceedsLines = lines.length > maxLines;
  const exceedsBytes = byteLength > maxBytes;

  if (!exceedsLines && !exceedsBytes) {
    return { text: output, truncated: false };
  }

  // Write full output to managed dir as a unique file
  const fullPath = writeFullOutput(output);

  // Build byte-clamped preview: first 50 lines + last 20 lines
  const previewLines = 50;
  const tailLines = 20;
  let preview = '';

  if (lines.length <= previewLines + tailLines) {
    preview = lines.map(clampLine).join('\n');
  } else {
    const head = lines.slice(0, previewLines).map(clampLine).join('\n');
    const tail = lines.slice(-tailLines).map(clampLine).join('\n');
    preview = `${head}\n\n... [${lines.length - previewLines - tailLines} lines omitted] ...\n\n${tail}`;
  }

  // Byte-clamp the total preview
  preview = clampPreview(preview);

  const reason = exceedsLines && exceedsBytes
    ? `${lines.length} lines, ${byteLength} bytes`
    : exceedsLines
      ? `${lines.length} lines`
      : `${byteLength} bytes`;

  const text = `${preview}\n\n[truncated — ${reason} exceeded. Full output at ${fullPath}, use read_file or grep to search it]`;

  return { text, truncated: true, fullPath };
}

/**
 * Truncate shell output, prioritizing the TAIL (last 50 lines + first 20 lines).
 * Error messages and test results typically appear at the end of output.
 */
export function truncateShellOutput(
  output: string,
  maxLines: number = 2000,
  maxBytes: number = 50000,
): TruncationResult {
  const lines = output.split('\n');
  const byteLength = Buffer.byteLength(output, 'utf-8');

  const exceedsLines = lines.length > maxLines;
  const exceedsBytes = byteLength > maxBytes;

  if (!exceedsLines && !exceedsBytes) {
    return { text: output, truncated: false };
  }

  // Write full output to managed dir as a unique file
  const fullPath = writeFullOutput(output);

  const headLines = 20;
  const tailLines = 50;
  let preview = '';

  if (lines.length <= headLines + tailLines) {
    preview = lines.map(clampLine).join('\n');
  } else {
    const head = lines.slice(0, headLines).map(clampLine).join('\n');
    const tail = lines.slice(-tailLines).map(clampLine).join('\n');
    preview = `${head}\n\n... [${lines.length - headLines - tailLines} lines omitted] ...\n\n${tail}`;
  }

  // Byte-clamp the total preview
  preview = clampPreview(preview);

  const reason = exceedsLines && exceedsBytes
    ? `${lines.length} lines, ${byteLength} bytes`
    : exceedsLines
      ? `${lines.length} lines`
      : `${byteLength} bytes`;

  const text = `${preview}\n\n[truncated — ${reason} exceeded. Full output at ${fullPath}, use read_file or grep to search it]`;

  return { text, truncated: true, fullPath };
}
