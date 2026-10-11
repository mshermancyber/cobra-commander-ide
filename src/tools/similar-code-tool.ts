import { quickSimilaritySearch, createSimilarCodeFinder } from '../core/similar-code-finder.js';
import type { ToolDefinition } from '../core/types.js';

export const similarCodeTool: ToolDefinition = {
  name: 'find_similar_code',
  description:
    'Find code in the codebase similar to a provided snippet or function name. Workers call this to avoid duplicating existing code. Searches for structural, semantic, and token-level similarities.',
  input_schema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Code snippet or function name to search for similar patterns in the codebase.',
      },
      minSimilarity: {
        type: 'number',
        description: 'Minimum similarity threshold (0-100). Default 50.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results to return. Default 20.',
      },
      workDir: {
        type: 'string',
        description: 'Root directory to search. Defaults to current working directory.',
      },
    },
    required: ['code'],
  },
};

export function executeSimilarCodeTool(
  input: Record<string, unknown>,
  defaultWorkDir?: string,
): { result: string; is_error: boolean } {
  const code = input.code as string;
  const minSimilarity = (input.minSimilarity as number) ?? 50;
  const maxResults = (input.maxResults as number) ?? 20;
  const workDir = (input.workDir as string) || defaultWorkDir || process.cwd();

  if (!code || code.trim().length === 0) {
    return { result: 'Error: "code" parameter is required and must be non-empty.', is_error: true };
  }

  try {
    const results = quickSimilaritySearch(code.trim(), workDir, maxResults);

    if (results.length === 0) {
      return {
        result: 'No similar code patterns found in the codebase.\n',
        is_error: false,
      };
    }

    const lines: string[] = [];
    lines.push(`=== Similar Code Search Results ===`);
    lines.push(`Searched for: "${code.trim().slice(0, 100)}${code.trim().length > 100 ? '...' : ''}"`);
    lines.push(`Minimum similarity: ${minSimilarity}% | Max results: ${maxResults}`);
    lines.push(`Found: ${results.length} result(s)`);
    lines.push('');

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`--- Result ${i + 1} ---`);
      lines.push(`File: ${r.location.file}:${r.location.startLine}-${r.location.endLine}`);
      lines.push(`Context: ${r.location.context}`);
      lines.push(
        `Similarity: ${r.similarity.overall}% (structural: ${r.similarity.structural}%, semantic: ${r.similarity.semantic}%, token: ${r.similarity.token}%)`,
      );
      lines.push(`Relevance: ${r.relevance}`);
      if (r.suggestions.length > 0) {
        lines.push('Suggestions:');
        for (const s of r.suggestions) {
          lines.push(`  - ${s}`);
        }
      }
      lines.push('```');
      lines.push(r.codeBlock.slice(0, 400));
      if (r.codeBlock.length > 400) lines.push('  ...');
      lines.push('```');
      lines.push('');
    }

    return { result: lines.join('\n'), is_error: false };
  } catch (e: any) {
    return { result: `Error during similarity search: ${e.message}`, is_error: true };
  }
}
