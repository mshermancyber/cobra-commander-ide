import { applyUnifiedDiff } from '../core/apply-patch.js';
import { checkPathPermission } from '../core/path-permissions.js';
import { recordOperation } from '../core/operation-revert.js';
import { readFileSync, existsSync } from 'node:fs';
import type { ToolDefinition } from '../core/types.js';

export const unifiedDiffTool: ToolDefinition = {
  name: 'apply_unified_diff',
  description: 'Apply a unified diff (patch) to a file. Supports standard @@ -line,count +line,count @@ format. Use for multi-region edits in a single call.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to patch.',
      },
      patch: {
        type: 'string',
        description: 'Unified diff text with @@ hunk headers.',
      },
    },
    required: ['file_path', 'patch'],
  },
};

export function executeUnifiedDiffTool(
  input: { file_path: string; patch: string },
  workDir: string,
  ctx?: { workerId?: string; operationIndex?: number; pathPolicy?: { allowed?: string[]; denied?: string[] } },
): { result: string; is_error: boolean } {
  const filePath = input.file_path.startsWith('/')
    ? input.file_path
    : `${workDir}/${input.file_path}`;

  if (ctx?.pathPolicy) {
    const perm = checkPathPermission(filePath, ctx.pathPolicy);
    if (!perm.permitted) {
      return { result: `Permission denied: ${perm.reason}`, is_error: true };
    }
  }

  const before = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';

  const result = applyUnifiedDiff(filePath, input.patch, workDir);

  if (!result.success) {
    return { result: `Patch failed: ${result.error}`, is_error: true };
  }

  if (ctx?.workerId && result.newContent !== undefined) {
    try {
      recordOperation(ctx.workerId, ctx.operationIndex ?? 0, [{
        path: filePath,
        before,
        after: result.newContent,
      }]);
    } catch { /* non-fatal */ }
  }

  return { result: `Patch applied successfully to ${input.file_path}`, is_error: false };
}
