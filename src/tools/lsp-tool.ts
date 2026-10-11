import { getOrCreateClient } from '../core/lsp-client.js';
import { getLanguageId } from '../core/language-map.js';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition } from '../core/types.js';

export const lspTool: ToolDefinition = {
  name: 'lsp',
  description: 'Use Language Server Protocol for code intelligence. Operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol. Requires a language server to be installed for the target language.',
  input_schema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'diagnostics'],
        description: 'The LSP operation to perform.',
      },
      filePath: {
        type: 'string',
        description: 'Relative or absolute path to the file.',
      },
      line: {
        type: 'number',
        description: 'Line number (1-based).',
      },
      character: {
        type: 'number',
        description: 'Character offset (1-based).',
      },
      query: {
        type: 'string',
        description: 'Search query for workspaceSymbol.',
      },
    },
    required: ['operation', 'filePath'],
  },
};

interface LSPInput {
  operation: string;
  filePath: string;
  line?: number;
  character?: number;
  query?: string;
}

export async function executeLspTool(input: LSPInput, workDir: string): Promise<{ result: string; is_error: boolean }> {
  const filePath = resolve(workDir, input.filePath);
  const languageId = getLanguageId(filePath);

  if (!languageId) {
    return { result: `Unknown language for file: ${input.filePath}`, is_error: true };
  }

  const client = await getOrCreateClient(workDir, languageId);
  if (!client) {
    return { result: `No language server available for ${languageId}. Install the appropriate language server.`, is_error: true };
  }

  try {
    switch (input.operation) {
      case 'goToDefinition': {
        if (!input.line || !input.character) {
          return { result: 'goToDefinition requires line and character.', is_error: true };
        }
        const locations = await client.definition(input.filePath, input.line, input.character);
        if (locations.length === 0) return { result: 'No definition found.', is_error: false };
        return {
          result: locations.map(loc => {
            const path = relative(workDir, fileURLToPath(loc.uri));
            return `${path}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
          }).join('\n'),
          is_error: false,
        };
      }

      case 'findReferences': {
        if (!input.line || !input.character) {
          return { result: 'findReferences requires line and character.', is_error: true };
        }
        const refs = await client.references(input.filePath, input.line, input.character);
        if (refs.length === 0) return { result: 'No references found.', is_error: false };
        return {
          result: `${refs.length} references:\n` + refs.map(loc => {
            const path = relative(workDir, fileURLToPath(loc.uri));
            return `  ${path}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
          }).join('\n'),
          is_error: false,
        };
      }

      case 'hover': {
        if (!input.line || !input.character) {
          return { result: 'hover requires line and character.', is_error: true };
        }
        const hover = await client.hover(input.filePath, input.line, input.character);
        return { result: hover || 'No hover information.', is_error: false };
      }

      case 'documentSymbol': {
        const symbols = await client.documentSymbols(input.filePath);
        return { result: symbols, is_error: false };
      }

      case 'workspaceSymbol': {
        const symbols = await client.workspaceSymbol(input.query || '');
        return { result: symbols, is_error: false };
      }

      case 'diagnostics': {
        // Open the file to trigger server analysis
        await client.openFile(input.filePath);
        // Brief wait for publishDiagnostics notifications to arrive
        await new Promise((resolve) => setTimeout(resolve, 350));
        const diags = client.getDiagnostics(input.filePath);
        return { result: diags || 'No diagnostics.', is_error: false };
      }

      default:
        return { result: `Unknown operation: ${input.operation}`, is_error: true };
    }
  } catch (err) {
    return { result: `LSP error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
  }
}
