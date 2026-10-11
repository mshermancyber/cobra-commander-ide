import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { extname, dirname, resolve, relative, isAbsolute, basename } from 'node:path';
import { globSync } from 'glob';
import type { ToolDefinition } from '../core/types.js';
import { fuzzyReplace } from '../core/fuzzy-replacer.js';
import { executeLspTool } from './lsp-tool.js';
import { withFileLock } from '../core/file-lock.js';
import { isBinaryFile } from '../core/binary-detect.js';
import { detectFormatter } from '../core/formatter-detect.js';
import { hasBom, addBom, stripBom } from '../core/bom.js';
import { checkPathPermission, type PathPolicy } from '../core/path-permissions.js';
import { recordOperation } from '../core/operation-revert.js';
import { batchWriteFiles } from '../core/batch-write.js';

// ---------------------------------------------------------------------------
// Line ending helpers
// ---------------------------------------------------------------------------

function detectLineEnding(content: string): '\n' | '\r\n' {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfOnly = (content.match(/(?<!\r)\n/g) || []).length;
  return crlfCount > lfOnly ? '\r\n' : '\n';
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function convertToLineEnding(content: string, ending: '\n' | '\r\n'): string {
  const normalized = normalizeLineEndings(content);
  if (ending === '\r\n') {
    return normalized.replace(/\n/g, '\r\n');
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// "Did you mean?" suggestions on ENOENT
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function suggestSimilarFiles(absPath: string): string {
  const dir = dirname(absPath);
  const target = basename(absPath).toLowerCase();
  if (!existsSync(dir)) return '';
  try {
    const entries = readdirSync(dir);
    const suggestions = entries
      .map(name => ({ name, dist: levenshtein(name.toLowerCase(), target) }))
      .filter(s => s.dist <= 2 || s.name.toLowerCase().startsWith(target.slice(0, 3)))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3);
    if (suggestions.length === 0) return '';
    return '\nDid you mean: ' + suggestions.map(s => s.name).join(', ') + '?';
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Auto-format after edits
// ---------------------------------------------------------------------------

function autoFormat(absPath: string, workDir: string): void {
  const formatter = detectFormatter(workDir);
  if (!formatter) return;
  try {
    execSync(`${formatter.command} ${formatter.args.join(' ')} "${absPath}"`, {
      cwd: workDir, stdio: 'pipe', timeout: 10000,
    });
  } catch { /* formatting failure is non-fatal */ }
}

// ---------------------------------------------------------------------------
// BOM preservation
// ---------------------------------------------------------------------------

function writeBomAware(absPath: string, originalContent: string, newContent: string): void {
  const final = hasBom(originalContent) ? addBom(stripBom(newContent)) : newContent;
  writeFileSync(absPath, final, 'utf-8');
}

function resolveMultiDir(path: string, workDir: string, additionalDirs?: string[]): string {
  // Resolve the path fully to handle .. traversal
  const resolved = isAbsolute(path) ? resolve(path) : resolve(workDir, path);

  // Check if resolved path is within workDir
  const relToWork = relative(workDir, resolved);
  if (!relToWork.startsWith('..') && !isAbsolute(relToWork)) {
    return resolved;
  }

  // Check if resolved path is within any additional dir
  if (additionalDirs) {
    for (const dir of additionalDirs) {
      const resolvedDir = resolve(dir);
      const relToDir = relative(resolvedDir, resolved);
      if (!relToDir.startsWith('..') && !isAbsolute(relToDir)) {
        return resolved;
      }
    }
  }

  // Path escapes all allowed directories — block it
  throw new Error(`Path "${path}" is outside the allowed directories`);
}

/**
 * Tool definitions for file system operations exposed to workers and the orchestrator.
 * Includes: read_file, write_file, edit_file, list_files, patch_file, diff_changes.
 */
export const fileTools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file from the project. Returns the file contents.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        offset: { type: 'number', description: 'Start line (0-based). Omit to read from start.' },
        limit: { type: 'number', description: 'Max lines to read. Omit to read entire file.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace a specific string in a file. The old_string must appear exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        old_string: { type: 'string', description: 'Exact string to find and replace' },
        new_string: { type: 'string', description: 'Replacement string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_files',
    description: 'List files matching a glob pattern in the project.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g., "src/**/*.ts")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'patch_file',
    description: 'Apply a sequence of string replacements to a file. All patches are validated before writing.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        patches: {
          type: 'array',
          description: 'Array of replacement operations',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact string to find' },
              new_string: { type: 'string', description: 'Replacement string' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'patches'],
    },
  },
  {
    name: 'write_files',
    description: 'Write multiple files in a single call. Each file gets path-checked, BOM-aware write, and auto-formatting.',
    input_schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to project root' },
              content: { type: 'string', description: 'Full file content to write' },
            },
            required: ['path', 'content'],
          },
          description: 'Array of files to write',
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'diff_changes',
    description: 'Show all uncommitted file changes in the project. Use this to review your work before reporting done. Returns a unified diff of all modifications, plus a list of new/deleted files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional: limit diff to a specific file or directory. Omit for all changes.' },
      },
    },
  },
];

/**
 * Execute a file system tool by name. Handles path resolution within allowed
 * directories, file I/O, glob listing, patching, and git diff generation.
 *
 * @param name - Tool name to execute (e.g., 'read_file', 'write_file')
 * @param input - Tool input parameters
 * @param workDir - Primary working directory for path resolution
 * @param additionalDirs - Optional additional directories allowed for path resolution
 * @returns Object with result string and error flag
 */
export interface FileToolContext {
  workerId?: string;
  operationIndex?: number;
  pathPolicy?: PathPolicy;
}

export async function executeFileTool(
  name: string, input: Record<string, unknown>, workDir: string, additionalDirs?: string[], ctx?: FileToolContext,
): Promise<{ result: string; is_error: boolean }> {
  try {
    switch (name) {
      case 'read_file': {
        const absPath = resolveMultiDir(input.path as string, workDir, additionalDirs);
        // Enforce the deny policy on reads too — otherwise a denied file
        // (e.g. **/.env) is fully readable despite the policy.
        if (ctx?.pathPolicy) {
          const perm = checkPathPermission(absPath, ctx.pathPolicy);
          if (!perm.permitted) return { result: `Blocked: ${perm.reason}`, is_error: true };
        }
        if (!existsSync(absPath)) {
          return { result: `File not found: ${input.path}${suggestSimilarFiles(absPath)}`, is_error: true };
        }
        const rawBuf = readFileSync(absPath);
        if (isBinaryFile(absPath, rawBuf)) {
          const size = statSync(absPath).size;
          return { result: `Binary file: ${input.path} (${size} bytes) — cannot read as text`, is_error: true };
        }
        const lines = rawBuf.toString('utf-8').split('\n');
        const offset = (input.offset as number) || 0;
        const limit = (input.limit as number) || lines.length;
        const slice = lines.slice(offset, offset + limit);
        const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
        return { result: numbered, is_error: false };
      }

      case 'write_file': {
        const absPath = resolveMultiDir(input.path as string, workDir, additionalDirs);
        if (ctx?.pathPolicy) {
          const perm = checkPathPermission(absPath, ctx.pathPolicy);
          if (!perm.permitted) return { result: `Blocked: ${perm.reason}`, is_error: true };
        }
        return await withFileLock(absPath, async () => {
          mkdirSync(dirname(absPath), { recursive: true });
          const originalContent = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
          const newContent = input.content as string;
          writeBomAware(absPath, originalContent, newContent);
          autoFormat(absPath, workDir);
          if (ctx?.workerId) {
            recordOperation(ctx.workerId, ctx.operationIndex ?? 0, [{ path: absPath, before: originalContent, after: newContent }]);
          }
          let writeResult = `Written: ${input.path}`;
          writeResult = await appendLspDiagnostics(writeResult, absPath, workDir);
          return { result: writeResult, is_error: false };
        });
      }

      case 'edit_file': {
        const absPath = resolveMultiDir(input.path as string, workDir, additionalDirs);
        if (!existsSync(absPath)) {
          return { result: `File not found: ${input.path}${suggestSimilarFiles(absPath)}`, is_error: true };
        }
        if (ctx?.pathPolicy) {
          const perm = checkPathPermission(absPath, ctx.pathPolicy);
          if (!perm.permitted) return { result: `Blocked: ${perm.reason}`, is_error: true };
        }
        return await withFileLock(absPath, async () => {
          const rawContent = readFileSync(absPath, 'utf-8');
          const lineEnding = detectLineEnding(rawContent);
          const content = normalizeLineEndings(rawContent);
          const oldStr = normalizeLineEndings(input.old_string as string);
          const newStr = input.new_string as string;
          const occurrences = content.split(oldStr).length - 1;
          if (occurrences === 0) {
            const fuzzy = fuzzyReplace(content, oldStr, newStr);
            if (!fuzzy.matched) {
              return { result: `String not found in ${input.path}`, is_error: true };
            }
            const finalContent = convertToLineEnding(fuzzy.result, lineEnding);
            writeBomAware(absPath, rawContent, finalContent);
            autoFormat(absPath, workDir);
            if (ctx?.workerId) {
              recordOperation(ctx.workerId, ctx.operationIndex ?? 0, [{ path: absPath, before: rawContent, after: finalContent }]);
            }
            let editResult = `Edited: ${input.path} (matched via ${fuzzy.strategy})`;
            editResult = await appendLspDiagnostics(editResult, absPath, workDir);
            return { result: editResult, is_error: false };
          }
          if (occurrences > 1) {
            return { result: `String appears ${occurrences} times in ${input.path} — must be unique`, is_error: true };
          }
          const replaced = content.replace(oldStr, newStr);
          const finalContent = convertToLineEnding(replaced, lineEnding);
          writeBomAware(absPath, rawContent, finalContent);
          autoFormat(absPath, workDir);
          if (ctx?.workerId) {
            recordOperation(ctx.workerId, ctx.operationIndex ?? 0, [{ path: absPath, before: rawContent, after: finalContent }]);
          }
          let editResult = `Edited: ${input.path}`;
          editResult = await appendLspDiagnostics(editResult, absPath, workDir);
          return { result: editResult, is_error: false };
        });
      }

      case 'list_files': {
        const matches = globSync(input.pattern as string, {
          cwd: workDir,
          nodir: true,
          ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
        });
        if (matches.length === 0) return { result: 'No files matched', is_error: false };
        return { result: matches.sort().join('\n'), is_error: false };
      }

      case 'patch_file': {
        const absPath = resolveMultiDir(input.path as string, workDir, additionalDirs);
        if (!existsSync(absPath)) {
          return { result: `File not found: ${input.path}`, is_error: true };
        }

        const patches = input.patches as Array<{ old_string: string; new_string: string }>;
        if (!Array.isArray(patches) || patches.length === 0) {
          return { result: 'Error: patches must be a non-empty array', is_error: true };
        }

        // First pass: validate all patches against the original content
        let content = readFileSync(absPath, 'utf-8');
        const validatedPatches: Array<{ old_string: string; new_string: string }> = [];

        for (let i = 0; i < patches.length; i++) {
          const patch = patches[i];
          const oldStr = patch.old_string;
          const newStr = patch.new_string;

          if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
            return {
              result: `Error: patch ${i + 1}: old_string and new_string must be strings`,
              is_error: true,
            };
          }

          const occurrences = content.split(oldStr).length - 1;
          if (occurrences === 0) {
            return {
              result: `Error: patch ${i + 1}: string not found in ${input.path}`,
              is_error: true,
            };
          }
          if (occurrences > 1) {
            return {
              result: `Error: patch ${i + 1}: string appears ${occurrences} times in ${input.path} — must be unique`,
              is_error: true,
            };
          }

          validatedPatches.push({ old_string: oldStr, new_string: newStr });
          // Apply to content for subsequent patch validation
          content = content.replace(oldStr, newStr);
        }

        // Second pass: write the final result (re-read to ensure clean state)
        content = readFileSync(absPath, 'utf-8');
        for (const patch of validatedPatches) {
          content = content.replace(patch.old_string, patch.new_string);
        }
        writeFileSync(absPath, content, 'utf-8');

        return {
          result: `Patched: ${input.path} (${validatedPatches.length} change${validatedPatches.length === 1 ? '' : 's'} applied)`,
          is_error: false,
        };
      }

      case 'write_files': {
        const files = input.files as Array<{ path: string; content: string }>;
        if (!files || files.length === 0) {
          return { result: 'No files provided', is_error: true };
        }
        // Validate all paths and resolve against allowed directories
        const ops = files.map(f => ({
          path: resolveMultiDir(f.path, workDir, additionalDirs),
          content: f.content,
        }));
        const batchResult = await batchWriteFiles(ops, workDir, ctx?.pathPolicy, ctx?.workerId);
        const lines: string[] = [];
        for (const p of batchResult.written) lines.push(`Written: ${p}`);
        for (const d of batchResult.denied) lines.push(`Denied: ${d.path} — ${d.reason}`);
        for (const f of batchResult.failed) lines.push(`Failed: ${f.path} — ${f.error}`);
        return { result: lines.join('\n') || 'No files processed', is_error: batchResult.failed.length > 0 };
      }

      case 'diff_changes': {
        const targetPath = input.path as string | undefined;
        try {
          // Ensure we're in a git repo
          execSync('git rev-parse --git-dir', { cwd: workDir, stdio: 'pipe' });

          const pathArg = targetPath ? resolve(workDir, targetPath) : '.';

          // Use execFileSync with array args (no shell) — pathArg derives from
          // LLM/worker-controlled input.path and must never be shell-interpolated.
          const tracked = execFileSync('git', ['diff', '--', pathArg], {
            cwd: workDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 5 * 1024 * 1024,
          }).trim();

          // Get list of untracked new files
          const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
            cwd: workDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();

          // Get staged changes
          const staged = execFileSync('git', ['diff', '--cached', '--', pathArg], {
            cwd: workDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 5 * 1024 * 1024,
          }).trim();

          const parts: string[] = [];
          if (staged) parts.push('## Staged Changes\n' + staged);
          if (tracked) parts.push('## Unstaged Changes\n' + tracked);
          if (untracked) parts.push('## New Files\n' + untracked);

          const result = parts.join('\n\n');
          if (!result) return { result: 'No changes detected', is_error: false };

          // Truncate if huge
          if (result.length > 30000) {
            return { result: result.slice(0, 15000) + '\n\n... [truncated] ...\n\n' + result.slice(-15000), is_error: false };
          }
          return { result, is_error: false };
        } catch {
          // Not a git repo — fall back to just listing recent file mtimes
          return { result: 'Not a git repository — cannot compute diff', is_error: true };
        }
      }

      default:
        return { result: `Unknown tool: ${name}`, is_error: true };
    }
  } catch (err) {
    return { result: `Error: ${(err as Error).message}`, is_error: true };
  }
}

/**
 * Append LSP diagnostics to the result message for TypeScript files.
 * Silently skips if the file is not .ts/.tsx or if the LSP call fails.
 */
async function appendLspDiagnostics(result: string, absPath: string, workDir: string): Promise<string> {
  const ext = extname(absPath).toLowerCase();
  if (ext !== '.ts' && ext !== '.tsx') return result;
  try {
    const diag = await executeLspTool({ operation: 'diagnostics', filePath: absPath }, workDir);
    if (diag.result && !diag.is_error && diag.result !== 'No diagnostics.') {
      return `${result}\n\nLSP diagnostics:\n${diag.result}`;
    }
  } catch { /* LSP unavailable — silently skip */ }
  return result;
}
