// forked from core/tool-output-truncation.ts @ 2026-07-04 — DOWNSTREAM fork, do not backport to core

import { writeFileSync, mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TruncationResult {
  text: string;
  truncated: boolean;
  fullPath?: string;
}

const LINE_CLAMP = 400;

function clampLine(line: string): string {
  if (line.length <= LINE_CLAMP) return line;
  return line.slice(0, LINE_CLAMP) + '…[clamped]';
}

/**
 * Truncate tool output when it exceeds line or byte limits.
 * When truncated, the full output is written to a temp file and the returned
 * text contains a preview (first 50 lines + last 20 lines) with a path to the
 * full output so the caller can read_file or grep it.
 */
export function truncateDestroOutput(
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

  // Write full output to a temp file
  const tempDir = mkdtempSync(join(tmpdir(), 'tool-output-'));
  const timestamp = Date.now();
  const fullPath = join(tempDir, `output-${timestamp}.txt`);
  writeFileSync(fullPath, output, 'utf-8');

  // Build preview: first 50 lines + last 20 lines (each line byte-clamped)
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
export function truncateDestroShellOutput(
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

  const tempDir = mkdtempSync(join(tmpdir(), 'tool-output-'));
  const timestamp = Date.now();
  const fullPath = join(tempDir, `output-${timestamp}.txt`);
  writeFileSync(fullPath, output, 'utf-8');

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

  const reason = exceedsLines && exceedsBytes
    ? `${lines.length} lines, ${byteLength} bytes`
    : exceedsLines
      ? `${lines.length} lines`
      : `${byteLength} bytes`;

  const text = `${preview}\n\n[truncated — ${reason} exceeded. Full output at ${fullPath}, use read_file or grep to search it]`;

  return { text, truncated: true, fullPath };
}

/**
 * Reap stale temp directories created by truncation.
 * Scans the system tmpdir for 'tool-output-*' dirs and removes those
 * with mtime older than maxAgeMs.
 */
export function reapDestroTempDirs(maxAgeMs: number = 3_600_000): number {
  const now = Date.now();
  let removed = 0;

  try {
    const entries = readdirSync(tmpdir(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('tool-output-')) continue;
      const fullPath = join(tmpdir(), entry.name);
      try {
        const st = statSync(fullPath);
        if (now - st.mtimeMs >= maxAgeMs) {
          rmSync(fullPath, { recursive: true, force: true });
          removed++;
        }
      } catch { /* skip unreadable entries */ }
    }
  } catch { /* tmpdir may not exist or be inaccessible */ }

  return removed;
}
