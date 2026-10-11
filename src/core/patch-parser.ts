import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

export type Hunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; move_path?: string; chunks: UpdateFileChunk[] };

export interface UpdateFileChunk {
  old_lines: string[];
  new_lines: string[];
  change_context?: string;
  is_end_of_file?: boolean;
}

export interface PatchResult {
  hunks: Hunk[];
}

export interface ApplyResult {
  added: string[];
  modified: string[];
  deleted: string[];
  errors: string[];
}

function stripHeredoc(input: string): string {
  const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  if (heredocMatch) return heredocMatch[2];
  return input;
}

function parsePatchHeader(
  lines: string[],
  startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | null {
  const line = lines[startIdx];

  if (line.startsWith('*** Add File:')) {
    const filePath = line.slice('*** Add File:'.length).trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }

  if (line.startsWith('*** Delete File:')) {
    const filePath = line.slice('*** Delete File:'.length).trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }

  if (line.startsWith('*** Update File:')) {
    const filePath = line.slice('*** Update File:'.length).trim();
    let movePath: string | undefined;
    let nextIdx = startIdx + 1;

    if (nextIdx < lines.length && lines[nextIdx].startsWith('*** Move to:')) {
      movePath = lines[nextIdx].slice('*** Move to:'.length).trim();
      nextIdx++;
    }

    return filePath ? { filePath, movePath, nextIdx } : null;
  }

  return null;
}

function parseUpdateFileChunks(lines: string[], startIdx: number): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = [];
  let i = startIdx;

  while (i < lines.length && !lines[i].startsWith('***')) {
    if (lines[i].startsWith('@@')) {
      const contextLine = lines[i].substring(2).trim();
      i++;

      const oldLines: string[] = [];
      const newLines: string[] = [];
      let isEndOfFile = false;

      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('***')) {
        const changeLine = lines[i];

        if (changeLine === '*** End of File') {
          isEndOfFile = true;
          i++;
          break;
        }

        if (changeLine.startsWith(' ')) {
          const content = changeLine.substring(1);
          oldLines.push(content);
          newLines.push(content);
        } else if (changeLine.startsWith('-')) {
          oldLines.push(changeLine.substring(1));
        } else if (changeLine.startsWith('+')) {
          newLines.push(changeLine.substring(1));
        }

        i++;
      }

      chunks.push({
        old_lines: oldLines,
        new_lines: newLines,
        change_context: contextLine || undefined,
        is_end_of_file: isEndOfFile || undefined,
      });
    } else {
      i++;
    }
  }

  return { chunks, nextIdx: i };
}

function parseAddFileContent(lines: string[], startIdx: number): { content: string; nextIdx: number } {
  let content = '';
  let i = startIdx;

  while (i < lines.length && !lines[i].startsWith('***')) {
    if (lines[i].startsWith('+')) {
      content += lines[i].substring(1) + '\n';
    }
    i++;
  }

  if (content.endsWith('\n')) {
    content = content.slice(0, -1);
  }

  return { content, nextIdx: i };
}

export function parsePatch(patchText: string): PatchResult {
  const cleaned = stripHeredoc(patchText.trim());
  const lines = cleaned.split('\n');
  const hunks: Hunk[] = [];
  let i = 0;

  const beginIdx = lines.findIndex((line) => line.trim() === '*** Begin Patch');
  const endIdx = lines.findIndex((line) => line.trim() === '*** End Patch');

  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    throw new Error('Invalid patch format: missing Begin/End markers');
  }

  i = beginIdx + 1;

  while (i < endIdx) {
    const header = parsePatchHeader(lines, i);
    if (!header) {
      i++;
      continue;
    }

    if (lines[i].startsWith('*** Add File:')) {
      const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
      hunks.push({ type: 'add', path: header.filePath, contents: content });
      i = nextIdx;
    } else if (lines[i].startsWith('*** Delete File:')) {
      hunks.push({ type: 'delete', path: header.filePath });
      i = header.nextIdx;
    } else if (lines[i].startsWith('*** Update File:')) {
      const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
      hunks.push({ type: 'update', path: header.filePath, move_path: header.movePath, chunks });
      i = nextIdx;
    } else {
      i++;
    }
  }

  return { hunks };
}

function normalizeUnicode(str: string): string {
  return str
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
}

type Comparator = (a: string, b: string) => boolean;

function tryMatch(lines: string[], pattern: string[], startIndex: number, compare: Comparator, eof: boolean): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex) {
      let matches = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!compare(lines[fromEnd + j], pattern[j])) { matches = false; break; }
      }
      if (matches) return fromEnd;
    }
  }

  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    let matches = true;
    for (let j = 0; j < pattern.length; j++) {
      if (!compare(lines[i + j], pattern[j])) { matches = false; break; }
    }
    if (matches) return i;
  }

  return -1;
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
  if (pattern.length === 0) return -1;

  const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof);
  if (exact !== -1) return exact;

  const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof);
  if (rstrip !== -1) return rstrip;

  const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof);
  if (trim !== -1) return trim;

  return tryMatch(
    lines, pattern, startIndex,
    (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
    eof,
  );
}

export function deriveNewContents(
  filePath: string,
  chunks: UpdateFileChunk[],
  originalText: string,
): string {
  let originalLines = originalText.split('\n');

  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === '') {
    originalLines.pop();
  }

  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.change_context) {
      const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex);
      if (contextIdx === -1) {
        throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`);
      }
      lineIndex = contextIdx + 1;
    }

    if (chunk.old_lines.length === 0) {
      const insertionIdx =
        originalLines.length > 0 && originalLines[originalLines.length - 1] === ''
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIdx, 0, chunk.new_lines]);
      continue;
    }

    let pattern = chunk.old_lines;
    let newSlice = chunk.new_lines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);

    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
    }

    if (found !== -1) {
      replacements.push([found, pattern.length, newSlice]);
      lineIndex = found + pattern.length;
    } else {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join('\n')}`);
    }
  }

  replacements.sort((a, b) => a[0] - b[0]);

  const result = [...originalLines];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i];
    result.splice(startIdx, oldLen, ...newSegment);
  }

  if (result.length === 0 || result[result.length - 1] !== '') {
    result.push('');
  }

  return result.join('\n');
}

export function applyPatch(patchText: string, workDir: string): ApplyResult {
  const { hunks } = parsePatch(patchText);
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const errors: string[] = [];

  for (const hunk of hunks) {
    const filePath = resolve(workDir, hunk.path);

    if (!filePath.startsWith(resolve(workDir))) {
      errors.push(`Path traversal blocked: ${hunk.path}`);
      continue;
    }

    try {
      switch (hunk.type) {
        case 'add': {
          mkdirSync(dirname(filePath), { recursive: true });
          const content = hunk.contents.length === 0 || hunk.contents.endsWith('\n')
            ? hunk.contents
            : `${hunk.contents}\n`;
          writeFileSync(filePath, content);
          added.push(hunk.path);
          break;
        }
        case 'delete': {
          if (existsSync(filePath)) {
            unlinkSync(filePath);
          }
          deleted.push(hunk.path);
          break;
        }
        case 'update': {
          const originalText = readFileSync(filePath, 'utf-8');
          const newContent = deriveNewContents(filePath, hunk.chunks, originalText);
          if (hunk.move_path) {
            const movePath = resolve(workDir, hunk.move_path);
            if (!movePath.startsWith(resolve(workDir))) {
              errors.push(`Path traversal blocked: ${hunk.move_path}`);
              continue;
            }
            mkdirSync(dirname(movePath), { recursive: true });
            writeFileSync(movePath, newContent);
            unlinkSync(filePath);
            modified.push(hunk.move_path);
          } else {
            writeFileSync(filePath, newContent);
            modified.push(hunk.path);
          }
          break;
        }
      }
    } catch (err) {
      errors.push(`${hunk.type} ${hunk.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { added, modified, deleted, errors };
}
