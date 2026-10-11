import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

/**
 * A read-only snapshot of project files captured before worker dispatch.
 * The snapshot can be serialised into a prompt section to give the worker
 * immediate context without requiring it to call read tools.
 */
export interface ContextSnapshot {
  /** Map of relative file path → file contents. */
  files: Map<string, string>;
  /** Unix-epoch timestamp when the snapshot was created. */
  createdAt: number;
}

const DEFAULT_GLOBS = [
  'package.json',
  'tsconfig.json',
  'src/core/config.ts',
  'CLAUDE.md',
];

/**
 * Create a context snapshot by pre-reading the files matched by the given
 * glob list. Only simple literal paths and `*` wildcards at the file-name
 * level are supported — this is intentionally less powerful than full glob
 * syntax to keep the implementation dependency-free.
 *
 * @param workDir - Root directory to resolve relative paths from.
 * @param globs   - Optional list of file patterns. Defaults to
 *                  package.json, tsconfig.json, src/core/config.ts, CLAUDE.md.
 */
export async function createContextSnapshot(
  workDir: string,
  globs?: string[],
): Promise<ContextSnapshot> {
  const patterns = globs && globs.length > 0 ? globs : DEFAULT_GLOBS;
  const files = new Map<string, string>();

  for (const pattern of patterns) {
    const resolved = resolveGlob(workDir, pattern);
    for (const absPath of resolved) {
      if (!existsSync(absPath)) continue;
      try {
        const relPath = relative(workDir, absPath);
        const content = readFileSync(absPath, 'utf-8');
        files.set(relPath, content);
      } catch {
        // Permission errors, binary files, etc. — skip
      }
    }
  }

  return { files, createdAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Targeted snapshot — parses file paths from worker task descriptions
// ---------------------------------------------------------------------------

/** Common source-code extensions to recognise as file paths. */
const CODE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'md', 'mdx', 'css', 'scss', 'less',
  'html', 'htm', 'svg', 'xml',
  'py', 'go', 'rs', 'java', 'kt', 'swift',
  'yaml', 'yml', 'toml', 'ini', 'cfg',
  'env', 'sh', 'bash', 'zsh',
  'sql', 'graphql', 'gql',
  'vue', 'svelte',
];

/**
 * Extract likely file paths from arbitrary text using regex patterns.
 * Matches:
 * - Paths in backticks: \`src/core/foo.ts\`
 * - Bare paths with common extensions: src/core/foo.ts
 * - Paths that start with known project roots: src/, gui/, tests/, etc.
 *
 * @param text - Arbitrary text (task description, context string, etc.)
 * @returns Array of candidate file paths (relative), never null.
 */
export function extractFilePaths(text: string): string[] {
  if (!text) return [];

  const extGroup = CODE_EXTENSIONS.join('|');
  const paths = new Set<string>();

  // 1. Backtick-enclosed paths: `src/core/foo.ts`
  const backtickRe = new RegExp('`([^`]+?)`', 'g');
  for (const m of text.matchAll(backtickRe)) {
    const candidate = m[1].trim();
    if (looksLikePath(candidate)) paths.add(candidate);
  }

  // 2. Bare paths with recognised extensions
  const bareRe = new RegExp(
    `\\b([a-z0-9_/][-a-z0-9_/.]+?\\.(?:${extGroup}))\\b`,
    'gi',
  );
  for (const m of text.matchAll(bareRe)) {
    paths.add(m[1]);
  }

  return [...paths];
}

/** Quick heuristic: does this string look like a project file path? */
function looksLikePath(s: string): boolean {
  if (s.includes(' ')) return false;
  if (s.includes('\n')) return false;
  if (s.startsWith('http')) return false;
  const ext = s.split('.').pop()?.toLowerCase();
  return ext ? CODE_EXTENSIONS.includes(ext) : false;
}

/**
 * Create a context snapshot that pre-reads files referenced in worker task
 * descriptions plus the default globs. This gives each worker immediate
 * access to the files it needs without extra read-tool round-trips.
 *
 * @param workDir - Root directory to resolve relative paths from.
 * @param tasks   - Array of task objects with `task` (description) and
 *                  `context` fields to mine for file paths.
 */
export async function createTargetedSnapshot(
  workDir: string,
  tasks: Array<{ task: string; context: string }>,
): Promise<ContextSnapshot> {
  // Collect every mentioned file path from task text
  const mentioned = new Set<string>();
  for (const t of tasks) {
    for (const p of extractFilePaths(t.task)) mentioned.add(p);
    for (const p of extractFilePaths(t.context)) mentioned.add(p);
  }

  // Build the glob list: default globs + every mentioned literal path
  const allPatterns = [...DEFAULT_GLOBS];
  for (const p of mentioned) {
    if (!p.includes('*')) {
      allPatterns.push(p);
    }
  }

  return createContextSnapshot(workDir, allPatterns);
}

/**
 * Format a context snapshot as a Markdown prompt section suitable for
 * inclusion in a system prompt or pre-loaded files block.
 */
export function snapshotToPrompt(snapshot: ContextSnapshot): string {
  if (snapshot.files.size === 0) return '';

  const sections: string[] = [];
  for (const [path, content] of snapshot.files) {
    sections.push(`### ${path}\n\`\`\`\n${content}\n\`\`\``);
  }

  return '## Pre-loaded Files\n\n' + sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Minimal glob resolver — supports literal paths and file-name wildcards
// (e.g. "src/**" is NOT supported, but "*.json" is).
// ---------------------------------------------------------------------------

import { readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

function resolveGlob(workDir: string, pattern: string): string[] {
  // If the pattern is a literal path (no wildcards), resolve directly.
  if (!pattern.includes('*')) {
    return [resolve(workDir, pattern)];
  }

  // Simple wildcard: only the file-name portion may contain '*'.
  const dir = dirname(pattern);
  const name = basename(pattern);
  const absDir = resolve(workDir, dir);

  if (!existsSync(absDir)) return [];

  const regex = new RegExp(
    '^' + name.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
  );

  try {
    return readdirSync(absDir)
      .filter(f => regex.test(f))
      .map(f => join(absDir, f));
  } catch {
    return [];
  }
}
