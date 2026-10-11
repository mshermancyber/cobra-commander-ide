import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface CallSite {
  /** File where the call appears */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** Column number (1-based) */
  column: number;
  /** The function/method name being called */
  calleeName: string;
  /** The call expression as it appears in source */
  rawExpression: string;
  /** Arguments passed */
  args: CallArg[];
  /** Whether the callee is imported or local */
  calleeOrigin: 'import' | 'require' | 'local' | 'unknown';
  /** The import path or module specifier if known */
  importSource?: string;
  /** Surrounding context lines */
  contextLines: string[];
}

export interface CallArg {
  /** The raw argument text */
  raw: string;
  /** Inferred type from the argument value */
  inferredType: string;
  /** Whether this is a literal, variable, expression, etc. */
  kind: 'literal' | 'identifier' | 'expression' | 'spread' | 'unknown';
  /** For literals, the parsed value */
  literalValue?: string | number | boolean | null;
}

export interface TypeInference {
  /** Function name */
  name: string;
  /** Inferred parameter types from aggregated call sites */
  paramTypes: ParamType[];
  /** Inferred return type from usage context */
  returnType: string;
  /** Confidence 0-1 */
  confidence: number;
}

export interface ParamType {
  /** Parameter index (0-based) */
  index: number;
  /** Inferred type name */
  typeName: string;
  /** Call-site evidence for this type */
  evidence: string[];
  /** Whether this param is optional (not always present) */
  optional: boolean;
}

export interface StubSkeleton {
  /** Function/method name */
  name: string;
  /** Suggested implementation */
  implementation: string;
  /** Language of the implementation */
  language: string;
  /** The file where the stub should be placed */
  targetFile: string;
  /** Suggested import statements */
  imports: string[];
  /** Parameter signature */
  params: Array<{ name: string; type: string; default?: string }>;
  /** Return type */
  returnType: string;
  /** Whether this is an async function */
  isAsync: boolean;
  /** Whether this is a method (vs standalone function) */
  isMethod: boolean;
  /** Class name if this is a method */
  className?: string;
}

export interface QuickFixAction {
  id: string;
  kind: 'implement-stub' | 'add-import' | 'fix-types' | 'add-null-check';
  title: string;
  description: string;
  file: string;
  line: number;
  /** The edit to apply */
  edit: {
    range: { startLine: number; startCol: number; endLine: number; endCol: number };
    replacement: string;
  };
}

// ──────────────────────────────────────────────
// Call-Site Scanner
// ──────────────────────────────────────────────

const CALL_PATTERN = /(?:(?:(\w+)\s*\.\s*)?(\w+))\s*\(([^)]*)\)/g;
const IMPORT_PATTERN = /import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
const REQUIRE_PATTERN = /(?:const|let|var)\s+(?:{([^}]+)}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Scan a source file for function/method invocations.
 */
export function scanCallSites(filePath: string, source?: string): CallSite[] {
  const src = source ?? (existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '');
  if (!src) return [];

  const lines = src.split('\n');
  const callSites: CallSite[] = [];

  // Build import map: importedName → modulePath
  const importMap = new Map<string, string>();
  let m: RegExpExecArray | null;
  IMPORT_PATTERN.lastIndex = 0;
  while ((m = IMPORT_PATTERN.exec(src)) !== null) {
    const names = (m[1] ?? m[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const modulePath = m[3];
    for (const name of names) {
      const cleanName = name.replace(/\s+as\s+\w+$/, '').trim(); // handle "foo as bar"
      importMap.set(cleanName, modulePath);
    }
  }

  REQUIRE_PATTERN.lastIndex = 0;
  while ((m = REQUIRE_PATTERN.exec(src)) !== null) {
    const names = (m[1] ?? m[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const modulePath = m[3];
    for (const name of names) {
      const cleanName = name.replace(/\s+as\s+\w+$/, '').trim();
      if (!importMap.has(cleanName)) {
        importMap.set(cleanName, modulePath);
      }
    }
  }

  // Scan each line for call expressions
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    CALL_PATTERN.lastIndex = 0;

    while ((m = CALL_PATTERN.exec(line)) !== null) {
      const receiver = m[1]; // e.g., "obj" in obj.method()
      const calleeName = receiver ? `${receiver}.${m[2]}` : m[2];
      const argsRaw = m[3];
      const column = m.index + 1;

      // Skip common keywords and built-ins
      if (['if', 'for', 'while', 'switch', 'catch', 'function', 'class', 'new', 'return', 'throw', 'typeof', 'instanceof', 'import'].includes(m[2])) {
        continue;
      }

      // Determine origin
      let calleeOrigin: CallSite['calleeOrigin'] = 'unknown';
      let importSource: string | undefined;
      if (importMap.has(m[2])) {
        calleeOrigin = 'import';
        importSource = importMap.get(m[2]);
      } else if (importMap.has(receiver ?? '')) {
        calleeOrigin = 'import';
        importSource = importMap.get(receiver ?? '');
      } else {
        // Check if defined locally
        const nameToCheck = m[2];
        const defPattern = new RegExp(
          `\\b(function\\s+${nameToCheck}|const\\s+${nameToCheck}\\s*=|let\\s+${nameToCheck}\\s*=|var\\s+${nameToCheck}\\s*=|${nameToCheck}\\s*[:=]\\s*(?:async\\s*)?\\()`,
        );
        if (defPattern.test(src)) {
          calleeOrigin = 'local';
        }
      }

      // Parse arguments
      const args = parseCallArgs(argsRaw);

      // Capture context lines (±2)
      const contextStart = Math.max(0, i - 2);
      const contextEnd = Math.min(lines.length, i + 3);
      const contextLines = lines.slice(contextStart, contextEnd);

      callSites.push({
        file: filePath,
        line: i + 1,
        column,
        calleeName,
        rawExpression: m[0],
        args,
        calleeOrigin,
        importSource,
        contextLines,
      });
    }
  }

  return callSites;
}

/**
 * Parse call arguments string into structured arg objects.
 */
function parseCallArgs(argsRaw: string): CallArg[] {
  if (!argsRaw.trim()) return [];

  const args: CallArg[] = [];
  let depth = 0;
  let current = '';
  let inString: string | null = null;

  for (let i = 0; i < argsRaw.length; i++) {
    const ch = argsRaw[i];

    if (inString) {
      current += ch;
      if (ch === inString && argsRaw[i - 1] !== '\\') {
        inString = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      current += ch;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      args.push(analyzeArg(current.trim()));
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    args.push(analyzeArg(current.trim()));
  }

  return args;
}

function analyzeArg(raw: string): CallArg {
  const trimmed = raw.trim();

  // String literal
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('`') && trimmed.endsWith('`'))) {
    return {
      raw: trimmed,
      inferredType: 'string',
      kind: 'literal',
      literalValue: trimmed.slice(1, -1),
    };
  }

  // Numeric literal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return {
      raw: trimmed,
      inferredType: 'number',
      kind: 'literal',
      literalValue: Number(trimmed),
    };
  }

  // Boolean/null/undefined literal
  if (trimmed === 'true' || trimmed === 'false') {
    return { raw: trimmed, inferredType: 'boolean', kind: 'literal', literalValue: trimmed === 'true' };
  }
  if (trimmed === 'null') {
    return { raw: trimmed, inferredType: 'null', kind: 'literal', literalValue: null };
  }
  if (trimmed === 'undefined') {
    return { raw: trimmed, inferredType: 'undefined', kind: 'literal', literalValue: undefined };
  }

  // Object/array literal
  if (trimmed.startsWith('{')) return { raw: trimmed, inferredType: 'object', kind: 'expression' };
  if (trimmed.startsWith('[')) return { raw: trimmed, inferredType: 'array', kind: 'expression' };

  // Spread
  if (trimmed.startsWith('...')) return { raw: trimmed, inferredType: 'any', kind: 'spread' };

  // Arrow/function expression
  if (trimmed.includes('=>') || trimmed.startsWith('function')) {
    return { raw: trimmed, inferredType: 'function', kind: 'expression' };
  }

  // Identifier / variable
  if (/^[a-zA-Z_$][\w$.]*$/.test(trimmed)) {
    return { raw: trimmed, inferredType: 'any', kind: 'identifier' };
  }

  return { raw: trimmed, inferredType: 'any', kind: 'expression' };
}

// ──────────────────────────────────────────────
// Type Inference from Call Arguments
// ──────────────────────────────────────────────

/**
 * Infer parameter and return types by aggregating call-site evidence.
 */
export function inferTypesFromCallSites(
  functionName: string,
  callSites: CallSite[],
): TypeInference | null {
  const relevant = callSites.filter((cs) => cs.calleeName === functionName || cs.calleeName.endsWith(`.${functionName}`));
  if (relevant.length === 0) return null;

  const paramEvidence: Map<number, string[]> = new Map();
  const paramOptional: Map<number, number> = new Map(); // param index → absent count
  const returnEvidence: string[] = [];

  for (const cs of relevant) {
    for (let i = 0; i < cs.args.length; i++) {
      if (!paramEvidence.has(i)) {
        paramEvidence.set(i, []);
        paramOptional.set(i, 0);
      }
      paramEvidence.get(i)!.push(cs.args[i].inferredType);
    }

    // If this call has fewer args than we've seen elsewhere, mark trailing as optional
    const maxSeen = paramEvidence.size;
    for (let i = cs.args.length; i < maxSeen; i++) {
      paramOptional.set(i, (paramOptional.get(i) ?? 0) + 1);
    }

    // Infer return type from context — look at what the call is assigned to or used as
    const context = cs.contextLines.join('\n');
    returnEvidence.push(inferReturnFromContext(context, cs.rawExpression));
  }

  const paramTypes: ParamType[] = [];
  Array.from(paramEvidence.entries()).forEach(([index, types]) => {
    paramTypes.push({
      index,
      typeName: consensusType(types),
      evidence: Array.from(new Set(types)),
      optional: (paramOptional.get(index) ?? 0) > 0,
    });
  });

  const returnType = returnEvidence.length > 0
    ? consensusType(returnEvidence)
    : 'void';

  const confidence = Math.min(1, relevant.length / 3); // scales with sample size

  return {
    name: functionName,
    paramTypes,
    returnType,
    confidence,
  };
}

function consensusType(types: string[]): string {
  if (types.length === 0) return 'any';
  const counts = new Map<string, number>();
  for (const t of types) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best = 'any';
  let bestCount = 0;
  counts.forEach((c, t) => {
    if (c > bestCount && t !== 'any' && t !== 'undefined') {
      best = t;
      bestCount = c;
    }
  });
  if (bestCount === 0) return 'any';
  return best;
}

function inferReturnFromContext(contextLines: string, expression: string): string {
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignMatch = contextLines.match(
    new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*${escaped}`),
  );
  if (assignMatch) {
    // Look for type annotation
    const typeAnnotMatch = contextLines.match(
      new RegExp(`(?:const|let|var)\\s+\\w+\\s*:\\s*(\\w+(?:<[^>]+>)?(?:\\[\\])?)\\s*=\\s*${escaped}`),
    );
    if (typeAnnotMatch) return typeAnnotMatch[1];

    const varName = assignMatch[1];
    // Check what's done with the variable later
    if (contextLines.includes(`.push(${varName}`) || contextLines.includes(`[${varName}]`)) return 'array';
    if (contextLines.includes(`${varName}.`) && /\b(?:then|catch)\s*\(/.test(contextLines)) return 'Promise<any>';
  }

  // Check if used in condition
  if (new RegExp(`if\\s*\\(\\s*${escaped}`).test(contextLines)) return 'boolean';

  // Check if used as argument to .map/.filter/etc
  if (new RegExp(`\\.(?:map|filter|find|reduce)\\s*\\(\\s*${escaped}`).test(contextLines)) return 'array';

  return 'any';
}

// ──────────────────────────────────────────────
// Stub-to-Implementation Generator
// ──────────────────────────────────────────────

/**
 * Generate a stub-to-implementation skeleton based on call-site usage patterns.
 */
export function generateStubImplementation(
  functionName: string,
  callSites: CallSite[],
  targetFile: string,
  options?: {
    isAsync?: boolean;
    isMethod?: boolean;
    className?: string;
    language?: string;
  },
): StubSkeleton | null {
  const typeInfo = inferTypesFromCallSites(functionName, callSites);
  if (!typeInfo) return null;

  const ext = extname(targetFile).toLowerCase();
  const lang = options?.language ?? languageFromExt(ext);
  const isAsync = options?.isAsync ?? false;
  const isMethod = options?.isMethod ?? false;

  const params = typeInfo.paramTypes.map((pt) => ({
    name: `param${pt.index}`,
    type: pt.typeName,
    default: pt.optional ? 'undefined' : undefined,
  }));

  const imports: string[] = [];
  let implementationLines: string[] = [];
  const returnType = typeInfo.returnType;

  if (lang === 'typescript' || lang === 'javascript') {
    implementationLines = buildTsImpl(functionName, params, returnType, isAsync, isMethod, options?.className);
  } else if (lang === 'python') {
    implementationLines = buildPyImpl(functionName, params, returnType, isAsync);
  } else {
    implementationLines = buildTsImpl(functionName, params, returnType, isAsync, isMethod, options?.className);
  }

  return {
    name: functionName,
    implementation: implementationLines.join('\n'),
    language: lang,
    targetFile,
    imports,
    params,
    returnType,
    isAsync,
    isMethod,
    className: options?.className,
  };
}

function buildTsImpl(
  name: string,
  params: Array<{ name: string; type: string; default?: string }>,
  returnType: string,
  isAsync: boolean,
  isMethod: boolean,
  className?: string,
): string[] {
  const lines: string[] = [];
  const prefix = isAsync ? 'async ' : '';
  const ret = returnType !== 'void' ? `: ${returnType === 'Promise<any>' ? 'Promise<any>' : returnType}` : ': void';
  const paramStr = params
    .map((p) => `${p.name}${p.type !== 'any' ? `: ${p.type}` : ''}${p.default ? ` = ${p.default}` : ''}`)
    .join(', ');

  // JSDoc
  lines.push('/**');
  lines.push(` * Implementation generated from ${name} call-site analysis.`);
  for (const p of params) {
    lines.push(` * @param ${p.name} - Inferred type: ${p.type}${p.default ? ' (optional)' : ''}`);
  }
  if (returnType !== 'void') lines.push(` * @returns ${returnType}`);
  lines.push(' */');

  if (isMethod && className) {
    lines.push(`${prefix}${name}(${paramStr})${ret} {`);
  } else {
    lines.push(`${prefix}function ${name}(${paramStr})${ret} {`);
  }

  lines.push('  // TODO: Replace with actual implementation');
  lines.push('  // Inferred from call-site analysis');

  if (returnType === 'string') {
    lines.push("  return '';");
  } else if (returnType === 'number') {
    lines.push('  return 0;');
  } else if (returnType === 'boolean') {
    lines.push('  return false;');
  } else if (returnType === 'array' || returnType.endsWith('[]')) {
    lines.push('  return [];');
  } else if (returnType === 'object' || returnType.startsWith('{')) {
    lines.push('  return {};');
  } else if (isAsync || returnType.startsWith('Promise')) {
    if (returnType.includes('<')) {
      const inner = returnType.match(/Promise<(.+)>/)?.[1] ?? 'void';
      lines.push(`  return Promise.resolve(undefined as unknown as ${inner});`);
    } else {
      lines.push('  return Promise.resolve();');
    }
  } else if (returnType === 'void') {
    lines.push('  // no return');
  } else {
    lines.push(`  throw new Error('Not implemented: ${name}');`);
  }

  lines.push('}');
  return lines;
}

function buildPyImpl(
  name: string,
  params: Array<{ name: string; type: string; default?: string }>,
  returnType: string,
  isAsync: boolean,
): string[] {
  const lines: string[] = [];
  const prefix = isAsync ? 'async ' : '';
  const paramStr = params
    .map((p) => {
      let pStr = p.name;
      if (p.type && p.type !== 'any') {
        pStr += `: ${pyType(p.type)}`;
      }
      if (p.default) {
        pStr += ` = ${p.default}`;
      }
      return pStr;
    })
    .join(', ');

  const ret = returnType !== 'void' && returnType !== 'None' ? ` -> ${pyType(returnType)}` : '';

  lines.push('"""');
  lines.push(`Implementation generated from ${name} call-site analysis.`);
  lines.push('"""');
  lines.push(`${prefix}def ${name}(${paramStr})${ret}:`);
  lines.push('    # TODO: Replace with actual implementation');
  lines.push('    # Inferred from call-site analysis');

  if (returnType === 'str' || returnType === 'string') {
    lines.push("    return ''");
  } else if (returnType === 'int' || returnType === 'float' || returnType === 'number') {
    lines.push('    return 0');
  } else if (returnType === 'bool' || returnType === 'boolean') {
    lines.push('    return False');
  } else if (returnType === 'list' || returnType === 'array') {
    lines.push('    return []');
  } else if (returnType === 'dict' || returnType === 'object') {
    lines.push('    return {}');
  } else if (returnType === 'None' || returnType === 'void') {
    lines.push('    return None');
  } else {
    lines.push(`    raise NotImplementedError("${name}")`);
  }

  return lines;
}

function pyType(tsType: string): string {
  const map: Record<string, string> = {
    string: 'str',
    number: 'float',
    boolean: 'bool',
    array: 'list',
    object: 'dict',
    void: 'None',
    any: 'Any',
  };
  return map[tsType] ?? tsType;
}

function languageFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
  };
  return map[ext] ?? 'typescript';
}

// ──────────────────────────────────────────────
// Quick-Fix Code Action: "Implement" stub
// ──────────────────────────────────────────────

/**
 * Generate quick-fix code actions for unresolved function calls.
 * Scans call sites and produces "Implement stub" actions for functions
 * that are called but not defined or imported.
 */
export function generateQuickFixes(
  filePath: string,
  source?: string,
): QuickFixAction[] {
  const src = source ?? (existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '');
  if (!src) return [];

  const callSites = scanCallSites(filePath, src);
  const fixes: QuickFixAction[] = [];

  // Find call sites where the callee has unknown origin (not imported, not local)
  const unresolved = callSites.filter((cs) => cs.calleeOrigin === 'unknown');

  for (const cs of unresolved) {
    const fnName = cs.calleeName;
    const typeInfo = inferTypesFromCallSites(fnName, callSites);

    if (typeInfo && typeInfo.confidence > 0) {
      const skeleton = generateStubImplementation(fnName, [cs], filePath);
      if (skeleton) {
        fixes.push({
          id: `fix_${randomUUID().slice(0, 8)}`,
          kind: 'implement-stub',
          title: `Implement stub for "${fnName}"`,
          description: `Generate implementation for ${fnName} based on call-site at line ${cs.line}. ` +
            `Inferred params: ${typeInfo.paramTypes.map((p) => `${p.typeName}`).join(', ') || 'none'}. ` +
            `Return type: ${typeInfo.returnType}.`,
          file: filePath,
          line: cs.line,
          edit: {
            range: { startLine: cs.line, startCol: 1, endLine: cs.line, endCol: 1 },
            replacement: skeleton.implementation + '\n\n',
          },
        });
      }
    }

    // Add-import quick fix if the name looks like it could be from a known module
    const importFix = suggestImportFix(fnName, cs);
    if (importFix) {
      fixes.push(importFix);
    }

    // Add null-check if an arg might be nullable
    if (cs.args.some((a) => a.inferredType === 'null' || a.inferredType === 'undefined')) {
      fixes.push({
        id: `fix_${randomUUID().slice(0, 8)}`,
        kind: 'add-null-check',
        title: `Add null check for "${fnName}" call`,
        description: `Guard call to ${fnName} with a null/undefined check for arguments.`,
        file: filePath,
        line: cs.line,
        edit: {
          range: { startLine: cs.line, startCol: 1, endLine: cs.line, endCol: 1 },
          replacement: `if (${cs.args.filter((a) => a.kind === 'identifier').map((a) => a.raw).join(' && ')}) {\n  ${cs.rawExpression}\n}\n\n`,
        },
      });
    }
  }

  return fixes;
}

/**
 * Heuristic: suggest an import quick-fix if the function name matches
 * common library patterns.
 */
function suggestImportFix(fnName: string, cs: CallSite): QuickFixAction | null {
  const knownModules: Array<{ pattern: RegExp; module: string; name: string }> = [
    { pattern: /^lodash\./, module: 'lodash', name: '_' },
    { pattern: /^lodash\//, module: 'lodash', name: '_' },
    { pattern: /^fs\./, module: 'node:fs', name: 'fs' },
    { pattern: /^path\./, module: 'node:path', name: 'path' },
    { pattern: /^os\./, module: 'node:os', name: 'os' },
    { pattern: /^crypto\./, module: 'node:crypto', name: 'crypto' },
  ];

  for (const km of knownModules) {
    if (km.pattern.test(fnName)) {
      return {
        id: `fix_${randomUUID().slice(0, 8)}`,
        kind: 'add-import',
        title: `Add import for "${km.name}" from "${km.module}"`,
        description: `Import ${km.name} to resolve call to ${fnName}.`,
        file: cs.file,
        line: 1,
        edit: {
          range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
          replacement: `import ${km.name} from '${km.module}';\n`,
        },
      };
    }
  }

  return null;
}

// ──────────────────────────────────────────────
// Batch stub generator — scan entire project
// ──────────────────────────────────────────────

/**
 * Scan a directory for unresolved call sites and generate stub implementations.
 */
export function batchGenerateStubs(
  rootDir: string,
  fileGlob?: string[],
): Map<string, StubSkeleton[]> {
  const { readdirSync, statSync } = require('node:fs');
  const results = new Map<string, StubSkeleton[]>();

  function walk(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        walk(fullPath);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const src = readFileSync(fullPath, 'utf-8');
        const callSites = scanCallSites(fullPath, src);
        const skeletons: StubSkeleton[] = [];

        const unresolved = callSites.filter((cs) => cs.calleeOrigin === 'unknown' || cs.calleeOrigin === 'local');
        const grouped = new Map<string, CallSite[]>();
        for (const cs of unresolved) {
          const key = cs.calleeName;
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key)!.push(cs);
        }

        Array.from(grouped.entries()).forEach(([fnName, sites]) => {
          const skeleton = generateStubImplementation(fnName, sites, fullPath);
          if (skeleton) {
            skeletons.push(skeleton);
          }
        });

        if (skeletons.length > 0) {
          results.set(fullPath, skeletons);
        }
      }
    }
  }

  walk(rootDir);
  return results;
}
