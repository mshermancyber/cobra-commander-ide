import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

// Extract file paths from text — looks for patterns like:
// - src/foo/bar.ts
// - ./config.json
// - path/to/file.ext
// Excludes URLs, git refs, common false positives
const FILE_PATH_REGEX = /(?:^|\s|["'`(])(\.?\/?[\w./-]*\.[a-zA-Z]{1,10})(?=[\s"'`),:;]|$)/gm;

export function extractFilePaths(text: string): string[] {
  const matches = new Set<string>();
  let match;
  while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
    const path = match[1].replace(/^\.\//, '');
    // Skip obvious non-files
    if (path.includes('://') || path.startsWith('http') || path.endsWith('.com') || path.endsWith('.org')) continue;
    if (path.match(/^\d+\.\d+\.\d+/)) continue; // version numbers
    matches.add(path);
  }
  return [...matches];
}

export function preloadFiles(workDir: string, text: string, maxFiles = 8, maxSizePerFile = 10_000): string {
  const paths = extractFilePaths(text);
  if (paths.length === 0) return '';

  const sections: string[] = [];
  let loaded = 0;

  for (const p of paths) {
    if (loaded >= maxFiles) break;
    const absPath = resolve(workDir, p);
    if (!absPath.startsWith(resolve(workDir))) continue; // path traversal
    if (!existsSync(absPath)) continue;

    try {
      let content = readFileSync(absPath, 'utf-8');
      if (content.length > maxSizePerFile) {
        content = content.slice(0, maxSizePerFile) + '\n... [truncated]';
      }
      sections.push('### ' + p + '\n```\n' + content + '\n```');
      loaded++;
    } catch { continue; }
  }

  if (sections.length === 0) return '';
  return '## Pre-loaded Files\n\n' + sections.join('\n\n');
}

export function smartPreload(workDir: string, taskText: string): string {
  const sections: string[] = [];

  // 1. Extract explicit file paths from the task
  // (existing preloadFiles handles this)

  // 2. Extract identifiers (PascalCase or camelCase words that might be class/function names)
  const identifiers = new Set<string>();
  const identifierPattern = /\b([A-Z][a-zA-Z0-9]{2,}|[a-z][a-zA-Z0-9]{2,}(?:Handler|Service|Manager|Provider|Builder|Factory|Router|Worker|Engine|Parser|Resolver))\b/g;
  let match;
  while ((match = identifierPattern.exec(taskText)) !== null) {
    const id = match[1];
    // Skip common words that aren't code identifiers
    if (!['The', 'This', 'That', 'When', 'Then', 'With', 'From', 'Into', 'Each', 'Some', 'After', 'Before'].includes(id)) {
      identifiers.add(id);
    }
  }

  // 3. Find definitions of mentioned identifiers using grep
  if (identifiers.size > 0 && identifiers.size <= 10) {
    const defPatterns = Array.from(identifiers).slice(0, 5);
    for (const name of defPatterns) {
      try {
        const result = execSync(
          `grep -rn "\\(export\\s\\+\\)\\?\\(function\\|class\\|interface\\|type\\|const\\)\\s\\+${name}" --include="*.ts" --include="*.js" --exclude-dir=node_modules --exclude-dir=dist . | head -3`,
          { cwd: workDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (result) {
          sections.push(`## Definition: ${name}\n\`\`\`\n${result}\n\`\`\``);
        }
      } catch { /* not found */ }
    }
  }

  // 4. Extract error file:line references
  const errorRefs = taskText.match(/([\w./]+\.[tj]sx?):(\d+)/g) || [];
  for (const ref of errorRefs.slice(0, 3)) {
    const [file, lineStr] = ref.split(':');
    const line = parseInt(lineStr);
    // Read context around the error line
    try {
      const content = readFileSync(resolve(workDir, file), 'utf-8').split('\n');
      const start = Math.max(0, line - 5);
      const end = Math.min(content.length, line + 5);
      const snippet = content.slice(start, end)
        .map((l, i) => `${start + i + 1}${start + i + 1 === line ? ' >>>' : '    '} ${l}`)
        .join('\n');
      sections.push(`## Error context: ${ref}\n\`\`\`\n${snippet}\n\`\`\``);
    } catch { /* file not found */ }
  }

  if (sections.length === 0) return '';
  return '\n## Smart Context\n\n' + sections.join('\n\n');
}

// --- Preload Learning / Stats ---

export interface PreloadStats {
  taskPatterns: Record<string, {
    filesUsed: Record<string, number>;
    filesPreloaded: Record<string, number>;
    totalTasks: number;
  }>;
  lastUpdated: string;
}

function getStatsPath(workDir: string): string {
  return join(workDir, '.cobra-commander', 'preload-stats.json');
}

export function loadStats(workDir: string): PreloadStats {
  const statsPath = getStatsPath(workDir);
  if (existsSync(statsPath)) {
    try {
      return JSON.parse(readFileSync(statsPath, 'utf-8'));
    } catch {
      // Corrupted stats file, return fresh
    }
  }
  return { taskPatterns: {}, lastUpdated: new Date().toISOString() };
}

export function saveStats(workDir: string, stats: PreloadStats): void {
  stats.lastUpdated = new Date().toISOString();
  const statsPath = getStatsPath(workDir);
  const dir = join(workDir, '.cobra-commander');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf-8');
}

const TASK_CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(fix|bug|error|issue|crash|broken|repair|patch)\b/i, category: 'fix' },
  { pattern: /\b(feature|add|implement|create|new|build|support)\b/i, category: 'feature' },
  { pattern: /\b(refactor|clean|rename|extract|simplify|restructure|reorganize)\b/i, category: 'refactor' },
  { pattern: /\b(test|spec|coverage|assert|mock|jest|vitest)\b/i, category: 'test' },
  { pattern: /\b(review|audit|check|inspect|examine)\b/i, category: 'review' },
  { pattern: /\b(doc|readme|comment|jsdoc|documentation|api doc)\b/i, category: 'doc' },
  { pattern: /\b(config|setting|env|\.env|json|yaml|toml)\b/i, category: 'config' },
];

export function categorizeTask(task: string): string {
  for (const { pattern, category } of TASK_CATEGORY_PATTERNS) {
    if (pattern.test(task)) {
      return category;
    }
  }
  return 'other';
}

export function recordPreloadedFiles(workDir: string, taskCategory: string, files: string[]): void {
  const stats = loadStats(workDir);
  if (!stats.taskPatterns[taskCategory]) {
    stats.taskPatterns[taskCategory] = {
      filesUsed: {},
      filesPreloaded: {},
      totalTasks: 0,
    };
  }
  const entry = stats.taskPatterns[taskCategory];
  entry.totalTasks++;
  for (const file of files) {
    entry.filesPreloaded[file] = (entry.filesPreloaded[file] || 0) + 1;
  }
  saveStats(workDir, stats);
}

export function recordUsedFiles(workDir: string, taskCategory: string, files: string[]): void {
  const stats = loadStats(workDir);
  if (!stats.taskPatterns[taskCategory]) {
    stats.taskPatterns[taskCategory] = {
      filesUsed: {},
      filesPreloaded: {},
      totalTasks: 0,
    };
  }
  const entry = stats.taskPatterns[taskCategory];
  for (const file of files) {
    entry.filesUsed[file] = (entry.filesUsed[file] || 0) + 1;
  }
  saveStats(workDir, stats);
}

export function getSmartPreloadSuggestions(workDir: string, taskCategory: string, candidates: string[]): string[] {
  const stats = loadStats(workDir);
  const entry = stats.taskPatterns[taskCategory];
  if (!entry || entry.totalTasks === 0) {
    return candidates; // No historical data, return as-is
  }

  // Score each candidate by historical usage frequency
  const scored = candidates.map(file => {
    const usedCount = entry.filesUsed[file] || 0;
    const preloadedCount = entry.filesPreloaded[file] || 0;
    // Prefer files that were actually used (higher weight) and preloaded
    const score = (usedCount * 3) + preloadedCount;
    return { file, score };
  });

  // Sort by score descending, then alphabetically as tiebreaker
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.file.localeCompare(b.file);
  });

  return scored.map(s => s.file);
}

export function getPreloadAccuracy(workDir: string): { overall: number; byCategory: Record<string, number> } {
  const stats = loadStats(workDir);
  const byCategory: Record<string, number> = {};

  let totalUsed = 0;
  let totalPreloaded = 0;

  for (const [category, entry] of Object.entries(stats.taskPatterns)) {
    const usedCount = Object.values(entry.filesUsed).reduce((sum, c) => sum + c, 0);
    const preloadedCount = Object.values(entry.filesPreloaded).reduce((sum, c) => sum + c, 0);
    totalUsed += usedCount;
    totalPreloaded += preloadedCount;

    if (preloadedCount > 0) {
      byCategory[category] = usedCount / preloadedCount;
    } else {
      byCategory[category] = 0;
    }
  }

  const overall = totalPreloaded > 0 ? totalUsed / totalPreloaded : 0;
  return { overall, byCategory };
}

export function resetPreloadStats(workDir: string): void {
  const statsPath = getStatsPath(workDir);
  if (existsSync(statsPath)) {
    try {
      const { unlinkSync } = require('node:fs');
      unlinkSync(statsPath);
    } catch {
      // ignore
    }
  }
}
