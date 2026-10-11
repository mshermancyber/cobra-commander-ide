import { execSync } from 'node:child_process';
import { getFileSymbols } from './repo-map.js';
import type { FileSymbol } from './repo-map.js';

export interface DiffHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  content: string;
}

export interface DiffChunk {
  file: string;
  hunks: DiffHunk[];
  isNew: boolean;
  isDeleted: boolean;
}

export interface AffectedSymbol {
  name: string;
  file: string;
  line: number;
  kind: string;
}

/**
 * Parse unified diff output into structured chunks.
 * Handles standard git diff format.
 */
export function parseDiff(diffOutput: string): DiffChunk[] {
  if (!diffOutput) return [];

  const chunks: DiffChunk[] = [];
  const lines = diffOutput.split('\n');
  let currentChunk: DiffChunk | null = null;
  let currentHunk: DiffHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match diff --git a/path b/path
    const fileMatch = line.match(/^diff --git a\/(.+?) b\//);
    if (fileMatch) {
      if (currentChunk) {
        if (currentHunk) {
          currentChunk.hunks.push(currentHunk);
          currentHunk = null;
        }
        chunks.push(currentChunk);
      }
      currentChunk = {
        file: fileMatch[1],
        hunks: [],
        isNew: false,
        isDeleted: false,
      };
      continue;
    }

    // Match new file marker
    if (line.startsWith('new file mode')) {
      if (currentChunk) {
        currentChunk.isNew = true;
      }
      continue;
    }

    // Match deleted file marker
    if (line.startsWith('deleted file mode')) {
      if (currentChunk) {
        currentChunk.isDeleted = true;
      }
      continue;
    }

    // Match --- a/path (old file)
    const oldFileMatch = line.match(/^--- a\/(.+)/);
    if (oldFileMatch && !currentChunk) {
      // Some diff formats don't have "diff --git" header
      currentChunk = {
        file: oldFileMatch[1],
        hunks: [],
        isNew: false,
        isDeleted: false,
      };
      continue;
    }

    // Match +++ b/path (new file) — only use if we don't have a chunk yet
    const newFileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (newFileMatch && !currentChunk) {
      currentChunk = {
        file: newFileMatch[1],
        hunks: [],
        isNew: false,
        isDeleted: false,
      };
      continue;
    }

    // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentChunk && currentHunk) {
        currentChunk.hunks.push(currentHunk);
      }
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;
      currentHunk = {
        oldStart,
        oldEnd: oldStart + oldCount - 1,
        newStart,
        newEnd: newStart + newCount - 1,
        content: line + '\n',
      };
      continue;
    }

    // Accumulate hunk content
    if (currentHunk) {
      currentHunk.content += line + '\n';
    }
  }

  // Flush last hunk and chunk
  if (currentChunk) {
    if (currentHunk) {
      currentChunk.hunks.push(currentHunk);
    }
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Get the list of symbols affected by changes since a given git ref.
 * Cross-references diff hunks with file symbols from repo-map.
 */
export async function getAffectedSymbols(workDir: string, ref?: string): Promise<AffectedSymbol[]> {
  let diffOutput: string;
  try {
    if (ref) {
      diffOutput = execSync(`git diff ${ref} -- .`, {
        cwd: workDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        maxBuffer: 5 * 1024 * 1024,
      }).toString();
    } else {
      diffOutput = execSync('git diff -- . && git diff --cached -- .', {
        cwd: workDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        maxBuffer: 5 * 1024 * 1024,
        shell: '/bin/bash',
      }).toString();
      if (!diffOutput.trim()) {
        diffOutput = execSync('git diff HEAD -- . 2>/dev/null || echo ""', {
          cwd: workDir,
          encoding: 'utf-8',
          stdio: 'pipe',
          shell: '/bin/bash',
        }).toString();
      }
    }
  } catch {
    return [];
  }

  if (!diffOutput.trim()) return [];

  const chunks = parseDiff(diffOutput);
  const affected: AffectedSymbol[] = [];

  for (const chunk of chunks) {
    const absPath = require('node:path').resolve(workDir, chunk.file);
    const symbols = await getFileSymbols(absPath);

    for (const hunk of chunk.hunks) {
      // Find symbols that overlap with this hunk's line range
      // For new files, use newStart..newEnd; for modified files, check both old and new ranges
      const startLine = chunk.isNew ? hunk.newStart : hunk.oldStart;
      const endLine = chunk.isNew ? hunk.newEnd : hunk.oldEnd;

      for (const sym of symbols) {
        // Check if the symbol's line falls within the hunk range
        // Also check if the hunk starts within a function body (line after the symbol)
        if ((sym.line ?? 0) >= startLine && (sym.line ?? 0) <= endLine + 5) {
          // Avoid duplicates
          if (!affected.some(a => a.file === chunk.file && a.name === sym.name)) {
            affected.push({
              name: sym.name,
              file: chunk.file,
              line: sym.line ?? 0,
              kind: sym.kind,
            });
          }
        }
      }
    }
  }

  return affected;
}

/**
 * Create a focused context string describing what symbols changed.
 */
export async function formatDiffContext(workDir: string, ref?: string): Promise<string> {
  const affected = await getAffectedSymbols(workDir, ref);

  if (affected.length === 0) {
    // Fall back to listing changed files
    try {
      let diffOutput: string;
      if (ref) {
        diffOutput = execSync(`git diff --name-only ${ref} -- .`, {
          cwd: workDir,
          encoding: 'utf-8',
          stdio: 'pipe',
        }).toString().trim();
      } else {
        diffOutput = execSync('git diff --name-only -- . && git diff --cached --name-only -- .', {
          cwd: workDir,
          encoding: 'utf-8',
          stdio: 'pipe',
          shell: '/bin/bash',
        }).toString().trim();
      }
      if (diffOutput) {
        const files = diffOutput.split('\n').filter(Boolean);
        return `Changed files:\n${files.map(f => `  - ${f}`).join('\n')}`;
      }
    } catch {
      // ignore
    }
    return '';
  }

  // Group by file
  const byFile = new Map<string, AffectedSymbol[]>();
  for (const sym of affected) {
    if (!byFile.has(sym.file)) {
      byFile.set(sym.file, []);
    }
    byFile.get(sym.file)!.push(sym);
  }

  const lines: string[] = ['Changed symbols since last checkpoint:'];
  for (const [file, symbols] of byFile) {
    for (const sym of symbols) {
      lines.push(`  - ${sym.kind} ${sym.name} (${file}:${sym.line}) — modified`);
    }
  }

  return lines.join('\n');
}
