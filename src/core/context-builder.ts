import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { buildRepoMap } from './repo-map.js';

// Embedding/vector deps archived — stubs for graceful degradation
const loadVectorIndex = (_workDir: string): any => null;
const searchByVector = (_index: any, _vec: number[], _topK: number): any[] => [];
const saveVectorIndex = (_workDir: string, _index: any): void => {};
const getIndexableFiles = (_workDir: string): string[] => [];
const createEmbeddingProvider = (): any => null;

// --- Semantic context using vector embeddings ---

export async function getSemanticContext(
  query: string,
  workDir: string,
  topK: number = 5,
): Promise<string[]> {
  try {
    const index = loadVectorIndex(workDir);
    if (!index || index.entries.length === 0) return [];

    // Try to use embeddings for the query
    const provider = createEmbeddingProvider();
    if (provider) {
      try {
        const queryVectors = await provider.embed([query]);
        if (queryVectors.length > 0) {
          const results = searchByVector(index, queryVectors[0], topK);
          return results.map(r => r.file);
        }
      } catch {
        // Embedding failed, fall through to TF-IDF matching
      }
    }

    // Fallback: simple TF-IDF-style matching
    const queryTerms = query.toLowerCase().split(/\W+/).filter((t: string) => t.length > 2);
    const scored = index.entries.map((entry: any) => {
      const content = (entry.chunk as string).toLowerCase();
      const score = queryTerms.reduce((sum: number, term: string) => sum + (content.includes(term) ? 1 : 0), 0);
      return { file: entry.file as string, score };
    });

    return scored
      .filter((s: any) => s.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, topK)
      .map((s: any) => s.file);
  } catch {
    return [];
  }
}

// --- Build vector index ---

export async function buildVectorIndex(
  workDir: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const provider = createEmbeddingProvider();
  if (!provider) {
    throw new Error(
      'No embedding provider available. Install @xenova/transformers or set EMBEDDING_API_URL.'
    );
  }

  const files = getIndexableFiles(workDir);
  const total = files.length;

  if (total === 0) {
    if (onProgress) onProgress('No indexable files found.');
    return;
  }

  if (onProgress) onProgress(`Indexing ${total} files...`);

  // Vector index archived — stub
  const buildIndex = async (_wd: string, _embed: any, _progress: any) => {};
  await buildIndex(
    workDir,
    async (text: string) => {
      const vectors = await provider.embed([text]);
      return vectors[0];
    },
    (done: number, _total: number) => {
      if (onProgress) onProgress(`Indexed ${done}/${total} files`);
    }
  );

  if (onProgress) onProgress(`Vector index built: ${total} files indexed.`);
}

// --- Main context building ---

export async function buildProjectContext(workDir: string, taskDescription?: string): Promise<string> {
  const sections: string[] = [];

  // 0. Semantic enrichment — find related files if a task description is provided
  //    (prepended before other results)
  if (taskDescription) {
    try {
      const related = await getSemanticContext(taskDescription, workDir, 5);
      if (related.length > 0) {
        const relatedLines = related.map(r => `- ${r}`);
        sections.push('## Semantically Related Files\n' + relatedLines.join('\n'));
      }
    } catch {
      // Missing index or search failure — skip silently
    }
  }

  // 1. File tree (using find, excluding common noise)
  try {
    const tree = execSync(
      'find . -type f ' +
      '-not -path "*/node_modules/*" ' +
      '-not -path "*/.git/*" ' +
      '-not -path "*/dist/*" ' +
      '-not -path "*/build/*" ' +
      '-not -path "*/.next/*" ' +
      '-not -path "*/coverage/*" ' +
      '-not -name "*.lock" ' +
      '-not -name "package-lock.json" ' +
      '| head -200 | sort',
      { cwd: workDir, encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (tree) {
      sections.push('## Project Files\n```\n' + tree + '\n```');
    }
  } catch { /* skip if find fails */ }

  // Code map (function/class outlines)
  const repoMap = await buildRepoMap(workDir);
  if (repoMap) {
    sections.push(repoMap);
  }

  // 2. Package.json summary (if exists)
  const pkgPath = resolve(workDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = Object.keys(pkg.dependencies || {}).join(', ');
      const devDeps = Object.keys(pkg.devDependencies || {}).join(', ');
      const scripts = Object.keys(pkg.scripts || {}).join(', ');
      sections.push(
        '## Package Info\n' +
        `- name: ${pkg.name}\n` +
        `- type: ${pkg.type || 'commonjs'}\n` +
        (scripts ? `- scripts: ${scripts}\n` : '') +
        (deps ? `- dependencies: ${deps}\n` : '') +
        (devDeps ? `- devDependencies: ${devDeps}\n` : '')
      );
    } catch { /* skip bad package.json */ }
  }

  // 3. Git status (if git repo)
  try {
    const status = execSync('git status --short 2>/dev/null | head -20', {
      cwd: workDir, encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'],
      shell: '/bin/bash',
    }).trim();
    if (status) {
      sections.push('## Uncommitted Changes\n```\n' + status + '\n```');
    }
  } catch { /* not a git repo or git not available */ }

  // 4. Project memory (if exists)
  const memPath = join(workDir, '.cobra-commander', 'context.md');
  if (existsSync(memPath)) {
    try {
      const mem = readFileSync(memPath, 'utf-8').trim();
      if (mem) {
        sections.push('## Project Notes\n' + mem);
      }
    } catch { /* skip */ }
  }

  // 5. Semantic enrichment — archived (needs embeddings infrastructure)

  if (sections.length === 0) return '';
  return '# Project Context (auto-generated)\n\n' + sections.join('\n\n');
}
