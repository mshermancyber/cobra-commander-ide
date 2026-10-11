import { execFileSync } from 'node:child_process';
import type { ToolDefinition } from '../core/types.js';

export const symbolTool: ToolDefinition = {
  name: 'find_symbol',
  description: 'Find where a symbol (function, class, type, variable) is defined or used in the project. More precise than grep for code navigation.',
  input_schema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'The symbol name to search for (function name, class name, etc.)' },
      type: {
        type: 'string',
        enum: ['definition', 'references', 'all'],
        description: 'What to find: "definition" = where it\'s defined, "references" = where it\'s used, "all" = both. Default "all".',
      },
      language: {
        type: 'string',
        enum: ['typescript', 'javascript', 'python', 'go', 'java', 'auto'],
        description: 'Language for pattern matching. "auto" detects from file extensions. Default "auto".',
      },
    },
    required: ['symbol'],
  },
};

const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next'];

// Language-specific definition patterns
const DEF_PATTERNS: Record<string, string[]> = {
  typescript: [
    'function\\s+SYMBOL',
    'const\\s+SYMBOL\\s*=',
    'let\\s+SYMBOL\\s*=',
    'var\\s+SYMBOL\\s*=',
    'class\\s+SYMBOL',
    'interface\\s+SYMBOL',
    'type\\s+SYMBOL\\s*=',
    'enum\\s+SYMBOL',
    'export\\s+(default\\s+)?function\\s+SYMBOL',
    'export\\s+(default\\s+)?class\\s+SYMBOL',
    'export\\s+interface\\s+SYMBOL',
    'export\\s+type\\s+SYMBOL',
    'SYMBOL\\s*\\(',  // method definition
  ],
  javascript: [
    'function\\s+SYMBOL',
    'const\\s+SYMBOL\\s*=',
    'let\\s+SYMBOL\\s*=',
    'var\\s+SYMBOL\\s*=',
    'class\\s+SYMBOL',
    'module\\.exports\\.SYMBOL',
    'exports\\.SYMBOL',
  ],
  python: [
    'def\\s+SYMBOL',
    'class\\s+SYMBOL',
    'SYMBOL\\s*=',
  ],
  go: [
    'func\\s+SYMBOL',
    'func\\s+\\(.*\\)\\s+SYMBOL',
    'type\\s+SYMBOL\\s+struct',
    'type\\s+SYMBOL\\s+interface',
    'var\\s+SYMBOL',
    'const\\s+SYMBOL',
  ],
  java: [
    'class\\s+SYMBOL',
    'interface\\s+SYMBOL',
    '(public|private|protected)\\s+.*\\s+SYMBOL\\s*\\(',
  ],
};

function detectLanguage(workDir: string): string {
  try {
    const files = execFileSync('find', [
      '.', '-maxdepth', '3',
      '-type', 'f',
      '(',
      '-name', '*.ts', '-o',
      '-name', '*.js', '-o',
      '-name', '*.py', '-o',
      '-name', '*.go', '-o',
      '-name', '*.java',
      ')',
      '2>/dev/null',
      '|', 'head', '-20',
    ], {
      cwd: workDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
      shell: '/bin/bash',
    }).trim();
    if (files.includes('.ts')) return 'typescript';
    if (files.includes('.js')) return 'javascript';
    if (files.includes('.py')) return 'python';
    if (files.includes('.go')) return 'go';
    if (files.includes('.java')) return 'java';
  } catch (_) { /* language detection is best-effort */ }
  return 'typescript';
}

function getExtensionArgs(lang: string): string[] {
  const map: Record<string, string[]> = {
    typescript: ['--include', '*.ts', '--include', '*.tsx'],
    javascript: ['--include', '*.js', '--include', '*.jsx', '--include', '*.mjs'],
    python: ['--include', '*.py'],
    go: ['--include', '*.go'],
    java: ['--include', '*.java'],
  };
  return map[lang] || [];
}

function getExcludeArgs(): string[] {
  const args: string[] = [];
  for (const dir of EXCLUDE_DIRS) {
    args.push('--exclude-dir', dir);
  }
  return args;
}

export function executeSymbolTool(
  input: Record<string, unknown>, workDir: string,
): { result: string; is_error: boolean } {
  const symbol = input.symbol as string;
  const searchType = (input.type as string) || 'all';
  let lang = (input.language as string) || 'auto';

  if (lang === 'auto') {
    lang = detectLanguage(workDir);
  }

  const extArgs = getExtensionArgs(lang);
  const excludeArgs = getExcludeArgs();
  const results: string[] = [];

  try {
    if (searchType === 'definition' || searchType === 'all') {
      const patterns = DEF_PATTERNS[lang] || DEF_PATTERNS.typescript;
      const defResults: string[] = [];

      for (const pattern of patterns) {
        const escaped = pattern.replace(/SYMBOL/g, symbol);
        try {
          const grepArgs = [
            '-rn',
            ...extArgs,
            ...excludeArgs,
            '-E',
            escaped,
            '.',
          ];
          const output = execFileSync('grep', grepArgs, {
            cwd: workDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
          }).trim();
          if (output) {
            for (const line of output.split('\n')) {
              if (!defResults.includes(line)) defResults.push(line);
            }
          }
        } catch (_) { /* definition search is best-effort */ }
      }

      if (defResults.length > 0) {
        results.push('## Definitions\n' + defResults.join('\n'));
      } else if (searchType === 'definition') {
        results.push('No definitions found for: ' + symbol);
      }
    }

    if (searchType === 'references' || searchType === 'all') {
      try {
        const grepArgs = [
          '-rn',
          ...extArgs,
          ...excludeArgs,
          `\\b${symbol}\\b`,
          '.',
        ];
        const output = execFileSync('grep', grepArgs, {
          cwd: workDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
        }).trim();
        if (output) {
          results.push('## References\n' + output);
        } else {
          results.push('No references found for: ' + symbol);
        }
      } catch (err) {
        const e = err as { status?: number };
        if (e.status === 1) {
          results.push('No references found for: ' + symbol);
        }
      }
    }

    return { result: results.join('\n\n') || 'No results found', is_error: false };
  } catch (err) {
    return { result: `Error: ${(err as Error).message}`, is_error: true };
  }
}
