import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, extname, join, relative } from 'node:path';

// tree-sitter-parser archived — stub for graceful degradation
interface ParsedSymbol { kind: string; name: string; startLine: number; endLine: number; line?: number; signature?: string; }
const parseFileWithTreeSitter = (_path: string, _lang: string, _content?: string): { symbols: ParsedSymbol[]; imports: string[] } => ({ symbols: [], imports: [] });
const detectLanguage = (_path: string): string | null => null;
const initTreeSitter = async (): Promise<void> => {};

interface SymbolEntry {
  kind: string;
  name: string;
  signature: string;
  line: number;
}

interface FileOutline {
  path: string;
  symbols: SymbolEntry[];
}

export interface FileSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum' | 'method' | 'export';
  line: number;
  signature?: string;
}

export interface ImportInfo {
  source: string;
  names: string[];
  isDefault: boolean;
  isNamespace: boolean;
}

// Track whether tree-sitter has been initialized
let treeSitterInitialized = false;

async function ensureTreeSitterInit(): Promise<void> {
  if (!treeSitterInitialized) {
    try {
      await initTreeSitter();
      treeSitterInitialized = true;
    } catch {
      // Tree-sitter init failed, will fall back to regex
    }
  }
}

const LANG_PATTERNS: Record<string, Array<{ kind: string; regex: RegExp }>> = {
  ts: [
    // Standard function declarations
    { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)([^{]*)/gm },
    // Arrow function exports: export const foo = (args) => {
    { kind: 'function', regex: /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^{]+)?\s*=>\s*\{/gm },
    // Class declarations
    { kind: 'class', regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)([^{]*)/gm },
    // Interface declarations
    { kind: 'interface', regex: /^\s*(?:export\s+)?interface\s+(\w+)([^{]*)/gm },
    // Type aliases with generics: type Foo<T> = ...
    { kind: 'type', regex: /^\s*(?:export\s+)?type\s+(\w+)(?:<[^>]*>)?\s*=/gm },
    // Const declarations (non-arrow)
    { kind: 'const', regex: /^\s*(?:export\s+)?const\s+(\w+)(?:\s*:\s*([^=]+))?\s*=(?:\s*[^>])/gm },
    // Method declarations in classes
    { kind: 'method', regex: /^\s+(?:async\s+)?(?:private\s+|protected\s+|public\s+)?(\w+)\s*\(([^)]*)\)/gm },
    // Enum declarations
    { kind: 'enum', regex: /^\s*(?:export\s+)?enum\s+(\w+)/gm },
    // Default export class/function
    { kind: 'export', regex: /^\s*export\s+default\s+(?:class|function)\s+(\w+)/gm },
    // Re-exports: export { foo } from './bar'
    { kind: 'export', regex: /^\s*export\s+\{\s*([^}]+)\s*\}\s*from/gm },
    // Named exports: export { foo, bar }
    { kind: 'export', regex: /^\s*export\s+\{\s*([^}]+)\s*\}/gm },
  ],
  js: [
    { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)([^{]*)/gm },
    { kind: 'function', regex: /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^{]+)?\s*=>\s*\{/gm },
    { kind: 'class', regex: /^\s*(?:export\s+)?class\s+(\w+)([^{]*)/gm },
    { kind: 'const', regex: /^\s*(?:export\s+)?const\s+(\w+)\s*=/gm },
    { kind: 'method', regex: /^\s+(?:async\s+)?(?:private\s+|protected\s+|public\s+)?(\w+)\s*\(([^)]*)\)/gm },
  ],
  py: [
    { kind: 'function', regex: /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm },
    { kind: 'class', regex: /^class\s+(\w+)([^:]*)/gm },
  ],
  go: [
    { kind: 'function', regex: /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)/gm },
    { kind: 'type', regex: /^type\s+(\w+)\s+(struct|interface)/gm },
  ],
  rs: [
    { kind: 'function', regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/gm },
    { kind: 'type', regex: /^\s*(?:pub\s+)?(?:struct|enum|trait|union)\s+(\w+)(?:<[^>]*>)?/gm },
    { kind: 'const', regex: /^\s*(?:pub\s+)?const\s+(\w+)/gm },
    { kind: 'function', regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*[^{]+)?\s*\{/gm },
  ],
  php: [
    { kind: 'function', regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(\w+)\s*\(([^)]*)\)/gm },
    { kind: 'class', regex: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)([^{]*)/gm },
    { kind: 'interface', regex: /^\s*interface\s+(\w+)([^{]*)/gm },
    { kind: 'const', regex: /^\s*(?:public\s+|private\s+|protected\s+)?const\s+(\w+)/gm },
  ],
  rb: [
    { kind: 'function', regex: /^\s*(?:def\s+(?:self\.)?(\w+)\s*\(([^)]*)\)|def\s+(\w+)\s*\(([^)]*)\))/gm },
    { kind: 'class', regex: /^\s*(?:class\s+(\w+)([^{]*))/gm },
    { kind: 'module', regex: /^\s*module\s+(\w+)/gm },
  ],
  c: [
    { kind: 'function', regex: /^(?:static\s+|inline\s+|extern\s+)*(?:\w+\s+)+\*?\s*(\w+)\s*\(([^)]*)\)\s*\{/gm },
    { kind: 'type', regex: /^\s*(?:typedef\s+)?(?:struct|union|enum)\s+(\w+)/gm },
  ],
  kt: [
    { kind: 'function', regex: /^\s*(?:fun\s+(\w+)\s*\(([^)]*)\))/gm },
    { kind: 'class', regex: /^\s*(?:data\s+|sealed\s+|open\s+|abstract\s+)?class\s+(\w+)([^{]*)/gm },
    { kind: 'interface', regex: /^\s*interface\s+(\w+)([^{]*)/gm },
    { kind: 'type', regex: /^\s*(?:typealias\s+(\w+))/gm },
    { kind: 'const', regex: /^\s*(?:val|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/gm },
  ],
  swift: [
    { kind: 'function', regex: /^\s*(?:func\s+(\w+)\s*\(([^)]*)\))/gm },
    { kind: 'class', regex: /^\s*(?:final\s+|open\s+|public\s+)?class\s+(\w+)([^{]*)/gm },
    { kind: 'struct', regex: /^\s*struct\s+(\w+)([^{]*)/gm },
    { kind: 'enum', regex: /^\s*enum\s+(\w+)([^{]*)/gm },
    { kind: 'protocol', regex: /^\s*protocol\s+(\w+)([^{]*)/gm },
    { kind: 'type', regex: /^\s*typealias\s+(\w+)/gm },
  ],
  scala: [
    { kind: 'function', regex: /^\s*def\s+(\w+)\s*\(([^)]*)\)/gm },
    { kind: 'class', regex: /^\s*(?:abstract\s+)?class\s+(\w+)([^{]*)/gm },
    { kind: 'object', regex: /^\s*object\s+(\w+)([^{]*)/gm },
    { kind: 'trait', regex: /^\s*trait\s+(\w+)([^{]*)/gm },
    { kind: 'type', regex: /^\s*type\s+(\w+)/gm },
  ],
};

function getLanguage(filePath: string): string | null {
  const ext = extname(filePath).slice(1); // remove the dot
  if (ext === 'ts' || ext === 'tsx') return 'ts';
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs') return 'js';
  if (ext === 'py') return 'py';
  if (ext === 'go') return 'go';
  if (ext === 'rs') return 'rs';
  if (ext === 'php') return 'php';
  if (ext === 'rb') return 'rb';
  if (ext === 'c' || ext === 'h' || ext === 'cpp' || ext === 'hpp' || ext === 'cc' || ext === 'cxx') return 'c';
  if (ext === 'kt' || ext === 'kts') return 'kt';
  if (ext === 'swift') return 'swift';
  if (ext === 'scala' || ext === 'sc') return 'scala';
  return null;
}

function extractSymbols(content: string, lang: string): SymbolEntry[] {
  const patterns = LANG_PATTERNS[lang];
  if (!patterns) return [];

  const symbols: SymbolEntry[] = [];

  for (const { kind, regex } of patterns) {
    // Reset regex
    const re = new RegExp(regex.source, regex.flags);
    let match;
    while ((match = re.exec(content)) !== null) {
      const lineNum = content.slice(0, match.index).split('\n').length;
      const name = match[1];
      const rest = (match[2] || '').trim().replace(/\s+/g, ' ');
      const sig = rest ? `${name}${rest.startsWith('(') ? '' : ' '}${rest}` : name;
      symbols.push({ kind, name, signature: sig.slice(0, 120), line: lineNum });
    }
  }

  // Sort by line number
  symbols.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return symbols;
}

export async function getFileSymbols(filePath: string): Promise<FileSymbol[]> {
  if (!existsSync(filePath)) return [];

  const tsLang = detectLanguage(filePath);
  const regexLang = getLanguage(filePath);

  try {
    const content = readFileSync(filePath, 'utf-8');

    // Try tree-sitter first
    if (tsLang) {
      await ensureTreeSitterInit();
      try {
        const result = await parseFileWithTreeSitter(filePath, content, tsLang);
        if (result.symbols.length > 0) {
          return result.symbols.map(s => ({
            name: s.name,
            kind: s.kind as FileSymbol['kind'],
            line: s.line ?? 0,
            signature: s.signature,
          }));
        }
      } catch {
        // Tree-sitter failed, fall through to regex
      }
    }

    // Fall back to regex-based extraction
    if (!regexLang) return [];

    const symbols = extractSymbols(content, regexLang);
    return symbols.map(s => ({
      name: s.name,
      kind: s.kind as FileSymbol['kind'],
      line: s.line ?? 0,
      signature: s.signature,
    }));
  } catch {
    return [];
  }
}

function parseImportStrings(importStrings: string[]): ImportInfo[] {
  const imports: ImportInfo[] = [];

  for (const imp of importStrings) {
    // Match: import defaultExport from 'source'
    const defaultMatch = imp.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (defaultMatch) {
      imports.push({
        source: defaultMatch[2],
        names: [defaultMatch[1]],
        isDefault: true,
        isNamespace: false,
      });
      continue;
    }

    // Match: import { name1, name2 } from 'source'
    const namedMatch = imp.match(/import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]/);
    if (namedMatch) {
      const names = namedMatch[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      if (names.length > 0) {
        imports.push({
          source: namedMatch[2],
          names,
          isDefault: false,
          isNamespace: false,
        });
      }
      continue;
    }

    // Match: import * as name from 'source'
    const namespaceMatch = imp.match(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (namespaceMatch) {
      imports.push({
        source: namespaceMatch[2],
        names: [namespaceMatch[1]],
        isDefault: false,
        isNamespace: true,
      });
      continue;
    }

    // Match: import 'source' (side-effect)
    const sideEffectMatch = imp.match(/^import\s+['"]([^'"]+)['"]/);
    if (sideEffectMatch) {
      if (!imports.some(i => i.source === sideEffectMatch[1])) {
        imports.push({
          source: sideEffectMatch[1],
          names: [],
          isDefault: false,
          isNamespace: false,
        });
      }
      continue;
    }

    // Match: export { name } from 'source'
    const reExportMatch = imp.match(/export\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]/);
    if (reExportMatch) {
      const names = reExportMatch[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      if (names.length > 0) {
        imports.push({
          source: reExportMatch[2],
          names,
          isDefault: false,
          isNamespace: false,
        });
      }
      continue;
    }

    // Match: export * from 'source'
    const starExportMatch = imp.match(/export\s+\*\s+from\s+['"]([^'"]+)['"]/);
    if (starExportMatch) {
      imports.push({
        source: starExportMatch[1],
        names: [],
        isDefault: false,
        isNamespace: true,
      });
      continue;
    }

    // Match: require('source')
    const requireMatch = imp.match(/(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch) {
      imports.push({
        source: requireMatch[2],
        names: [requireMatch[1]],
        isDefault: true,
        isNamespace: false,
      });
      continue;
    }

    // Match: include/using directives (C/C++, C#)
    const includeMatch = imp.match(/#include\s+[<"]([^>"]+)[>"]/);
    if (includeMatch) {
      imports.push({
        source: includeMatch[1],
        names: [],
        isDefault: false,
        isNamespace: false,
      });
      continue;
    }

    const usingMatch = imp.match(/using\s+(\S+)/);
    if (usingMatch) {
      imports.push({
        source: usingMatch[1],
        names: [],
        isDefault: false,
        isNamespace: false,
      });
      continue;
    }

    // Match: from X import Y (Python)
    const fromImportMatch = imp.match(/from\s+(\S+)\s+import\s+(.+)/);
    if (fromImportMatch) {
      const names = fromImportMatch[2].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      imports.push({
        source: fromImportMatch[1],
        names,
        isDefault: false,
        isNamespace: false,
      });
      continue;
    }

    // Match: import X (Python)
    const pyImportMatch = imp.match(/^import\s+(\S+)/);
    if (pyImportMatch) {
      imports.push({
        source: pyImportMatch[1],
        names: [],
        isDefault: false,
        isNamespace: false,
      });
      continue;
    }

    // Match: use X (Rust)
    const useMatch = imp.match(/^use\s+(\S+)/);
    if (useMatch) {
      imports.push({
        source: useMatch[1],
        names: [],
        isDefault: false,
        isNamespace: false,
      });
      continue;
    }
  }

  return imports;
}

export async function extractImports(filePath: string): Promise<ImportInfo[]> {
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, 'utf-8');

    // Try tree-sitter first for import extraction
    const tsLang = detectLanguage(filePath);
    if (tsLang) {
      await ensureTreeSitterInit();
      try {
        const result = await parseFileWithTreeSitter(filePath, content, tsLang);
        if (result.imports.length > 0) {
          // Parse the raw import strings into structured ImportInfo
          return parseImportStrings(result.imports);
        }
      } catch {
        // Tree-sitter failed, fall through to regex
      }
    }

    const imports: ImportInfo[] = [];

    // Match: import defaultExport from 'source'
    const defaultImportRegex = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = defaultImportRegex.exec(content)) !== null) {
      imports.push({
        source: match[2],
        names: [match[1]],
        isDefault: true,
        isNamespace: false,
      });
    }

    // Match: import { name1, name2 } from 'source'
    const namedImportRegex = /import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = namedImportRegex.exec(content)) !== null) {
      const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      if (names.length > 0) {
        imports.push({
          source: match[2],
          names,
          isDefault: false,
          isNamespace: false,
        });
      }
    }

    // Match: import * as name from 'source'
    const namespaceImportRegex = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = namespaceImportRegex.exec(content)) !== null) {
      imports.push({
        source: match[2],
        names: [match[1]],
        isDefault: false,
        isNamespace: true,
      });
    }

    // Match: import 'source' (side-effect import)
    const sideEffectImportRegex = /^import\s+['"]([^'"]+)['"]/gm;
    while ((match = sideEffectImportRegex.exec(content)) !== null) {
      // Avoid double-counting: only if not already matched by other patterns
      const src = match[1];
      if (!imports.some(i => i.source === src)) {
        imports.push({
          source: src,
          names: [],
          isDefault: false,
          isNamespace: false,
        });
      }
    }

    // Match: export { name } from 'source' (re-exports)
    const reExportRegex = /export\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = reExportRegex.exec(content)) !== null) {
      const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      if (names.length > 0) {
        imports.push({
          source: match[2],
          names,
          isDefault: false,
          isNamespace: false,
        });
      }
    }

    // Match: export * from 'source'
    const starExportRegex = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = starExportRegex.exec(content)) !== null) {
      imports.push({
        source: match[1],
        names: [],
        isDefault: false,
        isNamespace: true,
      });
    }

    // Match: require('source')
    const requireRegex = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
      imports.push({
        source: match[2],
        names: [match[1]],
        isDefault: true,
        isNamespace: false,
      });
    }

    return imports;
  } catch {
    return [];
  }
}

// --- Tree-sitter based repo map ---

export async function buildTreeSitterRepoMap(
  workDir: string,
  options?: { maxFiles?: number; maxChars?: number; languages?: string[] }
): Promise<string> {
  const maxFiles = options?.maxFiles ?? 50;
  const maxChars = options?.maxChars ?? 8000;
  const langFilter = options?.languages;

  // Get source files
  let files: string[];
  try {
    const output = execSync(
      'find . -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.mjs" ' +
      '-o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.php" -o -name "*.rb" ' +
      '-o -name "*.c" -o -name "*.h" -o -name "*.cpp" -o -name "*.hpp" -o -name "*.cc" ' +
      '-o -name "*.kt" -o -name "*.kts" -o -name "*.swift" -o -name "*.scala" -o -name "*.sc" \\) ' +
      '-not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" ' +
      '-not -path "*/build/*" -not -name "*.d.ts" -not -name "*.test.*" -not -name "*.spec.*" ' +
      '| sort',
      { cwd: workDir, encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    files = output ? output.split('\n').slice(0, maxFiles) : [];
  } catch {
    return '';
  }

  if (files.length === 0) return '';

  // Initialize tree-sitter
  await ensureTreeSitterInit();

  const outlines: FileOutline[] = [];

  for (const relPath of files) {
    const absPath = resolve(workDir, relPath);
    if (!existsSync(absPath)) continue;

    const tsLang = detectLanguage(relPath);

    // Apply language filter if specified
    if (langFilter && tsLang && !langFilter.includes(tsLang)) continue;
    if (langFilter && !tsLang) continue;

    try {
      const content = readFileSync(absPath, 'utf-8');
      let symbols: SymbolEntry[] = [];

      // Try tree-sitter
      if (tsLang) {
        try {
          const result = await parseFileWithTreeSitter(absPath, content, tsLang);
          if (result.symbols.length > 0) {
            symbols = result.symbols.map(s => ({
              kind: s.kind,
              name: s.name,
              signature: s.signature || s.name,
              line: s.line ?? 0,
            }));
          }
        } catch {
          // Tree-sitter failed, skip this file
          continue;
        }
      }

      if (symbols.length > 0) {
        outlines.push({ path: relPath, symbols });
      }
    } catch { /* skip unreadable files */ }
  }

  if (outlines.length === 0) return '';

  // Rank symbols by relevance: exported > public > private, classes > functions > variables
  const relevanceRank: Record<string, number> = {
    class: 10,
    interface: 9,
    enum: 8,
    type: 7,
    function: 6,
    method: 5,
    export: 4,
    const: 3,
    variable: 2,
  };

  // Build compact outline with ranking
  const parts: string[] = [];
  let totalChars = 0;

  for (const o of outlines) {
    // Sort symbols by relevance (higher first), then by line number
    const sorted = [...o.symbols].sort((a, b) => {
      const rankDiff = (relevanceRank[b.kind] || 0) - (relevanceRank[a.kind] || 0);
      if (rankDiff !== 0) return rankDiff;
      return (a.line ?? 0) - (b.line ?? 0);
    });

    const symbolLines = sorted.map(s => {
      const prefix = s.kind === 'method' ? '    ' : '  ';
      return `${prefix}${s.kind} ${s.signature}`;
    });

    const fileBlock = `${o.path}:\n${symbolLines.join('\n')}`;

    // Check if adding this block would exceed maxChars
    if (totalChars + fileBlock.length > maxChars && parts.length > 0) {
      break;
    }

    parts.push(fileBlock);
    totalChars += fileBlock.length;
  }

  if (parts.length === 0) return '';

  return '## Code Map (tree-sitter)\n```\n' + parts.join('\n\n') + '\n```';
}

export async function buildRepoMap(workDir: string, maxFiles: number = 50): Promise<string> {
  // Get source files
  let files: string[];
  try {
    const output = execSync(
      'find . -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.mjs" ' +
      '-o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.php" -o -name "*.rb" ' +
      '-o -name "*.c" -o -name "*.h" -o -name "*.cpp" -o -name "*.hpp" -o -name "*.cc" ' +
      '-o -name "*.kt" -o -name "*.kts" -o -name "*.swift" -o -name "*.scala" -o -name "*.sc" \\) ' +
      '-not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" ' +
      '-not -path "*/build/*" -not -name "*.d.ts" -not -name "*.test.*" -not -name "*.spec.*" ' +
      '| sort',
      { cwd: workDir, encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    files = output ? output.split('\n').slice(0, maxFiles) : [];
  } catch {
    return '';
  }

  if (files.length === 0) return '';

  const outlines: FileOutline[] = [];

  for (const relPath of files) {
    const absPath = resolve(workDir, relPath);
    if (!existsSync(absPath)) continue;

    const tsLang = detectLanguage(relPath);
    const regexLang = getLanguage(relPath);

    try {
      const content = readFileSync(absPath, 'utf-8');
      let symbols: SymbolEntry[] = [];

      // Try tree-sitter first
      if (tsLang) {
        await ensureTreeSitterInit();
        try {
          const result = await parseFileWithTreeSitter(absPath, content, tsLang);
          if (result.symbols.length > 0) {
            symbols = result.symbols.map(s => ({
              kind: s.kind,
              name: s.name,
              signature: s.signature || s.name,
              line: s.line ?? 0,
            }));
          }
        } catch {
          // Fall through to regex
        }
      }

      // Fall back to regex
      if (symbols.length === 0 && regexLang) {
        symbols = extractSymbols(content, regexLang);
      }

      if (symbols.length > 0) {
        outlines.push({ path: relPath, symbols });
      }
    } catch { /* skip unreadable files */ }
  }

  if (outlines.length === 0) return '';

  // Build compact outline
  const parts = outlines.map(o => {
    const symbolLines = o.symbols.map(s => {
      const prefix = s.kind === 'method' ? '    ' : '  ';
      return `${prefix}${s.kind} ${s.signature}`;
    });
    return `${o.path}:\n${symbolLines.join('\n')}`;
  });

  return '## Code Map\n```\n' + parts.join('\n\n') + '\n```';
}

export interface RepoSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method' | 'export';
  file: string;
  line: number;
  signature?: string;
}

export function extractSymbolsFromFile(filePath: string): RepoSymbol[] {
  const symbols: RepoSymbol[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const relPath = filePath;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Export function/const/class
      let m = line.match(/^export\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))/);
      if (m) { symbols.push({ name: m[1], kind: 'function', file: relPath, line: lineNum, signature: `function ${m[1]}${m[2]}` }); continue; }

      m = line.match(/^export\s+class\s+(\w+)/);
      if (m) { symbols.push({ name: m[1], kind: 'class', file: relPath, line: lineNum }); continue; }

      m = line.match(/^export\s+interface\s+(\w+)/);
      if (m) { symbols.push({ name: m[1], kind: 'interface', file: relPath, line: lineNum }); continue; }

      m = line.match(/^export\s+type\s+(\w+)/);
      if (m) { symbols.push({ name: m[1], kind: 'type', file: relPath, line: lineNum }); continue; }

      m = line.match(/^export\s+(?:const|let|var)\s+(\w+)/);
      if (m) { symbols.push({ name: m[1], kind: 'variable', file: relPath, line: lineNum }); continue; }

      // Class methods
      m = line.match(/^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/);
      if (m && m[1] !== 'if' && m[1] !== 'for' && m[1] !== 'while' && m[1] !== 'switch') {
        symbols.push({ name: m[1], kind: 'method', file: relPath, line: lineNum });
      }
    }
  } catch { /* skip unreadable files */ }
  return symbols;
}

export function buildEnhancedRepoMap(workDir: string, maxSymbols: number = 200): string {
  const files = readdirSync(join(workDir, 'src'), { recursive: true })
    .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts') && !f.includes('__tests__'))
    .map(f => join(workDir, 'src', f));

  const allSymbols: RepoSymbol[] = [];
  for (const file of files) {
    allSymbols.push(...extractSymbolsFromFile(file));
  }

  // Group by file
  const byFile = new Map<string, RepoSymbol[]>();
  for (const sym of allSymbols) {
    const rel = relative(workDir, sym.file);
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel)!.push(sym);
  }

  // Format as map
  const lines: string[] = ['# Repository Map', ''];
  for (const [file, syms] of byFile) {
    lines.push(`## ${file}`);
    for (const sym of syms.slice(0, 20)) {
      const sig = sym.signature ? ` — ${sym.signature}` : '';
      lines.push(`  ${sym.kind}: ${sym.name} (line ${sym.line})${sig}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
