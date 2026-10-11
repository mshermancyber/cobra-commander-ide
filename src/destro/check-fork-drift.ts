// npm-free runner: npx tsx src/destro/check-fork-drift.ts

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

interface ForkEntry {
  fork: string;
  origin: string;
}

interface DriftResult {
  fork: string;
  origin: string;
  linesInFork: number;
  linesInOrigin: number;
  firstLineMatch: boolean;
  divergenceSummary: string;
}

function parseManifest(manifestPath: string): ForkEntry[] {
  const content = readFileSync(manifestPath, 'utf-8');
  const entries: ForkEntry[] = [];

  for (const line of content.split('\n')) {
    const match = line.match(/^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|/);
    if (!match) continue;

    const forkPath = match[1];
    const originRaw = match[2].trim();

    if (originRaw.startsWith('N/A')) continue;

    const extractedMatch = originRaw.match(/Extracted from\s+`([^`]+)`/);
    if (extractedMatch) {
      entries.push({ fork: forkPath, origin: extractedMatch[1] });
      continue;
    }

    const pathMatch = originRaw.match(/`([^`]+)`/);
    if (pathMatch) {
      entries.push({ fork: forkPath, origin: pathMatch[1] });
    }
  }

  return entries;
}

function resolveForkPath(fork: string): string {
  return join(PROJECT_ROOT, 'src', 'destro', fork);
}

function resolveOriginPath(origin: string): string {
  return join(PROJECT_ROOT, 'src', origin);
}

function readFirstMeaningfulLine(lines: string[]): string {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('// forked from')) continue;
    if (trimmed.startsWith('// Destro agent')) continue;
    return trimmed;
  }
  return '';
}

function checkDrift(entry: ForkEntry): DriftResult | null {
  const forkPath = resolveForkPath(entry.fork);
  const originPath = resolveOriginPath(entry.origin);

  if (!existsSync(forkPath)) {
    console.error(`  MISSING fork: ${forkPath}`);
    return null;
  }
  if (!existsSync(originPath)) {
    console.error(`  MISSING origin: ${originPath}`);
    return null;
  }

  const forkContent = readFileSync(forkPath, 'utf-8');
  const originContent = readFileSync(originPath, 'utf-8');

  const forkLines = forkContent.split('\n');
  const originLines = originContent.split('\n');

  const linesInFork = forkLines.length;
  const linesInOrigin = originLines.length;

  const forkFirst = readFirstMeaningfulLine(forkLines);
  const originFirst = readFirstMeaningfulLine(originLines);
  const firstLineMatch = forkFirst === originFirst;

  let divergenceSummary: string;
  if (!firstLineMatch && linesInFork !== linesInOrigin) {
    divergenceSummary = `first line differs AND line counts differ (fork: ${linesInFork}, origin: ${linesInOrigin})`;
  } else if (!firstLineMatch) {
    divergenceSummary = `first line differs (counts match: ${linesInFork} lines)`;
  } else if (linesInFork !== linesInOrigin) {
    const diff = linesInFork - linesInOrigin;
    const pct = ((Math.abs(diff) / linesInOrigin) * 100).toFixed(1);
    divergenceSummary = `line counts differ: fork=${linesInFork}, origin=${linesInOrigin} (${diff > 0 ? '+' : ''}${diff}, ${pct}%)`;
  } else {
    divergenceSummary = 'no divergence detected';
  }

  return {
    fork: entry.fork,
    origin: entry.origin,
    linesInFork,
    linesInOrigin,
    firstLineMatch,
    divergenceSummary,
  };
}

function run(): void {
  const manifestPath = join(__dirname, 'FORK-MANIFEST.md');

  if (!existsSync(manifestPath)) {
    console.error(`FORK-MANIFEST.md not found at ${manifestPath}`);
    process.exit(1);
  }

  const entries = parseManifest(manifestPath);

  if (entries.length === 0) {
    console.log('No fork entries with core origins found in FORK-MANIFEST.md');
    return;
  }

  const results: DriftResult[] = [];

  for (const entry of entries) {
    console.log(`\n─── ${entry.fork} ───`);
    const result = checkDrift(entry);
    if (result) {
      results.push(result);
      console.log(`  FORK:              ${result.fork}`);
      console.log(`  ORIGIN:            ${result.origin}`);
      console.log(`  lines_in_fork:     ${result.linesInFork}`);
      console.log(`  lines_in_origin:   ${result.linesInOrigin}`);
      console.log(`  first_line_match:  ${result.firstLineMatch}`);
      console.log(`  divergence:        ${result.divergenceSummary}`);
    }
  }

  const diverged = results.filter(r => r.divergenceSummary !== 'no divergence detected');

  console.log('');
  console.log('═'.repeat(60));
  console.log(`${results.length} forks checked, ${diverged.length} diverged`);
  console.log('═'.repeat(60));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''))) {
  run();
}
