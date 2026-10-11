import { extractASTContext, formatASTSummary, getRelevantSymbols } from '../core/ast-context.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolDefinition } from '../core/types.js';

export const astContextTool: ToolDefinition = {
  name: 'analyze_code',
  description:
    'Analyze a source code file and return its structure: functions, classes, imports, and exports. Workers use this to understand code before editing. Pass a file path relative to the project root.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the project root to analyze.',
      },
      query: {
        type: 'string',
        description: 'Optional: search for specific symbols (function/class/method/export names) within the file.',
      },
    },
    required: ['path'],
  },
};

export function executeAstContextTool(input: Record<string, unknown>): { result: string; is_error: boolean } {
  const filePath = input.path as string;

  if (!filePath || filePath.trim().length === 0) {
    return { result: 'Error: "path" parameter is required.', is_error: true };
  }

  const absolutePath = resolve(process.cwd(), filePath);

  if (!existsSync(absolutePath)) {
    return { result: `Error: file not found: ${filePath}`, is_error: true };
  }

  try {
    const content = readFileSync(absolutePath, 'utf-8');
    const context = extractASTContext(filePath, content);
    const summary = formatASTSummary(context);

    let output = `=== AST Analysis: ${filePath} ===\n\n`;
    output += `Summary: ${summary}\n`;

    // Functions
    if (context.functions.length > 0) {
      output += `\n--- Functions (${context.functions.length}) ---\n`;
      for (const f of context.functions) {
        output += `  ${f.name}()  lines ${f.startLine}-${f.endLine}  complexity: ${f.complexity}\n`;
      }
    }

    // Classes
    if (context.classes.length > 0) {
      output += `\n--- Classes (${context.classes.length}) ---\n`;
      for (const c of context.classes) {
        output += `  class ${c.name}  lines ${c.startLine}-${c.endLine}  methods: [${c.methods.join(', ')}]\n`;
      }
    }

    // Imports
    if (context.imports.length > 0) {
      output += `\n--- Imports (${context.imports.length}) ---\n`;
      for (const imp of context.imports) {
        const syms = imp.symbols.length > 0 ? `{ ${imp.symbols.join(', ')} }` : '(default)';
        output += `  from "${imp.from}"  →  ${syms}\n`;
      }
    }

    // Exports
    if (context.exports.length > 0) {
      output += `\n--- Exports (${context.exports.length}) ---\n`;
      for (const exp of context.exports) {
        output += `  ${exp.name}  (${exp.type})\n`;
      }
    }

    // Symbol search if query provided
    if (input.query && typeof input.query === 'string' && input.query.trim().length > 0) {
      const symbols = getRelevantSymbols(context, input.query);
      output += `\n--- Symbol Search: "${input.query}" ---\n`;
      if (symbols.length > 0) {
        for (const s of symbols) {
          output += `  ${s}\n`;
        }
      } else {
        output += `  (no matching symbols found)\n`;
      }
    }

    return { result: output, is_error: false };
  } catch (e: any) {
    return { result: `Error analyzing file: ${e.message}`, is_error: true };
  }
}
