import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join, basename, extname, dirname } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DeadCodeResult {
  /** The file analyzed */
  file: string;
  /** Type of dead code found */
  type: DeadCodeType;
  /** The symbol name */
  name: string;
  /** Line number */
  line: number;
  /** The dead code snippet */
  snippet: string;
  /** Why it's considered dead */
  reason: string;
  /** Severity */
  severity: 'low' | 'medium' | 'high';
}

export type DeadCodeType =
  | 'unused-import'
  | 'unused-variable'
  | 'unused-function'
  | 'unused-export'
  | 'unreachable-code'
  | 'unused-type'
  | 'unused-interface'
  | 'dead-dependency'
  | 'commented-out-code'
  | 'duplicate-export';

export interface DeadCodeReport {
  /** All dead code findings */
  results: DeadCodeResult[];
  /** Grouped by file */
  byFile: Record<string, DeadCodeResult[]>;
  /** Grouped by type */
  byType: Record<string, DeadCodeResult[]>;
  /** Total dead code items found */
  totalCount: number;
  /** Estimated lines that could be removed */
  removableLines: number;
  /** Summary text */
  summary: string;
}

export interface DeadCodeConfig {
  /** Root directory to scan */
  workDir: string;
  /** Files/patterns to include */
  include?: string[];
  /** Files/patterns to exclude */
  exclude?: string[];
  /** Whether to check for unused exports across the project */
  crossFileAnalysis?: boolean;
  /** Whether to detect commented-out code */
  detectCommentedCode?: boolean;
  /** Max files to analyze */
  maxFiles?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DeadCodeConfig = {
  workDir: process.cwd(),
  include: ['src/**/*.ts', 'src/**/*.js'],
  exclude: ['node_modules', 'dist', '.git', '*.test.ts', '*.spec.ts'],
  crossFileAnalysis: true,
  detectCommentedCode: true,
  maxFiles: 500,
};

// ─── Core Detector ───────────────────────────────────────────────────────────

export class DeadCodeDetector {
  private config: DeadCodeConfig;

  constructor(config: DeadCodeConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * Analyze a single file for dead code.
   */
  analyzeFile(filePath: string): DeadCodeResult[] {
    const fullPath = resolve(this.config.workDir, filePath);
    if (!existsSync(fullPath)) return [];

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch {
      return [];
    }

    const results: DeadCodeResult[] = [];
    const lines = content.split('\n');

    // Detect unused imports
    results.push(...this.detectUnusedImports(content, lines, filePath));

    // Detect unused variables
    results.push(...this.detectUnusedVariables(content, lines, filePath));

    // Detect unused functions
    results.push(...this.detectUnusedFunctions(content, lines, filePath));

    // Detect unreachable code
    results.push(...this.detectUnreachableCode(content, lines, filePath));

    // Detect commented-out code
    if (this.config.detectCommentedCode) {
      results.push(...this.detectCommentedCode(content, lines, filePath));
    }

    return results;
  }

  /**
   * Analyze the entire project for dead code.
   */
  analyzeProject(): DeadCodeReport {
    const files = this.discoverFiles();
    const allResults: DeadCodeResult[] = [];

    for (const file of files.slice(0, this.config.maxFiles)) {
      const fileResults = this.analyzeFile(file);
      allResults.push(...fileResults);
    }

    // Cross-file analysis: find unused exports
    if (this.config.crossFileAnalysis) {
      allResults.push(...this.detectUnusedExports(files));
    }

    // Group results
    const byFile: Record<string, DeadCodeResult[]> = {};
    const byType: Record<string, DeadCodeResult[]> = {};

    for (const result of allResults) {
      if (!byFile[result.file]) byFile[result.file] = [];
      byFile[result.file].push(result);

      if (!byType[result.type]) byType[result.type] = [];
      byType[result.type].push(result);
    }

    const removableLines = allResults
      .filter(r => r.severity !== 'low')
      .reduce((sum, r) => sum + r.snippet.split('\n').length, 0);

    return {
      results: allResults,
      byFile,
      byType,
      totalCount: allResults.length,
      removableLines,
      summary: this.buildSummary(allResults, byType, removableLines),
    };
  }

  /**
   * Suggest specific code removals with line references.
   */
  suggestRemovals(): Array<{ file: string; lines: string; reason: string }> {
    const report = this.analyzeProject();
    const suggestions: Array<{ file: string; lines: string; reason: string }> = [];

    for (const result of report.results) {
      if (result.severity === 'high') {
        suggestions.push({
          file: result.file,
          lines: `Line ${result.line}: ${result.snippet.slice(0, 100)}`,
          reason: result.reason,
        });
      }
    }

    return suggestions;
  }

  // ── Detection Methods ───────────────────────────────────────────────────

  private detectUnusedImports(content: string, lines: string[], filePath: string): DeadCodeResult[] {
    const results: DeadCodeResult[] = [];
    const importPattern = /^import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*(?:from\s+['"][^'"]+['"])?\s*;?$/gm;

    let match;
    while ((match = importPattern.exec(content)) !== null) {
      const importStmt = match[0];
      const lineNum = content.slice(0, match.index).split('\n').length;

      // Extract imported symbols
      const namedMatch = importStmt.match(/import\s+\{([^}]+)\}/);
      if (namedMatch) {
        const symbols = namedMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim());
        const restOfFile = content.slice((match.index || 0) + importStmt.length);

        for (const sym of symbols) {
          if (sym && sym !== 'type' && !restOfFile.includes(sym)) {
            results.push({
              file: filePath,
              type: 'unused-import',
              name: sym,
              line: lineNum,
              snippet: importStmt.slice(0, 120),
              reason: `Imported symbol "${sym}" is never used in this file`,
              severity: 'low',
            });
          }
        }
      }

      // Check default imports
      const defaultMatch = importStmt.match(/import\s+(\w+)\s+from/);
      if (defaultMatch) {
        const sym = defaultMatch[1];
        const restOfFile = content.slice((match.index || 0) + importStmt.length);
        if (!restOfFile.includes(sym)) {
          results.push({
            file: filePath,
            type: 'unused-import',
            name: sym,
            line: lineNum,
            snippet: importStmt.slice(0, 120),
            reason: `Default import "${sym}" is never used in this file`,
            severity: 'low',
          });
        }
      }

      // Check namespace imports
      const nsMatch = importStmt.match(/import\s+\*\s+as\s+(\w+)/);
      if (nsMatch) {
        const sym = nsMatch[1];
        const restOfFile = content.slice((match.index || 0) + importStmt.length);
        if (!restOfFile.includes(sym)) {
          results.push({
            file: filePath,
            type: 'unused-import',
            name: sym,
            line: lineNum,
            snippet: importStmt.slice(0, 120),
            reason: `Namespace import "${sym}" is never used in this file`,
            severity: 'low',
          });
        }
      }
    }

    return results;
  }

  private detectUnusedVariables(content: string, lines: string[], filePath: string): DeadCodeResult[] {
    const results: DeadCodeResult[] = [];

    // Find const/let/var declarations not at module level
    const varPattern = /(?:const|let|var)\s+(\w+)\s*=/g;
    let match;

    while ((match = varPattern.exec(content)) !== null) {
      const varName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;
      const afterDecl = content.slice((match.index || 0) + match[0].length);

      // Check if variable is used after declaration (within same scope)
      // Simple heuristic: if name appears only once (the declaration itself)
      const namePattern = new RegExp(`\\b${varName}\\b`, 'g');
      const allMatches = [...content.matchAll(namePattern)];

      if (allMatches.length <= 1) {
        results.push({
          file: filePath,
          type: 'unused-variable',
          name: varName,
          line: lineNum,
          snippet: lines[lineNum - 1]?.trim().slice(0, 120) || match[0],
          reason: `Variable "${varName}" is declared but never used`,
          severity: 'medium',
        });
      }
    }

    return results;
  }

  private detectUnusedFunctions(content: string, lines: string[], filePath: string): DeadCodeResult[] {
    const results: DeadCodeResult[] = [];

    // Find function declarations
    const funcPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
    let match;

    while ((match = funcPattern.exec(content)) !== null) {
      const funcName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;
      const afterFunc = content.slice((match.index || 0) + match[0].length);

      // Check if exported
      const isExported = match[0].startsWith('export');

      // For non-exported functions, check if called elsewhere in file
      if (!isExported) {
        const callPattern = new RegExp(`\\b${funcName}\\s*\\(`, 'g');
        const calls = [...afterFunc.matchAll(callPattern)];
        if (calls.length === 0) {
          results.push({
            file: filePath,
            type: 'unused-function',
            name: funcName,
            line: lineNum,
            snippet: lines[lineNum - 1]?.trim().slice(0, 120) || match[0],
            reason: `Function "${funcName}" is defined but never called in this file`,
            severity: 'medium',
          });
        }
      }
    }

    // Find arrow function assignments
    const arrowPattern = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/g;
    while ((match = arrowPattern.exec(content)) !== null) {
      const funcName = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;
      const afterFunc = content.slice((match.index || 0) + match[0].length);

      const callPattern = new RegExp(`\\b${funcName}\\s*\\(`, 'g');
      const calls = [...afterFunc.matchAll(callPattern)];
      if (calls.length === 0) {
        // Check if it's not referenced at all
        const refPattern = new RegExp(`\\b${funcName}\\b`, 'g');
        const allRefs = [...content.matchAll(refPattern)];
        if (allRefs.length <= 1) {
          results.push({
            file: filePath,
            type: 'unused-function',
            name: funcName,
            line: lineNum,
            snippet: lines[lineNum - 1]?.trim().slice(0, 120) || match[0],
            reason: `Arrow function "${funcName}" is defined but never used`,
            severity: 'medium',
          });
        }
      }
    }

    return results;
  }

  private detectUnreachableCode(content: string, lines: string[], filePath: string): DeadCodeResult[] {
    const results: DeadCodeResult[] = [];

    // Code after return/throw/break/continue
    const unreachablePattern = /(?:return|throw|break|continue)\s*[^;{]*;\s*\n\s*(?!case|default|finally|catch|\})(?=\w)/gm;
    let match;

    while ((match = unreachablePattern.exec(content)) !== null) {
      const lineNum = content.slice(0, match.index).split('\n').length;

      results.push({
        file: filePath,
        type: 'unreachable-code',
        name: 'unreachable',
        line: lineNum + 1,
        snippet: lines[lineNum]?.trim().slice(0, 120) || '',
        reason: 'Unreachable code after return/throw/break/continue statement',
        severity: 'high',
      });
    }

    return results;
  }

  private detectCommentedCode(content: string, lines: string[], filePath: string): DeadCodeResult[] {
    const results: DeadCodeResult[] = [];
    const commentedCodePattern = /\/\/\s*(?:const|let|var|function|if|for|while|return|import|export|class)\s+\w+/g;
    let match;

    while ((match = commentedCodePattern.exec(content)) !== null) {
      const lineNum = content.slice(0, match.index).split('\n').length;

      results.push({
        file: filePath,
        type: 'commented-out-code',
        name: 'commented-code',
        line: lineNum,
        snippet: lines[lineNum - 1]?.trim().slice(0, 120) || match[0],
        reason: 'Commented-out code detected — should be removed or restored',
        severity: 'low',
      });
    }

    // Also detect block-commented code
    const blockCommentPattern = /\/\*\s*(?:const|let|var|function|if|for|while|return|import|export|class)\s+\w+[\s\S]*?\*\//g;
    while ((match = blockCommentPattern.exec(content)) !== null) {
      const lineNum = content.slice(0, match.index).split('\n').length;
      results.push({
        file: filePath,
        type: 'commented-out-code',
        name: 'commented-block',
        line: lineNum,
        snippet: match[0].slice(0, 120),
        reason: 'Block-commented code detected — should be removed or restored',
        severity: 'medium',
      });
    }

    return results;
  }

  private detectUnusedExports(files: string[]): DeadCodeResult[] {
    const results: DeadCodeResult[] = [];
    const allContent: Array<{ file: string; content: string; exports: string[] }> = [];

    // First pass: collect all exports
    for (const file of files.slice(0, this.config.maxFiles || 500)) {
      const fullPath = resolve(this.config.workDir, file);
      if (!existsSync(fullPath)) continue;

      let content: string;
      try {
        content = readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const exports = this.extractExports(content);
      if (exports.length > 0) {
        allContent.push({ file, content, exports });
      }
    }

    // Second pass: check if exports are imported elsewhere
    for (const { file, content, exports: exp } of allContent) {
      const restContent = allContent
        .filter(a => a.file !== file)
        .map(a => a.content)
        .join('\n');

      for (const expName of exp) {
        if (!restContent.includes(expName)) {
          const lines = content.split('\n');
          const lineNum = this.findExportLine(content, expName);

          results.push({
            file,
            type: 'unused-export',
            name: expName,
            line: lineNum,
            snippet: lines[lineNum - 1]?.trim().slice(0, 120) || '',
            reason: `Export "${expName}" is not imported or used anywhere in the project`,
            severity: 'medium',
          });
        }
      }
    }

    return results;
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];

    // Named exports: export function/const/class/interface/type Name
    const namedPattern = /export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/g;
    let match;
    while ((match = namedPattern.exec(content)) !== null) {
      if (!exports.includes(match[1])) {
        exports.push(match[1]);
      }
    }

    // Export { Name }
    const bracePattern = /export\s+\{([^}]+)\}/g;
    while ((match = bracePattern.exec(content)) !== null) {
      const names = match[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim());
      for (const name of names) {
        if (name && !exports.includes(name)) {
          exports.push(name);
        }
      }
    }

    return exports;
  }

  private findExportLine(content: string, name: string): number {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`export`) && lines[i].includes(name)) {
        return i + 1;
      }
    }
    return 1;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private discoverFiles(): string[] {
    const files: string[] = [];
    const workDir = this.config.workDir;
    const excludes = this.config.exclude || [];

    const shouldExclude = (filePath: string): boolean => {
      return excludes.some(pattern => {
        if (pattern.includes('*')) {
          const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\./g, '\\.'));
          return regex.test(filePath);
        }
        return filePath.includes(pattern);
      });
    };

    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const relPath = relative(workDir, fullPath);

        if (shouldExclude(relPath)) continue;

        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(fullPath);
        } catch {
          continue;
        }

        if (st.isDirectory()) {
          walk(fullPath);
        } else if (st.isFile() && (entry.endsWith('.ts') || entry.endsWith('.js'))) {
          files.push(relPath);
        }
      }
    };

    walk(workDir);
    return files;
  }

  private buildSummary(
    results: DeadCodeResult[],
    byType: Record<string, DeadCodeResult[]>,
    removableLines: number,
  ): string {
    const lines = [
      `Dead Code Detection Report`,
      `──────────────────────────`,
      `Total findings:   ${results.length}`,
      `Removable lines:  ~${removableLines}`,
      ``,
    ];

    for (const [type, items] of Object.entries(byType)) {
      lines.push(`  ${type}: ${items.length} instance(s)`);
    }

    const high = results.filter(r => r.severity === 'high').length;
    const medium = results.filter(r => r.severity === 'medium').length;
    if (high > 0 || medium > 0) {
      lines.push('');
      lines.push(`Severity breakdown:`);
      lines.push(`  High:   ${high}`);
      lines.push(`  Medium: ${medium}`);
      lines.push(`  Low:    ${results.length - high - medium}`);
    }

    return lines.join('\n');
  }
}

// ─── Convenience functions ───────────────────────────────────────────────────

export function createDeadCodeDetector(config: DeadCodeConfig): DeadCodeDetector {
  return new DeadCodeDetector(config);
}

/**
 * Quick dead code scan of a single file.
 */
export function quickDeadCodeScan(filePath: string, workDir: string): DeadCodeResult[] {
  const detector = new DeadCodeDetector({ workDir, crossFileAnalysis: false });
  return detector.analyzeFile(filePath);
}
