import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';

interface FileNode {
  path: string;
  imports: string[];          // files this file imports
  exports: string[];          // exported symbols
  importedBy: string[];       // files that import this file
}

export interface DependencyGraph {
  files: Map<string, FileNode>;
  entryPoints: string[];      // files with no importers
  leafNodes: string[];        // files that import nothing
  circularDeps: Array<[string, string]>;
}

function resolveImportPath(importPath: string, fromFile: string, workDir: string): string | null {
  const fromDir = dirname(resolve(workDir, fromFile));

  // Handle relative imports
  if (importPath.startsWith('.')) {
    const candidates = [
      importPath,
      importPath + '.ts',
      importPath + '.tsx',
      importPath + '.js',
      importPath.replace(/\.js$/, '.ts'),
      join(importPath, 'index.ts'),
      join(importPath, 'index.js'),
    ];

    for (const candidate of candidates) {
      const abs = resolve(fromDir, candidate);
      const rel = relative(workDir, abs);
      if (existsSync(abs) && !rel.startsWith('..')) {
        return rel.startsWith('./') ? rel : './' + rel;
      }
    }
  }

  // Non-relative imports (npm packages) — skip
  return null;
}

export function buildDependencyGraph(workDir: string): DependencyGraph {
  const graph: DependencyGraph = {
    files: new Map(),
    entryPoints: [],
    leafNodes: [],
    circularDeps: [],
  };

  // Get all source files
  let files: string[];
  try {
    const output = execSync(
      'find . -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \\) ' +
      '-not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" ' +
      '-not -name "*.d.ts" | sort',
      { cwd: workDir, encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    files = output ? output.split('\n') : [];
  } catch {
    return graph;
  }

  // Parse imports from each file
  for (const file of files) {
    const absPath = resolve(workDir, file);
    if (!existsSync(absPath)) continue;

    try {
      const content = readFileSync(absPath, 'utf-8');
      const imports: string[] = [];
      const exports: string[] = [];

      // Extract import paths
      const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const resolved = resolveImportPath(match[1], file, workDir);
        if (resolved) imports.push(resolved);
      }

      // Extract require paths
      const requireRegex = /require\s*\(['"]([^'"]+)['"]\)/g;
      while ((match = requireRegex.exec(content)) !== null) {
        const resolved = resolveImportPath(match[1], file, workDir);
        if (resolved) imports.push(resolved);
      }

      // Extract export names
      const exportRegex = /export\s+(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
      while ((match = exportRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }

      graph.files.set(file, {
        path: file,
        imports: [...new Set(imports)],
        exports,
        importedBy: [],
      });
    } catch { /* skip unreadable */ }
  }

  // Build reverse mapping (importedBy)
  for (const [file, node] of graph.files) {
    for (const imp of node.imports) {
      const target = graph.files.get(imp);
      if (target) {
        target.importedBy.push(file);
      }
    }
  }

  // Find entry points (not imported by anyone)
  for (const [file, node] of graph.files) {
    if (node.importedBy.length === 0) {
      graph.entryPoints.push(file);
    }
    if (node.imports.length === 0) {
      graph.leafNodes.push(file);
    }
  }

  // Find circular dependencies
  for (const [fileA, nodeA] of graph.files) {
    for (const imp of nodeA.imports) {
      const nodeB = graph.files.get(imp);
      if (nodeB && nodeB.imports.includes(fileA)) {
        // Only add once (sorted pair)
        const pair: [string, string] = fileA < imp ? [fileA, imp] : [imp, fileA];
        if (!graph.circularDeps.some(([a, b]) => a === pair[0] && b === pair[1])) {
          graph.circularDeps.push(pair);
        }
      }
    }
  }

  return graph;
}

export function formatGraph(graph: DependencyGraph): string {
  const lines: string[] = [];

  lines.push(`Files: ${graph.files.size}`);
  lines.push(`Entry points: ${graph.entryPoints.length}`);
  lines.push(`Leaf nodes: ${graph.leafNodes.length}`);

  if (graph.circularDeps.length > 0) {
    lines.push(`\nCircular dependencies (${graph.circularDeps.length}):`);
    for (const [a, b] of graph.circularDeps) {
      lines.push(`  ${a} <-> ${b}`);
    }
  }

  lines.push('\nDependency tree:');
  for (const entry of graph.entryPoints.sort()) {
    lines.push(`  ${entry}`);
    const node = graph.files.get(entry);
    if (node) {
      for (const imp of node.imports.sort()) {
        lines.push(`    -> ${imp}`);
      }
    }
  }

  return lines.join('\n');
}

export interface AffectedDependency {
  file: string;
  dependsOn: string;
  relationship: string;
}

/**
 * Find all files that depend on (import from) the given changed files.
 * Uses the dependency graph to do reverse dependency lookup.
 */
export function findAffectedFiles(
  graph: DependencyGraph,
  changedFiles: string[]
): AffectedDependency[] {
  const results: AffectedDependency[] = [];
  const seen = new Set<string>();

  for (const changedFile of changedFiles) {
    const node = graph.files.get(changedFile);
    if (!node) continue;

    // Find all files that import this file
    for (const importer of node.importedBy) {
      const key = `${importer}->${changedFile}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Determine what symbols are imported from the changed file
      const importerNode = graph.files.get(importer);
      let relationship = 'imports';
      if (importerNode) {
        // Check if there are specific named exports that match
        const commonExports = node.exports.filter(e => importerNode.exports.includes(e));
        if (commonExports.length > 0) {
          relationship = `imports { ${commonExports.slice(0, 3).join(', ')}${commonExports.length > 3 ? ', ...' : ''} }`;
        }
      }

      results.push({
        file: importer,
        dependsOn: changedFile,
        relationship,
      });
    }
  }

  return results;
}
