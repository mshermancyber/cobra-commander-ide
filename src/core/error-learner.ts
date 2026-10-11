import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { VerificationError } from './verification.js';

export interface ErrorPattern {
  model: string;
  errorType: string;  // 'typescript' | 'eslint' | 'test' | 'runtime' | 'timeout'
  errorCode?: string; // e.g., 'TS2304', 'TS2345'
  frequency: number;
  lastSeen: string;   // ISO date
  commonFixes: string[];  // what worked to fix it
}

interface ErrorPatternsData {
  patterns: ErrorPattern[];
  modelStats: Record<string, { total: number; errors: number }>;
}

let patternsData: ErrorPatternsData = { patterns: [], modelStats: {} };
let dataPath: string = '';

function ensureDataPath(workDir?: string): string {
  if (dataPath) return dataPath;
  const dir = workDir || process.cwd();
  const cobraDir = join(dir, '.cobra-commander');
  if (!existsSync(cobraDir)) {
    mkdirSync(cobraDir, { recursive: true });
  }
  dataPath = join(cobraDir, 'error-patterns.json');
  return dataPath;
}

function loadData(workDir?: string): ErrorPatternsData {
  const path = ensureDataPath(workDir);
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as ErrorPatternsData;
      patternsData = parsed;
      return parsed;
    } catch {
      // Corrupted file, reset
    }
  }
  patternsData = { patterns: [], modelStats: {} };
  return patternsData;
}

function saveData(): void {
  if (!dataPath) return;
  const dir = resolve(dataPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(dataPath, JSON.stringify(patternsData, null, 2), 'utf-8');
}

/**
 * Record an error occurrence for a model.
 */
export function recordError(model: string, error: VerificationError, workDir?: string): void {
  loadData(workDir);

  const errorType = error.source || 'runtime';
  const errorCode = error.code;

  // Update model stats
  if (!patternsData.modelStats[model]) {
    patternsData.modelStats[model] = { total: 0, errors: 0 };
  }
  patternsData.modelStats[model].errors++;

  // Find or create pattern
  const existing = patternsData.patterns.find(
    p => p.model === model && p.errorType === errorType && p.errorCode === errorCode,
  );

  if (existing) {
    existing.frequency++;
    existing.lastSeen = new Date().toISOString();
  } else {
    patternsData.patterns.push({
      model,
      errorType,
      errorCode,
      frequency: 1,
      lastSeen: new Date().toISOString(),
      commonFixes: [],
    });
  }

  saveData();
}

/**
 * Record a successful fix for an error pattern.
 */
export function recordFix(model: string, errorCode: string, fix: string, workDir?: string): void {
  loadData(workDir);

  // Find matching patterns for this model and error code
  const matches = patternsData.patterns.filter(
    p => p.model === model && p.errorCode === errorCode,
  );

  for (const pattern of matches) {
    if (!pattern.commonFixes.includes(fix)) {
      pattern.commonFixes.push(fix);
      // Keep only the last 5 fixes
      if (pattern.commonFixes.length > 5) {
        pattern.commonFixes = pattern.commonFixes.slice(-5);
      }
    }
  }

  saveData();
}

/**
 * Get frequent error patterns for a model, sorted by frequency.
 */
export function getModelWeaknesses(model: string, workDir?: string): ErrorPattern[] {
  loadData(workDir);
  return patternsData.patterns
    .filter(p => p.model === model)
    .sort((a, b) => b.frequency - a.frequency);
}

/**
 * Generate a preventive prompt addition warning about common mistakes for a model.
 */
export function getPreventivePrompt(model: string, workDir?: string): string {
  loadData(workDir);
  const weaknesses = getModelWeaknesses(model, workDir);

  if (weaknesses.length === 0) return '';

  const topWeaknesses = weaknesses.slice(0, 3);
  const lines: string[] = ['\n## Known Error Patterns for This Model'];

  for (const w of topWeaknesses) {
    const codeStr = w.errorCode ? ` ${w.errorCode}` : '';
    lines.push(`- Avoid: ${w.errorType} error${codeStr} (occurred ${w.frequency} times)`);
    if (w.commonFixes.length > 0) {
      lines.push(`  Fix: ${w.commonFixes[0]}`);
    }
  }

  return lines.join('\n');
}

/**
 * Get reliability stats for a model.
 */
export function getModelReliability(
  model: string,
  workDir?: string,
): { total: number; errors: number; rate: number } {
  loadData(workDir);
  const stats = patternsData.modelStats[model];
  if (!stats || stats.total === 0) {
    return { total: 0, errors: 0, rate: 0 };
  }
  return {
    total: stats.total,
    errors: stats.errors,
    rate: stats.total > 0 ? stats.errors / stats.total : 0,
  };
}

/**
 * Record a successful task completion (increments total count).
 */
export function recordSuccess(model: string, workDir?: string): void {
  loadData(workDir);
  if (!patternsData.modelStats[model]) {
    patternsData.modelStats[model] = { total: 0, errors: 0 };
  }
  patternsData.modelStats[model].total++;
  saveData();
}

/**
 * Get all error patterns data (for CLI display).
 */
export function getAllErrorPatterns(workDir?: string): ErrorPatternsData {
  loadData(workDir);
  return patternsData;
}

/**
 * Clear all error patterns data.
 */
export function clearErrorPatterns(workDir?: string): void {
  loadData(workDir);
  patternsData = { patterns: [], modelStats: {} };
  saveData();
}
