import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join, basename, dirname } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SimilarCode {
  /** The similar code block found */
  codeBlock: string;
  /** Where it was found */
  location: SimilarCodeLocation;
  /** How similar it is to the PR change (0-100) */
  similarity: SimilarityScore;
  /** Why this is relevant to the reviewer */
  relevance: string;
  /** Suggested review actions */
  suggestions: string[];
}

export interface SimilarCodeLocation {
  /** File path */
  file: string;
  /** Starting line (1-based) */
  startLine: number;
  /** Ending line (1-based) */
  endLine: number;
  /** Function/class context */
  context: string;
}

export interface SimilarityScore {
  /** Overall similarity percentage (0-100) */
  overall: number;
  /** Structural similarity (0-100) */
  structural: number;
  /** Semantic similarity (0-100) */
  semantic: number;
  /** Token-level similarity (0-100) */
  token: number;
}

export interface SimilarCodeConfig {
  /** Root directory to search */
  workDir: string;
  /** Minimum similarity to include (0-100) */
  minSimilarity?: number;
  /** Maximum results */
  maxResults?: number;
  /** Files/patterns to exclude */
  exclude?: string[];
  /** Include changed files in results */
  includeChanged?: boolean;
  /** Max files to scan */
  maxFiles?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SimilarCodeConfig = {
  workDir: process.cwd(),
  minSimilarity: 50,
  maxResults: 20,
  exclude: ['node_modules', 'dist', '.git'],
  includeChanged: false,
  maxFiles: 500,
};

// ─── Core Finder ─────────────────────────────────────────────────────────────

export class SimilarCodeFinder {
  private config: SimilarCodeConfig;

  constructor(config: SimilarCodeConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * Find code in the codebase similar to changes in a PR diff.
   */
  findSimilar(prDiff: string): SimilarCode[] {
    const changedBlocks = this.extractChangedBlocks(prDiff);
    if (changedBlocks.length === 0) return [];

    const results: SimilarCode[] = [];

    // Discover project files to search
    const projectFiles = this.discoverFiles();

    // Read all project files
    const fileContents = this.readFiles(projectFiles);

    // For each changed block, find similar code
    for (const block of changedBlocks) {
      const normalized = this.normalizeCode(block.content);

      for (const fc of fileContents) {
        // Skip if this file is the changed file itself
        if (block.file && fc.file === block.file) continue;

        const similarities = this.findSimilarBlocks(normalized, fc.content, fc.file);

        for (const sim of similarities) {
          if (sim.similarity.overall >= (this.config.minSimilarity || 50)) {
            results.push({
              codeBlock: sim.matchedBlock,
              location: sim.location,
              similarity: sim.similarity,
              relevance: this.determineRelevance(sim, block),
              suggestions: this.generateSuggestions(sim, block),
            });
          }
        }
      }
    }

    // Deduplicate and sort
    const unique = this.deduplicateResults(results);
    return unique
      .sort((a, b) => b.similarity.overall - a.similarity.overall)
      .slice(0, this.config.maxResults || 20);
  }

  /**
   * Generate a formatted reference report for reviewers.
   */
  generateReferenceReport(similarList: SimilarCode[]): string {
    if (similarList.length === 0) {
      return 'No similar code patterns found in the codebase.\n';
    }

    const lines: string[] = [];
    lines.push(`Similar Code Reference Report`);
    lines.push(`==============================`);
    lines.push(`Found ${similarList.length} similar code pattern(s) in the codebase.`);
    lines.push('');

    // Group by relevance
    const grouped = this.groupByRelevance(similarList);

    for (const [relevance, items] of Object.entries(grouped)) {
      lines.push(`## ${relevance}`);
      lines.push('');

      for (const item of items.slice(0, 5)) {
        lines.push(`### ${item.location.file}:${item.location.startLine}-${item.location.endLine}`);
        lines.push(`- Similarity: ${item.similarity.overall}% (structural: ${item.similarity.structural}%, semantic: ${item.similarity.semantic}%)`);
        lines.push(`- Context: ${item.location.context}`);
        lines.push(`- Relevance: ${item.relevance}`);
        if (item.suggestions.length > 0) {
          lines.push(`- Suggestions:`);
          for (const s of item.suggestions) {
            lines.push(`  - ${s}`);
          }
        }
        lines.push('');
        lines.push('```');
        lines.push(item.codeBlock.slice(0, 300));
        if (item.codeBlock.length > 300) lines.push('  ...');
        lines.push('```');
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private extractChangedBlocks(diff: string): Array<{ file: string; content: string; type: string }> {
    const blocks: Array<{ file: string; content: string; type: string }> = [];
    let currentFile = '';
    let currentContent: string[] = [];
    let inHunk = false;

    const lines = diff.split('\n');

    for (const line of lines) {
      // File header
      if (line.startsWith('diff --git') || line.startsWith('--- a/') || line.startsWith('+++ b/')) {
        if (currentContent.length > 0 && currentFile) {
          blocks.push({ file: currentFile, content: currentContent.join('\n'), type: 'changed' });
          currentContent = [];
        }
        if (line.startsWith('--- a/')) {
          currentFile = line.slice(6);
        } else if (line.startsWith('+++ b/')) {
          currentFile = line.slice(6);
        }
        inHunk = false;
        continue;
      }

      // Hunk header
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }

      // Changed lines
      if (inHunk && (line.startsWith('+') && !line.startsWith('+++'))) {
        currentContent.push(line.slice(1)); // Remove + prefix
      }
    }

    // Flush last block
    if (currentContent.length > 0 && currentFile) {
      blocks.push({ file: currentFile, content: currentContent.join('\n'), type: 'changed' });
    }

    return blocks;
  }

  private discoverFiles(): string[] {
    const files: string[] = [];
    const workDir = this.config.workDir;
    const excludes = this.config.exclude || [];

    const shouldExclude = (filePath: string): boolean => {
      return excludes.some(pattern => filePath.includes(pattern));
    };

    const walk = (dir: string): void => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const relPath = relative(workDir, fullPath);

        if (shouldExclude(relPath)) continue;
        if (entry.startsWith('.')) continue;

        let st: ReturnType<typeof statSync>;
        try { st = statSync(fullPath); } catch { continue; }

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

  private readFiles(files: string[]): Array<{ file: string; content: string }> {
    const results: Array<{ file: string; content: string }> = [];

    for (const file of files.slice(0, this.config.maxFiles)) {
      const fullPath = resolve(this.config.workDir, file);
      try {
        const content = readFileSync(fullPath, 'utf-8');
        results.push({ file, content });
      } catch { /* skip unreadable */ }
    }

    return results;
  }

  private normalizeCode(code: string): string {
    return code
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/"[^"]*"/g, '""')
      .replace(/'[^']*'/g, "''")
      .replace(/`[^`]*`/g, '``')
      .replace(/\b\d+\b/g, '0')
      .replace(/^\s+|\s+$/gm, '')
      .toLowerCase()
      .trim();
  }

  private findSimilarBlocks(
    needle: string,
    haystack: string,
    haystackFile: string,
  ): Array<{
    matchedBlock: string;
    location: SimilarCodeLocation;
    similarity: SimilarityScore;
  }> {
    const results: Array<{
      matchedBlock: string;
      location: SimilarCodeLocation;
      similarity: SimilarityScore;
    }> = [];

    const haystackNormalized = this.normalizeCode(haystack);
    const haystackLines = haystack.split('\n');
    const needleTokens = needle.split(/\s+/).filter(t => t.length > 1);

    if (needleTokens.length === 0) return results;

    // Sliding window search
    const windowSizes = [needleTokens.length, needleTokens.length * 2, needleTokens.length * 3];

    for (const windowSize of windowSizes) {
      if (windowSize > haystackNormalized.split(/\s+/).length) continue;

      const hsTokens = haystackNormalized.split(/\s+/);

      for (let i = 0; i <= hsTokens.length - windowSize; i++) {
        const windowTokens = hsTokens.slice(i, i + windowSize);

        // Compute token-level Jaccard similarity
        const tokenSim = this.tokenSimilarity(needleTokens, windowTokens);
        const structuralSim = this.structuralSimilarity(needleTokens, windowTokens);
        const semanticSim = this.semanticSimilarity(needleTokens, windowTokens);

        const overall = Math.round((tokenSim * 0.4 + structuralSim * 0.35 + semanticSim * 0.25));

        if (overall >= (this.config.minSimilarity || 50)) {
          // Find original lines for context
          const approxStartLine = Math.max(1, Math.floor(i / 5)); // Rough estimate
          const approxEndLine = Math.min(haystackLines.length, Math.floor((i + windowSize) / 5));
          const matchedBlock = haystackLines.slice(approxStartLine - 1, approxEndLine).join('\n').slice(0, 300);

          // Determine context
          const context = this.findContext(haystackLines, approxStartLine);

          results.push({
            matchedBlock,
            location: {
              file: haystackFile,
              startLine: approxStartLine,
              endLine: approxEndLine,
              context,
            },
            similarity: {
              overall,
              structural: structuralSim,
              semantic: semanticSim,
              token: tokenSim,
            },
          });

          // Only take best match per area
          i += windowSize;
        }
      }
    }

    // Return top results
    return results
      .sort((a, b) => b.similarity.overall - a.similarity.overall)
      .slice(0, 5);
  }

  private tokenSimilarity(tokensA: string[], tokensB: string[]): number {
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);

    return union.size > 0
      ? Math.round((intersection.size / union.size) * 100)
      : 0;
  }

  private structuralSimilarity(tokensA: string[], tokensB: string[]): number {
    // Compare token sequences (bigrams)
    const bigramsA = new Set<string>();
    const bigramsB = new Set<string>();

    for (let i = 0; i < tokensA.length - 1; i++) {
      bigramsA.add(`${tokensA[i]}|${tokensA[i + 1]}`);
    }
    for (let i = 0; i < tokensB.length - 1; i++) {
      bigramsB.add(`${tokensB[i]}|${tokensB[i + 1]}`);
    }

    const intersection = new Set([...bigramsA].filter(x => bigramsB.has(x)));
    const union = new Set([...bigramsA, ...bigramsB]);

    return union.size > 0
      ? Math.round((intersection.size / union.size) * 100)
      : 0;
  }

  private semanticSimilarity(tokensA: string[], tokensB: string[]): number {
    // Compare keyword presence and patterns
    const keywords = new Set([
      'return', 'throw', 'await', 'async', 'export', 'import', 'class',
      'function', 'const', 'let', 'var', 'if', 'else', 'for', 'while',
      'try', 'catch', 'finally', 'new', 'typeof', 'instanceof', 'void',
    ]);

    const keywordsA = new Set(tokensA.filter(t => keywords.has(t)));
    const keywordsB = new Set(tokensB.filter(t => keywords.has(t)));

    const intersection = new Set([...keywordsA].filter(x => keywordsB.has(x)));
    const union = new Set([...keywordsA, ...keywordsB]);

    return union.size > 0
      ? Math.round((intersection.size / union.size) * 100)
      : 50; // Neutral score if no keywords
  }

  private findContext(lines: string[], approxLine: number): string {
    // Look backwards for function/class declaration
    for (let i = approxLine - 1; i >= 0 && i >= approxLine - 30; i--) {
      const line = lines[i]?.trim() || '';
      if (/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.test(line)) {
        return `function ${line.match(/function\s+(\w+)/)?.[1] || 'unknown'}`;
      }
      if (/^(?:export\s+)?class\s+(\w+)/.test(line)) {
        return `class ${line.match(/class\s+(\w+)/)?.[1] || 'unknown'}`;
      }
      if (/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/.test(line)) {
        return `arrow function ${line.match(/(?:const|let|var)\s+(\w+)/)?.[1] || 'unknown'}`;
      }
    }
    return 'top-level code';
  }

  private determineRelevance(
    similar: { similarity: SimilarityScore },
    block: { content: string; type: string },
  ): string {
    const overall = similar.similarity.overall;

    if (overall >= 90) {
      return 'Near-identical code — possible copy-paste. Ensure the change is applied consistently or the duplication is intentional.';
    }
    if (overall >= 75) {
      return 'Very similar pattern — changes here may indicate a pattern that should be abstracted or kept in sync.';
    }
    if (overall >= 60) {
      return 'Similar approach — the PR change follows an existing pattern. Verify consistency.';
    }
    return 'Moderately similar — may be relevant for context during review.';
  }

  private generateSuggestions(
    similar: { similarity: SimilarityScore; location: SimilarCodeLocation },
    block: { content: string; type: string },
  ): string[] {
    const suggestions: string[] = [];

    if (similar.similarity.overall >= 90) {
      suggestions.push('Review both locations — changes in the PR should likely be mirrored here.');
      suggestions.push('Consider extracting shared logic to a utility or base class.');
    }

    if (similar.similarity.structural >= 80) {
      suggestions.push('Same code structure detected — verify behavior is consistent.');
    }

    if (similar.similarity.semantic >= 80) {
      suggestions.push('Semantically similar — ensure naming and conventions are consistent.');
    }

    suggestions.push(`See: ${similar.location.file}:${similar.location.startLine}`);

    return suggestions;
  }

  private deduplicateResults(results: SimilarCode[]): SimilarCode[] {
    const seen = new Set<string>();
    const unique: SimilarCode[] = [];

    for (const result of results) {
      const key = `${result.location.file}:${result.location.startLine}:${result.similarity.overall}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(result);
      }
    }

    return unique;
  }

  private groupByRelevance(results: SimilarCode[]): Record<string, SimilarCode[]> {
    const groups: Record<string, SimilarCode[]> = {
      'Near-identical matches': [],
      'Very similar patterns': [],
      'Similar approaches': [],
      'Relevant context': [],
    };

    for (const r of results) {
      if (r.similarity.overall >= 90) {
        groups['Near-identical matches'].push(r);
      } else if (r.similarity.overall >= 75) {
        groups['Very similar patterns'].push(r);
      } else if (r.similarity.overall >= 60) {
        groups['Similar approaches'].push(r);
      } else {
        groups['Relevant context'].push(r);
      }
    }

    return groups;
  }
}

// ─── Convenience functions ───────────────────────────────────────────────────

export function createSimilarCodeFinder(config: SimilarCodeConfig): SimilarCodeFinder {
  return new SimilarCodeFinder(config);
}

/**
 * Quick similarity search for a code snippet.
 */
export function quickSimilaritySearch(
  codeSnippet: string,
  workDir: string,
  maxResults = 10,
): SimilarCode[] {
  const fakeDiff = `+++ b/unknown\n@@ -0,0 +1,${codeSnippet.split('\n').length} @@\n${codeSnippet.split('\n').map(l => '+' + l).join('\n')}`;
  const finder = new SimilarCodeFinder({ workDir, maxResults });
  return finder.findSimilar(fakeDiff);
}
