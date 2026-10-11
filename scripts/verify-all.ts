#!/usr/bin/env node
/**
 * Build Verification Harness
 *
 * Runs the following checks:
 * 1. TypeScript compilation (tsc --noEmit) across all new modules
 * 2. Import graph circular dependency detection
 * 3. Module export validation (task items → file → exports)
 * 4. Generates a completion report (JSON) listing passed/failed modules
 *
 * Usage: npx tsx scripts/verify-all.ts [--json] [--verbose]
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, extname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Types
// ============================================================================

interface ModuleCheck {
  module: string;
  path: string;
  checks: {
    compilation: 'pass' | 'fail' | 'skipped';
    circularDeps: 'pass' | 'fail' | 'skipped';
    exports: 'pass' | 'fail' | 'skipped';
  };
  errors: string[];
  warnings: string[];
  duration: number;
}

interface ImportNode {
  path: string;
  imports: string[];
}

interface CircularDep {
  cycle: string[];
  files: string[];
}

interface VerificationReport {
  timestamp: string;
  projectRoot: string;
  summary: {
    totalModules: number;
    passed: number;
    failed: number;
    skipped: number;
    compilationPassed: boolean;
    circularDepsFound: number;
    exportIssuesFound: number;
  };
  modules: ModuleCheck[];
  circularDependencies: CircularDep[];
  exportValidation: {
    taskItems: string[];
    expectedExports: Record<string, string[]>;
    missingExports: string[];
  };
}

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const TSCONFIG_PATH = join(PROJECT_ROOT, 'tsconfig.json');

// Modules to verify (directories and entry files)
const MODULES_TO_VERIFY: string[] = [
  'src/api-server',
  'src/core',
  'src/providers',
  'src/remote',
  'src/tasks',
  'src/tools',
  'src/workers',
  'src/cli.ts',
];

// Task item to file export mapping
const TASK_ITEM_EXPORTS: Record<string, string[]> = {
  'DS-T01': ['tests/integration/api-server.test.ts'],
  'DS-T02': ['tests/e2e/pipeline.ts'],
  'DS-T03': ['src/tasks/templates.ts'],
  'DS-T05': ['src/workers/consensus.ts'],
  'verify-harness': ['scripts/verify-all.ts'],
};

// ============================================================================
// 1. TypeScript Compilation Check (runs ONCE globally)
// ============================================================================

interface GlobalCompilationResult {
  status: 'pass' | 'fail';
  allErrors: string[];
  errorsByModule: Map<string, string[]>;
}

function runGlobalCompilation(verbose: boolean): GlobalCompilationResult {
  const errorsByModule = new Map<string, string[]>();

  try {
    execSync('npx tsc --noEmit', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000,
    });

    return { status: 'pass', allErrors: [], errorsByModule };
  } catch (err) {
    const output = (err as { stdout?: string; stderr?: string }).stdout ||
                   (err as { stdout?: string; stderr?: string }).stderr || '';
    const allErrors = output.split('\n').filter(l => l.trim().length > 0);

    // Attribute errors to modules
    for (const mod of MODULES_TO_VERIFY) {
      const moduleErrors = allErrors.filter(line => line.includes(mod));
      if (moduleErrors.length > 0) {
        errorsByModule.set(mod, moduleErrors.slice(0, 20));
      }
    }

    if (verbose) {
      const newModuleErrors = [...errorsByModule.entries()].filter(
        ([mod]) => mod === 'src/tasks' || mod === 'src/workers' || mod === 'scripts'
      );
      for (const [mod, errors] of newModuleErrors) {
        console.error(`  Compilation errors in ${mod}:`);
        for (const e of errors.slice(0, 5)) {
          console.error(`    ${e.trim()}`);
        }
        if (errors.length > 5) console.error(`    ... and ${errors.length - 5} more`);
      }
    }

    return { status: 'fail', allErrors, errorsByModule };
  }
}

function getModuleCompilationStatus(
  modulePath: string,
  globalResult: GlobalCompilationResult,
): { status: 'pass' | 'fail' | 'skipped'; errors: string[] } {
  const fullPath = join(PROJECT_ROOT, modulePath);
  if (!existsSync(fullPath)) {
    return { status: 'skipped', errors: [`Path not found: ${fullPath}`] };
  }

  if (globalResult.status === 'pass') {
    return { status: 'pass', errors: [] };
  }

  const moduleErrors = globalResult.errorsByModule.get(modulePath) || [];
  return {
    status: moduleErrors.length > 0 ? 'fail' : 'pass',
    errors: moduleErrors,
  };
}

// ============================================================================
// 2. Import Graph Circular Dependency Detection
// ============================================================================

function collectImports(filePath: string): string[] {
  const imports: string[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    const importRegex = /import\s+(?:type\s+)?(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      // Only track local imports (relative paths)
      if (importPath.startsWith('.')) {
        const resolved = resolve(dirname(filePath), importPath);
        // Try .ts, .tsx, .js extensions
        for (const ext of ['.ts', '.tsx', '.js', '/index.ts', '/index.js']) {
          const candidate = resolved + ext;
          if (existsSync(candidate)) {
            imports.push(candidate);
            break;
          }
        }
      }
    }
  } catch {
    // Skip unreadable files
  }
  return imports;
}

function findAllSourceFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '__tests__') {
        files.push(...findAllSourceFiles(fullPath));
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Skip unreadable directories
  }
  return files;
}

function detectCircularDeps(
  modulePath: string,
  verbose: boolean,
): { status: 'pass' | 'fail' | 'skipped'; cycles: CircularDep[] } {
  const fullPath = join(PROJECT_ROOT, modulePath);
  if (!existsSync(fullPath)) {
    return { status: 'skipped', cycles: [] };
  }

  const isDir = statSync(fullPath, { throwIfNoEntry: false })?.isDirectory();
  const files = isDir ? findAllSourceFiles(fullPath) : [fullPath];
  const tsFiles = files.filter(f => /\.tsx?$/.test(f));

  if (tsFiles.length === 0) {
    return { status: 'pass', cycles: [] };
  }

  // Build import graph
  const graph = new Map<string, ImportNode>();
  for (const file of tsFiles) {
    const imports = collectImports(file).filter(imp => tsFiles.includes(imp));
    graph.set(file, { path: file, imports });
  }

  // DFS cycle detection
  const cycles: CircularDep[] = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();

  for (const node of graph.keys()) {
    color.set(node, WHITE);
  }

  function dfs(node: string, path: string[]): boolean {
    color.set(node, GRAY);
    path.push(node);

    const imports = graph.get(node)?.imports || [];
    for (const imp of imports) {
      const c = color.get(imp);
      if (c === GRAY) {
        // Found a cycle
        const cycleStart = path.indexOf(imp);
        const cycle = path.slice(cycleStart);
        cycle.push(imp); // Complete the cycle

        // Only report unique cycles
        const normalized = [...cycle].sort();
        const key = normalized.join(' → ');
        if (!cycles.some(c => [...c.cycle].sort().join(' → ') === key)) {
          cycles.push({
            cycle: cycle.map(p => relative(PROJECT_ROOT, p)),
            files: cycle.map(p => relative(PROJECT_ROOT, p)),
          });
        }
      } else if (c === WHITE) {
        dfs(imp, path);
      }
    }

    path.pop();
    color.set(node, BLACK);
    return false;
  }

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node, []);
    }
  }

  if (verbose && cycles.length > 0) {
    console.error(`  Circular dependencies found in ${modulePath}:`);
    for (const cycle of cycles) {
      console.error(`    Cycle: ${cycle.cycle.join(' → ')}`);
    }
  }

  return {
    status: cycles.length === 0 ? 'pass' : 'fail',
    cycles,
  };
}

// ============================================================================
// 3. Module Export Validation
// ============================================================================

function validateExports(
  taskItems: Record<string, string[]>,
  verbose: boolean,
): {
  status: 'pass' | 'fail';
  taskItems: string[];
  expectedExports: Record<string, string[]>;
  missingExports: string[];
} {
  const taskItemIds = Object.keys(taskItems);
  const missingExports: string[] = [];
  const expectedExports: Record<string, string[]> = {};

  for (const [taskId, files] of Object.entries(taskItems)) {
    expectedExports[taskId] = [];

    for (const file of files) {
      const fullPath = join(PROJECT_ROOT, file);
      if (!existsSync(fullPath)) {
        missingExports.push(`${taskId}: ${file} (file not found)`);
        continue;
      }

      // Check for export statements in the file
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const exportMatches = content.match(/export\s+(?:default\s+)?(?:class|function|const|interface|type|async\s+function|enum)\s+(\w+)/g);

        if (exportMatches && exportMatches.length > 0) {
          expectedExports[taskId].push(...exportMatches.map(m => {
            const name = m.replace(/^export\s+(?:default\s+)?(?:class|function|const|interface|type|async\s+function|enum)\s+/, '');
            return name;
          }));
        } else {
          // Files without exports (like test files) are OK
          if (verbose) {
            console.error(`  No exports found in ${file} (may be expected for test files)`);
          }
          expectedExports[taskId].push('(no named exports — test file)');
        }
      } catch (err) {
        missingExports.push(`${taskId}: ${file} (error reading: ${(err as Error).message})`);
      }
    }
  }

  return {
    status: missingExports.length === 0 ? 'pass' : 'fail',
    taskItems: taskItemIds,
    expectedExports,
    missingExports,
  };
}

// ============================================================================
// 4. Main Verification Runner
// ============================================================================

async function runVerification(verbose: boolean): Promise<VerificationReport> {
  const modules: ModuleCheck[] = [];
  const allCircularDeps: CircularDep[] = [];
  const overallStart = Date.now();

  console.log('=== Cobra Commander Build Verification ===');
  console.log(`Project root: ${PROJECT_ROOT}`);
  console.log(`Modules to verify: ${MODULES_TO_VERIFY.length}`);
  console.log('');

  // ── Step 1: Compilation (global, runs once) ────────────────
  console.log('--- TypeScript Compilation (global) ---');
  const globalCompStart = Date.now();
  const globalComp = runGlobalCompilation(verbose);
  console.log(`  Global compilation: ${globalComp.status} (${Date.now() - globalCompStart}ms)`);
  if (globalComp.status === 'fail') {
    console.log(`  Total errors: ${globalComp.allErrors.length}`);
    // Report module-specific errors
    for (const [mod, errs] of globalComp.errorsByModule) {
      console.log(`    ${mod}: ${errs.length} errors`);
    }
  }
  console.log('');

  // ── Step 2: Per-module checks (circular deps) ──────────────
  console.log('--- Circular Dependency Detection ---');

  for (const mod of MODULES_TO_VERIFY) {
    const start = Date.now();
    const compResult = getModuleCompilationStatus(mod, globalComp);
    const circResult = detectCircularDeps(mod, verbose);
    allCircularDeps.push(...circResult.cycles);

    const moduleCheck: ModuleCheck = {
      module: mod,
      path: join(PROJECT_ROOT, mod),
      checks: {
        compilation: compResult.status,
        circularDeps: circResult.status,
        exports: 'skipped', // Filled below
      },
      errors: [...compResult.errors],
      warnings: circResult.cycles.map(c => `Circular: ${c.cycle.join(' → ')}`),
      duration: Date.now() - start,
    };

    modules.push(moduleCheck);
    if (verbose) {
      console.log(`  ${mod}: compile=${compResult.status}, circular=${circResult.status} (${moduleCheck.duration}ms)`);
    }
  }

  // ── Step 2: Export Validation ──────────────────────────────
  console.log('\n--- Export Validation ---');
  const exportResult = validateExports(TASK_ITEM_EXPORTS, verbose);
  console.log(`  Task items checked: ${exportResult.taskItems.length}`);
  console.log(`  Missing exports: ${exportResult.missingExports.length}`);

  // Update module checks with export results
  for (const mod of modules) {
    // Match module to task items
    const relatedExports = Object.entries(exportResult.expectedExports)
      .filter(([, files]) => files.some(f => mod.module.includes(basename(f, extname(f)))))
      .length;

    if (relatedExports > 0) {
      mod.checks.exports = exportResult.status;
    }
  }

  // ── Compute Summary ────────────────────────────────────────
  const summary = {
    totalModules: modules.length,
    passed: modules.filter(m =>
      m.checks.compilation !== 'fail' &&
      m.checks.circularDeps !== 'fail' &&
      m.checks.exports !== 'fail'
    ).length,
    failed: modules.filter(m =>
      m.checks.compilation === 'fail' ||
      m.checks.circularDeps === 'fail' ||
      m.checks.exports === 'fail'
    ).length,
    skipped: modules.filter(m =>
      m.checks.compilation === 'skipped' &&
      m.checks.circularDeps === 'skipped'
    ).length,
    compilationPassed: modules.every(m => m.checks.compilation !== 'fail'),
    circularDepsFound: allCircularDeps.length,
    exportIssuesFound: exportResult.missingExports.length,
  };

  return {
    timestamp: new Date().toISOString(),
    projectRoot: PROJECT_ROOT,
    summary,
    modules,
    circularDependencies: allCircularDeps,
    exportValidation: exportResult,
  };
}

// ============================================================================
// Report Generation
// ============================================================================

function generateReport(report: VerificationReport, outputPath?: string): string {
  const lines: string[] = [
    '# Cobra Commander Build Verification Report',
    '',
    `**Timestamp:** ${report.timestamp}`,
    `**Project Root:** ${report.projectRoot}`,
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Modules | ${report.summary.totalModules} |`,
    `| Passed | ${report.summary.passed} |`,
    `| Failed | ${report.summary.failed} |`,
    `| Compilation | ${report.summary.compilationPassed ? '✅ PASS' : '❌ FAIL'} |`,
    `| Circular Dependencies | ${report.summary.circularDepsFound} found |`,
    `| Export Issues | ${report.summary.exportIssuesFound} found |`,
    '',
    '## Module Checks',
    '',
    '| Module | Compilation | Circular Deps | Exports | Errors |',
    '|--------|-------------|---------------|---------|--------|',
  ];

  for (const mod of report.modules) {
    const comp = mod.checks.compilation === 'pass' ? '✅' : mod.checks.compilation === 'fail' ? '❌' : '—';
    const circ = mod.checks.circularDeps === 'pass' ? '✅' : mod.checks.circularDeps === 'fail' ? '❌' : '—';
    const exp = mod.checks.exports === 'pass' ? '✅' : mod.checks.exports === 'fail' ? '❌' : '—';
    const errorCount = mod.errors.length + mod.warnings.length;
    lines.push(`| ${mod.module} | ${comp} | ${circ} | ${exp} | ${errorCount} |`);
  }

  if (report.circularDependencies.length > 0) {
    lines.push('');
    lines.push('## Circular Dependencies');
    lines.push('');
    for (const cd of report.circularDependencies) {
      lines.push(`- ${cd.cycle.join(' → ')}`);
    }
  }

  if (report.exportValidation.missingExports.length > 0) {
    lines.push('');
    lines.push('## Missing Exports');
    lines.push('');
    for (const me of report.exportValidation.missingExports) {
      lines.push(`- ${me}`);
    }
  }

  // Export validation summary
  lines.push('');
  lines.push('## Export Validation');
  lines.push('');
  for (const [taskId, exports] of Object.entries(report.exportValidation.expectedExports)) {
    lines.push(`### ${taskId}`);
    for (const exp of exports) {
      lines.push(`- ${exp}`);
    }
  }

  const markdown = lines.join('\n');

  if (outputPath) {
    writeFileSync(outputPath, markdown, 'utf-8');
    console.log(`Report saved to: ${outputPath}`);
  }

  return markdown;
}

// ============================================================================
// Entry Point
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const verbose = args.includes('--verbose');
  const outputPath = args.find(a => a.startsWith('--output='))?.split('=')[1];

  try {
    const report = await runVerification(verbose);

    if (jsonOutput) {
      const jsonPath = outputPath || join(PROJECT_ROOT, 'verify-report.json');
      writeFileSync(jsonPath, JSON.stringify(report, null, 2));
      console.log(`\nJSON report saved to: ${jsonPath}`);
    } else {
      const mdPath = outputPath || join(PROJECT_ROOT, 'verify-report.md');
      generateReport(report, mdPath);
    }

    // Print summary to console
    console.log('');
    console.log('=== Verification Complete ===');
    console.log(`Passed: ${report.summary.passed}/${report.summary.totalModules}`);
    console.log(`Failed: ${report.summary.failed}/${report.summary.totalModules}`);
    console.log(`Compilation: ${report.summary.compilationPassed ? 'PASS' : 'FAIL'}`);
    console.log(`Circular deps: ${report.summary.circularDepsFound}`);
    console.log(`Export issues: ${report.summary.exportIssuesFound}`);

    // Exit with non-zero if failures
    if (report.summary.failed > 0 || !report.summary.compilationPassed) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Verification failed:', err);
    process.exit(2);
  }
}

main();
