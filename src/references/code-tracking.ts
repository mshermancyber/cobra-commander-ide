import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SymbolDef {
  id: string;
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable' | 'const' | 'export' | 'import';
  file: string;
  line: number;
  column: number;
  signature?: string;
  exported: boolean;
  /** For AI-generated code: the generation batch ID */
  generationBatchId?: string;
  /** Whether this symbol was AI-generated */
  isGenerated: boolean;
}

export interface ReferenceEdge {
  fromSymbolId: string;
  toSymbolId: string;
  kind: 'call' | 'import' | 'extend' | 'implement' | 'type-ref' | 'assign' | 'use' | 'decorate';
  file: string;
  line: number;
  column: number;
  /** For AI-generated references */
  isGenerated: boolean;
  generationBatchId?: string;
}

export interface ReferenceGraph {
  projectRoot: string;
  symbols: SymbolDef[];
  references: ReferenceEdge[];
  filesIndexed: string[];
  builtAt: number;
}

export interface UsageResult {
  symbol: SymbolDef;
  usedBy: SymbolDef[];       // symbols that reference this one
  uses: SymbolDef[];         // symbols this one references
  fileCount: number;         // files where this symbol is used
  isOrphan: boolean;         // defined but never used
}

export interface ImpactAnalysis {
  symbolId: string;
  symbolName: string;
  /** Direct dependents (immediate references) */
  directDependents: SymbolDef[];
  /** Transitive dependents (entire cascade) */
  transitiveDependents: SymbolDef[];
  /** Files that would need updating */
  affectedFiles: string[];
  /** Estimated code impact */
  estimatedImpact: 'none' | 'low' | 'medium' | 'high' | 'critical';
  /** Risk factors */
  riskFactors: string[];
}

export interface ReferenceIntegrityCheck {
  passed: boolean;
  violations: IntegrityViolation[];
  summary: {
    totalSymbols: number;
    totalReferences: number;
    brokenReferences: number;
    orphanSymbols: number;
    duplicateDefinitions: number;
  };
}

export interface IntegrityViolation {
  type: 'broken-reference' | 'orphan-symbol' | 'duplicate-definition' | 'missing-export' | 'circular-dependency';
  severity: 'error' | 'warning' | 'info';
  description: string;
  location: string;
  symbolIds: string[];
  suggestion?: string;
}

export interface CodeTrackingConfig {
  storageDir?: string;
  projectRoot?: string;
  /** File extensions to track */
  extensions?: string[];
  /** Directories to exclude */
  excludeDirs?: string[];
  /** Maximum files to index */
  maxFiles?: number;
}

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs',
  '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt',
]);

const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.cobra-commander', '__pycache__', '.next', 'target', 'vendor',
]);

// ─── ReferenceGraphBuilder ─────────────────────────────────────────────────

export class ReferenceGraphBuilder {
  private symbols: SymbolDef[] = [];
  private references: ReferenceEdge[] = [];
  private filesIndexed: string[] = [];
  private projectRoot: string;
  private symbolMap: Map<string, SymbolDef> = new Map();     // id -> symbol
  private nameIndex: Map<string, SymbolDef[]> = new Map();   // name -> symbols
  private fileIndex: Map<string, SymbolDef[]> = new Map();   // file -> symbols
  private refFromIndex: Map<string, ReferenceEdge[]> = new Map(); // fromId -> refs
  private refToIndex: Map<string, ReferenceEdge[]> = new Map();   // toId -> refs

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  /**
   * Add a symbol definition to the graph.
   */
  addSymbol(symbol: Omit<SymbolDef, 'id'> & { id?: string }): SymbolDef {
    const id = symbol.id || `${symbol.file}:${symbol.line}:${symbol.name}`;

    // Check for duplicate
    const existing = this.symbolMap.get(id);
    if (existing) {
      // Update existing
      existing.signature = symbol.signature || existing.signature;
      existing.isGenerated = symbol.isGenerated || existing.isGenerated;
      return existing;
    }

    const def: SymbolDef = { ...symbol, id };
    this.symbols.push(def);
    this.symbolMap.set(id, def);

    // Update name index
    const byName = this.nameIndex.get(def.name) || [];
    byName.push(def);
    this.nameIndex.set(def.name, byName);

    // Update file index
    const byFile = this.fileIndex.get(def.file) || [];
    byFile.push(def);
    this.fileIndex.set(def.file, byFile);

    return def;
  }

  /**
   * Add a reference edge between two symbols.
   */
  addReference(ref: Omit<ReferenceEdge, 'id'>): ReferenceEdge {
    const edge: ReferenceEdge = { ...ref };

    // Avoid duplicates
    const existing = this.references.find(
      r => r.fromSymbolId === edge.fromSymbolId &&
           r.toSymbolId === edge.toSymbolId &&
           r.kind === edge.kind
    );
    if (existing) {
      existing.isGenerated = edge.isGenerated || existing.isGenerated;
      return existing;
    }

    this.references.push(edge);

    // Update reverse indices
    const fromRefs = this.refFromIndex.get(edge.fromSymbolId) || [];
    fromRefs.push(edge);
    this.refFromIndex.set(edge.fromSymbolId, fromRefs);

    const toRefs = this.refToIndex.get(edge.toSymbolId) || [];
    toRefs.push(edge);
    this.refToIndex.set(edge.toSymbolId, toRefs);

    return edge;
  }

  /**
   * Parse a file and extract symbol definitions and references.
   */
  indexFile(filePath: string): { symbols: number; references: number } {
    const absPath = resolve(this.projectRoot, filePath);
    if (!existsSync(absPath)) return { symbols: 0, references: 0 };

    const relPath = relative(this.projectRoot, absPath);
    this.filesIndexed.push(relPath);

    let symbolsAdded = 0;
    let refsAdded = 0;

    try {
      const content = readFileSync(absPath, 'utf-8');
      const lines = content.split('\n');
      const ext = extname(relPath);

      // Extract symbols based on language
      const langSymbols = this.extractSymbols(relPath, lines, ext);
      for (const sym of langSymbols) {
        this.addSymbol({ ...sym, isGenerated: false });
        symbolsAdded++;
      }

      // Extract references (calls, imports, etc.)
      const langRefs = this.extractReferences(relPath, lines, ext, langSymbols);
      for (const ref of langRefs) {
        this.addReference({ ...ref, isGenerated: false });
        refsAdded++;
      }
    } catch {
      // Skip unreadable files
    }

    return { symbols: symbolsAdded, references: refsAdded };
  }

  /**
   * Build the final reference graph.
   */
  build(): ReferenceGraph {
    return {
      projectRoot: this.projectRoot,
      symbols: [...this.symbols],
      references: [...this.references],
      filesIndexed: [...this.filesIndexed],
      builtAt: Date.now(),
    };
  }

  /**
   * Register AI-generated code symbols and their references.
   * Associates them with a generation batch for auditability.
   */
  registerGeneratedCode(
    batchId: string,
    symbols: Array<Omit<SymbolDef, 'id' | 'isGenerated' | 'generationBatchId'>>,
    references?: Array<Omit<ReferenceEdge, 'isGenerated' | 'generationBatchId'>>,
  ): { symbolIds: string[]; referenceCount: number } {
    const symbolIds: string[] = [];

    for (const sym of symbols) {
      const def = this.addSymbol({
        ...sym,
        isGenerated: true,
        generationBatchId: batchId,
      });
      symbolIds.push(def.id);
    }

    let refCount = 0;
    if (references) {
      for (const ref of references) {
        this.addReference({
          ...ref,
          isGenerated: true,
          generationBatchId: batchId,
        });
        refCount++;
      }
    }

    return { symbolIds, referenceCount: refCount };
  }

  /**
   * Clear all generated code from a specific batch.
   */
  removeGeneratedBatch(batchId: string): { symbolsRemoved: number; referencesRemoved: number } {
    const removedSymbolIds = new Set<string>();

    // Remove symbols
    const symbolsBefore = this.symbols.length;
    this.symbols = this.symbols.filter(s => {
      if (s.generationBatchId === batchId) {
        removedSymbolIds.add(s.id);
        this.symbolMap.delete(s.id);
        // Clean name index
        const byName = this.nameIndex.get(s.name);
        if (byName) {
          this.nameIndex.set(s.name, byName.filter(e => e.id !== s.id));
        }
        // Clean file index
        const byFile = this.fileIndex.get(s.file);
        if (byFile) {
          this.fileIndex.set(s.file, byFile.filter(e => e.id !== s.id));
        }
        return false;
      }
      return true;
    });

    // Remove references
    const refsBefore = this.references.length;
    this.references = this.references.filter(r => {
      if (r.generationBatchId === batchId) {
        // Clean reverse indices
        const fromRefs = this.refFromIndex.get(r.fromSymbolId) || [];
        this.refFromIndex.set(r.fromSymbolId, fromRefs.filter(e => !removedSymbolIds.has(e.toSymbolId)));
        const toRefs = this.refToIndex.get(r.toSymbolId) || [];
        this.refToIndex.set(r.toSymbolId, toRefs.filter(e => !removedSymbolIds.has(e.fromSymbolId)));
        return false;
      }
      return true;
    });

    return {
      symbolsRemoved: symbolsBefore - this.symbols.length,
      referencesRemoved: refsBefore - this.references.length,
    };
  }

  // ─── Private extraction logic ─────────────────────────────────────────

  private extractSymbols(
    file: string,
    lines: string[],
    ext: string,
  ): Array<Omit<SymbolDef, 'id' | 'isGenerated'>> {
    const symbols: Array<Omit<SymbolDef, 'id' | 'isGenerated'>> = [];

    const content = lines.join('\n');

    // TypeScript/JavaScript patterns
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      // Functions
      const funcRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
      let match;
      while ((match = funcRe.exec(content)) !== null) {
        const line = (content.slice(0, match.index).match(/\n/g) || []).length + 1;
        symbols.push({
          name: match[1],
          kind: 'function',
          file,
          line,
          column: match.index - content.lastIndexOf('\n', match.index),
          signature: `function ${match[1]}(${match[2]})`,
          exported: match[0].startsWith('export'),
        });
      }

      // Classes
      const classRe = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
      while ((match = classRe.exec(content)) !== null) {
        const line = (content.slice(0, match.index).match(/\n/g) || []).length + 1;
        symbols.push({
          name: match[1],
          kind: 'class',
          file,
          line,
          column: match.index - content.lastIndexOf('\n', match.index),
          signature: `class ${match[1]}`,
          exported: match[0].startsWith('export'),
        });
      }

      // Interfaces
      const ifaceRe = /(?:export\s+)?interface\s+(\w+)/g;
      while ((match = ifaceRe.exec(content)) !== null) {
        const line = (content.slice(0, match.index).match(/\n/g) || []).length + 1;
        symbols.push({
          name: match[1],
          kind: 'interface',
          file,
          line,
          column: match.index - content.lastIndexOf('\n', match.index),
          signature: `interface ${match[1]}`,
          exported: match[0].startsWith('export'),
        });
      }

      // Type aliases
      const typeRe = /(?:export\s+)?type\s+(\w+)\s*=/g;
      while ((match = typeRe.exec(content)) !== null) {
        const line = (content.slice(0, match.index).match(/\n/g) || []).length + 1;
        symbols.push({
          name: match[1],
          kind: 'type',
          file,
          line,
          column: match.index - content.lastIndexOf('\n', match.index),
          signature: `type ${match[1]}`,
          exported: match[0].startsWith('export'),
        });
      }

      // Enums
      const enumRe = /(?:export\s+)?enum\s+(\w+)/g;
      while ((match = enumRe.exec(content)) !== null) {
        const line = (content.slice(0, match.index).match(/\n/g) || []).length + 1;
        symbols.push({
          name: match[1],
          kind: 'enum',
          file,
          line,
          column: match.index - content.lastIndexOf('\n', match.index),
          signature: `enum ${match[1]}`,
          exported: match[0].startsWith('export'),
        });
      }

      // Arrow functions assigned to const/let
      const arrowRe = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^{]+)?\s*=>/g;
      while ((match = arrowRe.exec(content)) !== null) {
        const line = (content.slice(0, match.index).match(/\n/g) || []).length + 1;
        symbols.push({
          name: match[1],
          kind: 'function',
          file,
          line,
          column: match.index - content.lastIndexOf('\n', match.index),
          signature: `const ${match[1]} = (...) =>`,
          exported: match[0].startsWith('export'),
        });
      }
    }

    // Python patterns
    if (ext === '.py') {
      const clsRe = /class\s+(\w+)/g;
      let match;
      while ((match = clsRe.exec(content)) !== null) {
        const line = (content.slice(0, match.index).match(/\n/g) || []).length + 1;
        symbols.push({
          name: match[1],
          kind: 'class',
          file,
          line,
          column: match.index - content.lastIndexOf('\n', match.index),
          signature: `class ${match[1]}`,
          exported: true, // Python classes are exportable by default
        });
      }

      const funcRe = /(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/g;
      while ((match = funcRe.exec(content)) !== null) {
        const line = (content.slice(0, match.index).match(/\n/g) || []).length + 1;
        symbols.push({
          name: match[1],
          kind: 'function',
          file,
          line,
          column: match.index - content.lastIndexOf('\n', match.index),
          signature: `def ${match[1]}(${match[2]})`,
          exported: !match[1].startsWith('_'),
        });
      }
    }

    return symbols;
  }

  private extractReferences(
    file: string,
    lines: string[],
    ext: string,
    fileSymbols: Array<Omit<SymbolDef, 'id' | 'isGenerated'>>,
  ): Array<Omit<ReferenceEdge, 'isGenerated'>> {
    const refs: Array<Omit<ReferenceEdge, 'isGenerated'>> = [];
    const content = lines.join('\n');
    const fileSymbolMap = new Map(fileSymbols.map(s => [s.name, s]));

    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      // Capture calls to known symbols
      for (const [name, sym] of fileSymbolMap) {
        const callRe = new RegExp(`\\b${this.escapeRegExp(name)}\\s*\\(`, 'g');
        let match;
        while ((match = callRe.exec(content)) !== null) {
          const line = (content.slice(0, match.index).match(/\n/g) || []).length + 1;
          // Don't match the definition line itself
          if (line !== sym.line) {
            refs.push({
              fromSymbolId: `${file}:${line}:caller`,
              toSymbolId: `${sym.file}:${sym.line}:${sym.name}`,
              kind: 'call',
              file,
              line,
              column: match.index - content.lastIndexOf('\n', match.index),
            });
          }
        }

        // Capture imports
        const importRe = new RegExp(`import\\s+.*\\b${this.escapeRegExp(name)}\\b`, 'g');
        while ((match = importRe.exec(content)) !== null) {
          const line = (content.slice(0, match.index).match(/\n/g) || []).length + 1;
          refs.push({
            fromSymbolId: `${file}:${line}:import`,
            toSymbolId: `${sym.file}:${sym.line}:${sym.name}`,
            kind: 'import',
            file,
            line,
            column: match.index - content.lastIndexOf('\n', match.index),
          });
        }
      }
    }

    return refs;
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// ─── Find Usages ───────────────────────────────────────────────────────────

export function findUsages(
  graph: ReferenceGraph,
  symbolName: string,
  options?: {
    file?: string;
    kind?: SymbolDef['kind'];
    includeGenerated?: boolean;
  },
): UsageResult[] {
  const results: UsageResult[] = [];

  let candidates = graph.symbols.filter(s => s.name === symbolName);
  if (options?.file) {
    candidates = candidates.filter(s => s.file === options.file);
  }
  if (options?.kind) {
    candidates = candidates.filter(s => s.kind === options.kind);
  }
  if (options?.includeGenerated === false) {
    candidates = candidates.filter(s => !s.isGenerated);
  }

  for (const sym of candidates) {
    // Who uses this symbol?
    const incomingRefs = graph.references.filter(r => r.toSymbolId === sym.id);
    const usedBy = incomingRefs
      .map(r => graph.symbols.find(s => s.id === r.fromSymbolId))
      .filter(Boolean) as SymbolDef[];

    // What does this symbol use?
    const outgoingRefs = graph.references.filter(r => r.fromSymbolId === sym.id);
    const uses = outgoingRefs
      .map(r => graph.symbols.find(s => s.id === r.toSymbolId))
      .filter(Boolean) as SymbolDef[];

    const fileSet = new Set(usedBy.map(s => s.file));

    results.push({
      symbol: sym,
      usedBy,
      uses,
      fileCount: fileSet.size,
      isOrphan: usedBy.length === 0 && !sym.exported,
    });
  }

  return results;
}

/**
 * Find all usages of symbols defined in AI-generated code.
 */
export function findGeneratedUsages(
  graph: ReferenceGraph,
  batchId?: string,
): UsageResult[] {
  const generatedSymbols = batchId
    ? graph.symbols.filter(s => s.generationBatchId === batchId && s.isGenerated)
    : graph.symbols.filter(s => s.isGenerated);

  const results: UsageResult[] = [];

  for (const sym of generatedSymbols) {
    const incomingRefs = graph.references.filter(r => r.toSymbolId === sym.id);
    const usedBy = incomingRefs
      .map(r => graph.symbols.find(s => s.id === r.fromSymbolId))
      .filter(Boolean) as SymbolDef[];

    const outgoingRefs = graph.references.filter(r => r.fromSymbolId === sym.id);
    const uses = outgoingRefs
      .map(r => graph.symbols.find(s => s.id === r.toSymbolId))
      .filter(Boolean) as SymbolDef[];

    results.push({
      symbol: sym,
      usedBy,
      uses,
      fileCount: new Set(usedBy.map(s => s.file)).size,
      isOrphan: usedBy.length === 0,
    });
  }

  return results;
}

// ─── Impact Analysis ───────────────────────────────────────────────────────

export function analyzeImpact(
  graph: ReferenceGraph,
  symbolName: string,
  options?: {
    file?: string;
    maxDepth?: number;
  },
): ImpactAnalysis[] {
  const maxDepth = options?.maxDepth ?? 10;
  const targets = graph.symbols.filter(s =>
    s.name === symbolName && (!options?.file || s.file === options.file)
  );

  const results: ImpactAnalysis[] = [];

  for (const target of targets) {
    const directDependents = new Map<string, SymbolDef>();
    const visited = new Set<string>();

    // BFS to find transitive dependents
    const queue: Array<{ symbolId: string; depth: number }> = [{ symbolId: target.id, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.symbolId) || current.depth > maxDepth) continue;
      visited.add(current.symbolId);

      const refs = graph.references.filter(r => r.toSymbolId === current.symbolId);
      for (const ref of refs) {
        const dependent = graph.symbols.find(s => s.id === ref.fromSymbolId);
        if (dependent && !visited.has(dependent.id)) {
          if (current.depth === 0) {
            directDependents.set(dependent.id, dependent);
          }
          queue.push({ symbolId: dependent.id, depth: current.depth + 1 });
        }
      }
    }

    // Remove the target itself
    visited.delete(target.id);
    directDependents.delete(target.id);

    const transitiveDependents = [...visited]
      .map(id => graph.symbols.find(s => s.id === id))
      .filter(Boolean) as SymbolDef[];

    const affectedFiles = [...new Set(transitiveDependents.map(d => d.file))];

    // Estimate impact
    const fileCount = affectedFiles.length;
    const depCount = transitiveDependents.length;
    let estimatedImpact: ImpactAnalysis['estimatedImpact'] = 'none';
    if (depCount === 0) estimatedImpact = 'none';
    else if (fileCount === 1 && depCount <= 3) estimatedImpact = 'low';
    else if (fileCount <= 3 && depCount <= 10) estimatedImpact = 'medium';
    else if (fileCount <= 10 && depCount <= 50) estimatedImpact = 'high';
    else estimatedImpact = 'critical';

    // Risk factors
    const riskFactors: string[] = [];
    if (target.exported) riskFactors.push('Exported symbol — external consumers may be affected');
    if (transitiveDependents.some(d => d.isGenerated)) riskFactors.push('AI-generated code depends on this symbol');
    if (fileCount > 5) riskFactors.push(`Wide blast radius: ${fileCount} files affected`);
    if (depCount > 20) riskFactors.push(`High coupling: ${depCount} dependents`);
    if (target.kind === 'interface' || target.kind === 'type') riskFactors.push('Type/interface change — may cause cascading type errors');

    results.push({
      symbolId: target.id,
      symbolName: target.name,
      directDependents: [...directDependents.values()],
      transitiveDependents,
      affectedFiles,
      estimatedImpact,
      riskFactors,
    });
  }

  return results;
}

/**
 * Quick impact check — returns summary without full analysis.
 */
export function quickImpactCheck(graph: ReferenceGraph, symbolName: string): {
  found: boolean;
  dependentCount: number;
  fileCount: number;
  isExported: boolean;
} {
  const targets = graph.symbols.filter(s => s.name === symbolName);
  if (targets.length === 0) return { found: false, dependentCount: 0, fileCount: 0, isExported: false };

  const dependentSet = new Set<string>();
  const fileSet = new Set<string>();
  let exported = false;

  for (const target of targets) {
    if (target.exported) exported = true;
    const refs = graph.references.filter(r => r.toSymbolId === target.id);
    for (const ref of refs) {
      dependentSet.add(ref.fromSymbolId);
      fileSet.add(ref.file);
    }
  }

  return {
    found: true,
    dependentCount: dependentSet.size,
    fileCount: fileSet.size,
    isExported: exported,
  };
}

// ─── Reference Integrity Check ─────────────────────────────────────────────

export function checkReferenceIntegrity(graph: ReferenceGraph): ReferenceIntegrityCheck {
  const violations: IntegrityViolation[] = [];

  // Check for broken references (toId not in symbols)
  const symbolIds = new Set(graph.symbols.map(s => s.id));
  const brokenRefs: ReferenceEdge[] = [];

  for (const ref of graph.references) {
    if (!symbolIds.has(ref.toSymbolId)) {
      brokenRefs.push(ref);
      violations.push({
        type: 'broken-reference',
        severity: 'error',
        description: `Reference to non-existent symbol: ${ref.toSymbolId}`,
        location: `${ref.file}:${ref.line}`,
        symbolIds: [ref.fromSymbolId, ref.toSymbolId],
        suggestion: ref.isGenerated
          ? 'Remove or regenerate the AI-generated reference'
          : 'Update the reference or add the missing import',
      });
    }
    if (!symbolIds.has(ref.fromSymbolId)) {
      // fromSymbolId for calls might be synthetic (e.g., `${file}:${line}:caller`)
      // Only flag if it looks like a real symbol ID
      if (ref.fromSymbolId.includes(':') && !ref.fromSymbolId.endsWith(':caller') && !ref.fromSymbolId.endsWith(':import')) {
        violations.push({
          type: 'broken-reference',
          severity: 'warning',
          description: `Reference from non-existent symbol: ${ref.fromSymbolId}`,
          location: `${ref.file}:${ref.line}`,
          symbolIds: [ref.fromSymbolId, ref.toSymbolId],
          suggestion: 'The referencing symbol may have been deleted',
        });
      }
    }
  }

  // Check for orphan symbols (defined but never used)
  const referencedTo = new Set(graph.references.map(r => r.toSymbolId));
  const referencedFrom = new Set(graph.references.map(r => r.fromSymbolId));

  for (const sym of graph.symbols) {
    if (!referencedTo.has(sym.id) && !referencedFrom.has(sym.id)) {
      violations.push({
        type: 'orphan-symbol',
        severity: 'warning',
        description: `Symbol '${sym.name}' is defined but never referenced`,
        location: `${sym.file}:${sym.line}`,
        symbolIds: [sym.id],
        suggestion: sym.isGenerated
          ? 'Consider removing unused AI-generated code'
          : 'Consider removing or exporting the unused symbol',
      });
    }
  }

  // Check for duplicate definitions (same name, same file, different lines)
  const nameFileMap = new Map<string, SymbolDef[]>();
  for (const sym of graph.symbols) {
    const key = `${sym.file}:${sym.name}`;
    const group = nameFileMap.get(key) || [];
    group.push(sym);
    nameFileMap.set(key, group);
  }

  for (const [key, syms] of nameFileMap) {
    if (syms.length > 1) {
      violations.push({
        type: 'duplicate-definition',
        severity: 'error',
        description: `Duplicate definition of '${syms[0].name}' in ${syms[0].file}`,
        location: syms.map(s => `${s.file}:${s.line}`).join(', '),
        symbolIds: syms.map(s => s.id),
        suggestion: 'Remove duplicate definitions or rename one of the conflicting symbols',
      });
    }
  }

  // Check for missing exports (symbols referenced from other files but not exported)
  for (const ref of graph.references) {
    const toSym = graph.symbols.find(s => s.id === ref.toSymbolId);
    const fromSym = graph.symbols.find(s => s.id === ref.fromSymbolId);
    if (toSym && fromSym && toSym.file !== fromSym.file && !toSym.exported) {
      // Check if we already reported this
      const alreadyReported = violations.some(v =>
        v.type === 'missing-export' && v.symbolIds.includes(toSym.id)
      );
      if (!alreadyReported) {
        violations.push({
          type: 'missing-export',
          severity: 'error',
          description: `Symbol '${toSym.name}' is used across files but not exported`,
          location: `${toSym.file}:${toSym.line}`,
          symbolIds: [toSym.id, fromSym.id],
          suggestion: `Add 'export' to the definition of '${toSym.name}'`,
        });
      }
    }
  }

  // Check for circular dependencies (simplified cycle detection)
  const circularPaths = detectCircularDeps(graph);
  for (const cycle of circularPaths) {
    violations.push({
      type: 'circular-dependency',
      severity: 'warning',
      description: `Circular dependency detected: ${cycle.join(' → ')}`,
      location: cycle.join(', '),
      symbolIds: [],
      suggestion: 'Refactor to break the circular dependency',
    });
  }

  const brokenCount = violations.filter(v => v.type === 'broken-reference').length;
  const orphanCount = violations.filter(v => v.type === 'orphan-symbol').length;
  const dupCount = violations.filter(v => v.type === 'duplicate-definition').length;

  return {
    passed: violations.every(v => v.severity !== 'error'),
    violations,
    summary: {
      totalSymbols: graph.symbols.length,
      totalReferences: graph.references.length,
      brokenReferences: brokenCount,
      orphanSymbols: orphanCount,
      duplicateDefinitions: dupCount,
    },
  };
}

/**
 * Validate AI-generated code references before commit.
 * Returns true if generated code passes integrity checks.
 */
export function validateGeneratedCode(
  graph: ReferenceGraph,
  batchId?: string,
): { passed: boolean; issues: IntegrityViolation[] } {
  const fullCheck = checkReferenceIntegrity(graph);

  // Filter to only issues involving generated code
  const genIssues = batchId
    ? fullCheck.violations.filter(v =>
        v.symbolIds.some(id => {
          const sym = graph.symbols.find(s => s.id === id);
          return sym?.generationBatchId === batchId;
        })
      )
    : fullCheck.violations.filter(v =>
        v.symbolIds.some(id => {
          const sym = graph.symbols.find(s => s.id === id);
          return sym?.isGenerated;
        })
      );

  return {
    passed: genIssues.every(v => v.severity !== 'error'),
    issues: genIssues,
  };
}

// ─── Helper: Circular Dependency Detection ─────────────────────────────────

function detectCircularDeps(graph: ReferenceGraph, maxDepth: number = 20): string[][] {
  const cycles: string[][] = [];

  for (const sym of graph.symbols) {
    const visited = new Set<string>();
    const path: string[] = [];

    function dfs(currentId: string): boolean {
      if (visited.has(currentId)) {
        const cycleStart = path.indexOf(currentId);
        if (cycleStart >= 0 && path.length - cycleStart > 1) {
          cycles.push([...path.slice(cycleStart), currentId]);
          return true;
        }
        return false;
      }

      visited.add(currentId);
      path.push(currentId);

      const outgoingRefs = graph.references.filter(r => r.fromSymbolId === currentId);
      for (const ref of outgoingRefs) {
        if (dfs(ref.toSymbolId)) return true;
      }

      path.pop();
      visited.delete(currentId);
      return false;
    }

    if (dfs(sym.id)) break; // Found a cycle, stop searching
  }

  return cycles;
}

// ─── Persistence ───────────────────────────────────────────────────────────

export function saveReferenceGraph(graph: ReferenceGraph, outputPath: string): void {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(graph, null, 2), 'utf-8');
}

export function loadReferenceGraph(filePath: string): ReferenceGraph | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as ReferenceGraph;
  } catch {
    return null;
  }
}

// ─── Convenience Functions ─────────────────────────────────────────────────

/**
 * Build a reference graph for a project directory.
 */
export function buildReferenceGraph(projectRoot: string, files?: string[]): ReferenceGraph {
  const builder = new ReferenceGraphBuilder(projectRoot);

  const absRoot = resolve(projectRoot);
  if (files) {
    for (const file of files) {
      builder.indexFile(relative(absRoot, resolve(absRoot, file)));
    }
  } else {
    // Walk the directory
    const { readdirSync, statSync } = require('node:fs');
    function walk(dir: string) {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.name.startsWith('.') || DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (DEFAULT_EXTENSIONS.has(extname(entry.name))) {
            builder.indexFile(relative(absRoot, fullPath));
          }
        }
      } catch { /* skip */ }
    }
    walk(absRoot);
  }

  return builder.build();
}
