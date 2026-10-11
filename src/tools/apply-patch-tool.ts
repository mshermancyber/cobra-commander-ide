import { applyPatch } from '../core/patch-parser.js';
import type { ToolDefinition } from '../core/types.js';

export const applyPatchTool: ToolDefinition = {
  name: 'apply_patch',
  description: 'Apply a patch to one or more files. Supports adding, deleting, updating, and moving files using the *** Begin Patch / *** End Patch format.',
  input_schema: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'The full patch text wrapped in *** Begin Patch / *** End Patch markers.',
      },
      workDir: {
        type: 'string',
        description: 'Working directory to resolve relative paths against. Defaults to the current project directory.',
      },
    },
    required: ['patch'],
  },
};

export function executeApplyPatchTool(input: { patch: string; workDir?: string }): string {
  const workDir = input.workDir || process.cwd();

  try {
    const result = applyPatch(input.patch, workDir);

    const lines: string[] = [];
    if (result.added.length) lines.push(`Added: ${result.added.join(', ')}`);
    if (result.modified.length) lines.push(`Modified: ${result.modified.join(', ')}`);
    if (result.deleted.length) lines.push(`Deleted: ${result.deleted.join(', ')}`);
    if (result.errors.length) lines.push(`Errors: ${result.errors.join('; ')}`);

    if (lines.length === 0) return 'No changes applied.';

    const total = result.added.length + result.modified.length + result.deleted.length;
    lines.unshift(`Applied patch: ${total} file(s) changed.`);

    return lines.join('\n');
  } catch (err) {
    return `Patch failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
