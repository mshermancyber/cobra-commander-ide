import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { checkPathPermission, type PathPolicy, type PermissionResult } from './path-permissions.js';
import { recordOperation, type FilePatch } from './operation-revert.js';
import { writeBomAware, autoFormat } from './file-tools.js';
import { withFileLock } from './file-lock.js';
import { detectLineEnding, restoreLineEndings } from './line-endings.js';

/**
 * Default policy applied to every write when no explicit policy is provided.
 * Allows writes anywhere under the working directory and denies writes to
 * system-level paths.
 */
const DEFAULT_POLICY: PathPolicy = {
  denied: [
    '/etc/**',
    '/boot/**',
    '/sys/**',
    '/proc/**',
    '/dev/**',
    '**/.git/config',
    '**/.git/hooks/**',
  ],
};

/** A single file-write operation. */
export interface WriteOp {
  /** Path relative to workDir or absolute. */
  path: string;
  /** New file content. */
  content: string;
}

/** Result of a batch write operation. */
export interface BatchResult {
  /** Files that were successfully written. */
  written: string[];
  /** Files that were skipped due to permission denials. */
  denied: Array<{ path: string; reason: string }>;
  /** Files that encountered an error during write. */
  failed: Array<{ path: string; error: string }>;
}

/**
 * Write multiple files in a single call.
 *
 * Each path is checked against the given policy (or the default policy)
 * before writing. Files that pass the check are written with BOM awareness,
 * line-ending preservation, and file locking. After writing the project's
 * detected formatter is run on each file (best-effort) and the operation is
 * recorded for potential undo.
 *
 * @param ops      - Array of { path, content } write operations.
 * @param workDir  - Working directory used for path resolution and formatter detection.
 * @param policy   - Optional path policy override.
 * @param workerId - Worker identifier recorded in the revert log. Defaults to 'batch'.
 * @returns A BatchResult summarising written, denied, and failed paths.
 */
export async function batchWriteFiles(
  ops: WriteOp[],
  workDir: string,
  policy?: PathPolicy,
  workerId = 'batch',
): Promise<BatchResult> {
  const effectivePolicy = policy ?? DEFAULT_POLICY;
  const result: BatchResult = { written: [], denied: [], failed: [] };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const absPath = resolve(workDir, op.path);
    const relPath = op.path;

    // 1. Check path permissions
    const perm: PermissionResult = checkPathPermission(absPath, effectivePolicy);
    if (!perm.permitted) {
      result.denied.push({ path: relPath, reason: perm.reason ?? 'denied by policy' });
      continue;
    }

    // 2. Write under file lock — ensures atomicity per file
    try {
      await withFileLock(absPath, async () => {
        // 3. Ensure parent directory exists
        mkdirSync(dirname(absPath), { recursive: true });

        // 4. Read existing content for revert, BOM, and line-ending preservation
        let before = '';
        let lineEnding: '\r\n' | '\n' = '\n';
        try {
          before = readFileSync(absPath, 'utf-8');
          lineEnding = detectLineEnding(before);
        } catch {
          // File doesn't exist yet — use default line ending
        }

        // 5. Preserve line endings from the original file
        const finalContent = restoreLineEndings(op.content, lineEnding);

        // 6. Write the file (BOM-aware — reads existing file internally for BOM detection)
        writeBomAware(absPath, finalContent);

        // 7. Record the operation for potential revert
        const patch: FilePatch = { path: absPath, before, after: finalContent };
        recordOperation(workerId, i, [patch], 'batch-write');

        // 8. Auto-format (best-effort)
        autoFormat(absPath, workDir);
      });
      result.written.push(relPath);
    } catch (err) {
      result.failed.push({
        path: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
