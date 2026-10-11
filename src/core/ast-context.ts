import { readFileSync, existsSync } from 'node:fs';

export interface ASTContext {
  functions: Array<{ name: string; file: string; startLine: number; endLine: number; complexity: number }>;
  classes: Array<{ name: string; file: string; methods: string[]; startLine: number; endLine: number }>;
  imports: Array<{ from: string; symbols: string[]; file: string }>;
  exports: Array<{ name: string; type: string; file: string }>;
}

export interface ContextPriority {
  file: string;
  score: number;
  reason: string;
}

/**
 * Parse a file to extract functions, classes, imports, and exports using regex.
 */
export function extractASTContext(filePath: string, content: string): ASTContext {
  const context: ASTContext = {
    functions: [],
    classes: [],
    imports: [],
    exports: [],
  };

  const lines = content.split('\n');

  // Extract functions (function declarations, arrow functions assigned to const/let/var, method shorthand)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // function name(...) { ... }
    const funcDeclMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
    if (funcDeclMatch) {
      const name = funcDeclMatch[1];
      const startLine = i + 1;
      const endLine = findBlockEnd(lines, i);
      const blockContent = lines.slice(i, endLine).join('\n');
      const complexity = calculateComplexity(blockContent);
      context.functions.push({ name, file: filePath, startLine, endLine, complexity });
      continue;
    }

    // const/let/var name = (...) => { ... } or const name = function(...) { ... }
    const arrowMatch = line.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*(?:=>|function\s*\()/);
    if (arrowMatch) {
      const name = arrowMatch[1];
      const startLine = i + 1;
      const endLine = findBlockEnd(lines, i);
      const blockContent = lines.slice(i, endLine).join('\n');
      const complexity = calculateComplexity(blockContent);
      // Avoid duplicates if already captured as function declaration
      if (!context.functions.some(f => f.name === name && f.file === filePath)) {
        context.functions.push({ name, file: filePath, startLine, endLine, complexity });
      }
      continue;
    }

    // Class declarations
    const classMatch = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch) {
      const name = classMatch[1];
      const startLine = i + 1;
      const endLine = findBlockEnd(lines, i);
      const classBody = lines.slice(i, endLine).join('\n');
      const methods = extractMethods(classBody);
      context.classes.push({ name, file: filePath, methods, startLine, endLine });
      continue;
    }

    // Import statements
    const importMatch = line.match(/^import\s+(?:\{[^}]*\}\s+from\s+)?['"]([^'"]+)['"]/);
    if (importMatch) {
      const from = importMatch[1];
      const symbolsMatch = line.match(/\{\s*([^}]+)\s*\}/);
      const symbols = symbolsMatch
        ? symbolsMatch[1].split(',').map(s => s.trim()).filter(Boolean)
        : [];
      context.imports.push({ from, symbols, file: filePath });
      continue;
    }

    // Default import: import name from '...'
    const defaultImportMatch = line.match(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (defaultImportMatch) {
      const from = defaultImportMatch[2];
      const symbols = [defaultImportMatch[1]];
      // Avoid duplicate if already captured as named import
      if (!context.imports.some(imp => imp.from === from && imp.file === filePath)) {
        context.imports.push({ from, symbols, file: filePath });
      }
      continue;
    }

    // Export statements
    const exportMatch = line.match(/^export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)\s+(\w+)/);
    if (exportMatch) {
      const name = exportMatch[1];
      const type = line.includes('function') ? 'function' :
        line.includes('class') ? 'class' :
        line.includes('interface') ? 'interface' :
        line.includes('type') ? 'type' : 'variable';
      context.exports.push({ name, type, file: filePath });
      continue;
    }

    // Export { ... }
    const exportNamedMatch = line.match(/^export\s+\{\s*([^}]+)\s*\}/);
    if (exportNamedMatch) {
      const names = exportNamedMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      for (const name of names) {
        const actualName = name.split(/\s+as\s+/)[0].trim();
        if (!context.exports.some(e => e.name === actualName && e.file === filePath)) {
          context.exports.push({ name: actualName, type: 'named', file: filePath });
        }
      }
      continue;
    }

    // export * from '...'
    const exportAllMatch = line.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/);
    if (exportAllMatch) {
      context.exports.push({ name: '*', type: 're-export', file: filePath });
      continue;
    }
  }

  return context;
}

/**
 * Calculate cyclomatic complexity estimate.
 * Counts if/else if/for/while/switch/case/catch/&&/||/ternary.
 */
export function calculateComplexity(content: string): number {
  let complexity = 1; // base complexity

  // Count decision points
  const patterns = [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bswitch\s*\(/g,
    /\bcatch\s*\(/g,
    /\bcase\s+/g,
    /\?\s*[^:]*\s*:/g,  // ternary
  ];

  for (const pattern of patterns) {
    const matches = content.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }

  // Count logical operators (&&, ||) — each adds a path
  const logicalAnd = content.match(/&&/g);
  if (logicalAnd) complexity += logicalAnd.length;

  const logicalOr = content.match(/\|\|/g);
  if (logicalOr) complexity += logicalOr.length;

  return complexity;
}

/**
 * Score files by relevance to a task description.
 * Uses keyword matching on file paths and content.
 */
export function prioritizeFiles(
  files: Array<{ path: string; content: string }>,
  task: string,
): ContextPriority[] {
  const taskLower = task.toLowerCase();
  const taskWords = taskLower.split(/\W+/).filter(w => w.length > 2);
  const taskTerms = new Set(taskWords);

  const priorities: ContextPriority[] = files.map(file => {
    let score = 0;
    const reasons: string[] = [];

    const pathLower = file.path.toLowerCase();
    const contentLower = file.content.toLowerCase();

    // Score based on path matches
    for (const term of taskTerms) {
      if (pathLower.includes(term)) {
        score += 10;
        reasons.push(`path matches "${term}"`);
      }
    }

    // Score based on content matches
    for (const term of taskTerms) {
      const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
      const matches = file.content.match(regex);
      if (matches) {
        score += matches.length * 2;
        if (reasons.length < 5) {
          reasons.push(`content contains "${term}" (${matches.length}x)`);
        }
      }
    }

    // Bonus for files with exports (likely entry points)
    const exportCount = (file.content.match(/^export\s+/gm) || []).length;
    if (exportCount > 0) {
      score += Math.min(exportCount, 5);
    }

    // Bonus for test files if task mentions testing
    if (taskLower.includes('test') && (pathLower.includes('.test.') || pathLower.includes('.spec.'))) {
      score += 8;
      reasons.push('test file relevant to testing task');
    }

    // Bonus for config files if task mentions configuration
    if (taskLower.includes('config') && pathLower.includes('config')) {
      score += 8;
      reasons.push('config file relevant to configuration task');
    }

    return {
      file: file.path,
      score,
      reason: reasons.length > 0 ? reasons.slice(0, 3).join('; ') : 'general relevance',
    };
  });

  // Sort by score descending
  priorities.sort((a, b) => b.score - a.score);

  return priorities;
}

/**
 * Find symbols in the AST context that match a query string.
 */
export function getRelevantSymbols(context: ASTContext, query: string): string[] {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\W+/).filter(w => w.length > 0);
  const symbols: string[] = [];

  // Check function names
  for (const func of context.functions) {
    if (queryTerms.some(term => func.name.toLowerCase().includes(term))) {
      symbols.push(`function ${func.name} (${func.file}:${func.startLine})`);
    }
  }

  // Check class names
  for (const cls of context.classes) {
    if (queryTerms.some(term => cls.name.toLowerCase().includes(term))) {
      symbols.push(`class ${cls.name} (${cls.file}:${cls.startLine})`);
    }
    // Check methods
    for (const method of cls.methods) {
      if (queryTerms.some(term => method.toLowerCase().includes(term))) {
        symbols.push(`method ${cls.name}.${method} (${cls.file}:${cls.startLine})`);
      }
    }
  }

  // Check exports
  for (const exp of context.exports) {
    if (queryTerms.some(term => exp.name.toLowerCase().includes(term))) {
      symbols.push(`export ${exp.name} (${exp.type})`);
    }
  }

  return symbols;
}

/**
 * Format a compact summary string from AST context.
 */
export function formatASTSummary(context: ASTContext): string {
  const parts: string[] = [];

  if (context.functions.length > 0) {
    const funcList = context.functions
      .slice(0, 10)
      .map(f => `${f.name} (complexity: ${f.complexity})`)
      .join(', ');
    parts.push(`Functions (${context.functions.length}): ${funcList}`);
    if (context.functions.length > 10) {
      parts[parts.length - 1] += ` +${context.functions.length - 10} more`;
    }
  }

  if (context.classes.length > 0) {
    const classList = context.classes
      .slice(0, 5)
      .map(c => `${c.name} (${c.methods.length} methods)`)
      .join(', ');
    parts.push(`Classes (${context.classes.length}): ${classList}`);
    if (context.classes.length > 5) {
      parts[parts.length - 1] += ` +${context.classes.length - 5} more`;
    }
  }

  if (context.imports.length > 0) {
    parts.push(`Imports: ${context.imports.length} modules`);
  }

  if (context.exports.length > 0) {
    const exportNames = context.exports.map(e => e.name).join(', ');
    parts.push(`Exports: ${exportNames}`);
  }

  return parts.join(' | ');
}

/**
 * Find the end line of a block starting at the given line index.
 * Handles simple brace matching.
 */
function findBlockEnd(lines: string[], startIndex: number): number {
  let braceCount = 0;
  let started = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') {
        braceCount++;
        started = true;
      } else if (ch === '}') {
        braceCount--;
      }
    }
    if (started && braceCount === 0) {
      return i + 1;
    }
  }

  return lines.length;
}

/**
 * Extract method names from a class body string.
 */
function extractMethods(classBody: string): string[] {
  const methods: string[] = [];
  const methodRegex = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = methodRegex.exec(classBody)) !== null) {
    // Skip constructor and static method names that are keywords
    const name = match[1];
    if (name !== 'if' && name !== 'for' && name !== 'while' && name !== 'switch' && name !== 'catch') {
      methods.push(name);
    }
  }

  return methods;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
