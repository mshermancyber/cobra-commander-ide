import type { Config, WorkerPoolEntry } from './config.js';

interface ComplexitySignals {
  fileCount: number;       // files mentioned in task
  hasRefactor: boolean;    // refactoring keywords
  hasTest: boolean;        // test-related keywords
  hasMultiFile: boolean;   // mentions multiple files/modules
  hasArchitecture: boolean; // architecture/design keywords
  lineEstimate: number;    // rough estimate of lines to change
  taskLength: number;      // length of task description
}

const FAST_KEYWORDS = ['rename', 'typo', 'fix import', 'update version', 'add comment', 'format', 'lint fix', 'simple'];
const HEAVY_KEYWORDS = ['refactor', 'redesign', 'rewrite', 'migrate', 'architecture', 'implement from scratch', 'complex', 'multi-file', 'across all'];

function analyzeComplexity(task: string, context: string): ComplexitySignals {
  const combined = (task + ' ' + context).toLowerCase();
  const fileMatches = combined.match(/\b[\w/-]+\.(ts|js|py|go|tsx|jsx)\b/g) || [];

  return {
    fileCount: new Set(fileMatches).size,
    hasRefactor: HEAVY_KEYWORDS.some(k => combined.includes(k)),
    hasTest: /\b(test|spec|assert|expect|describe|it\()\b/.test(combined),
    hasMultiFile: fileMatches.length > 2 || /\b(all files|every file|across|multiple)\b/.test(combined),
    hasArchitecture: /\b(architect|design|pattern|interface|abstract|module system)\b/.test(combined),
    lineEstimate: Math.min(fileMatches.length * 50, 500),
    taskLength: task.length,
  };
}

export function routeTask(task: string, context: string, config: Config): WorkerPoolEntry {
  if (!config.costAwareRouting || config.workerPool.length <= 1) {
    return config.workerPool[0];
  }

  const signals = analyzeComplexity(task, context);

  // Score: 0-2 = fast, 3-5 = standard, 6+ = heavy
  let score = 0;
  if (signals.fileCount > 3) score += 2;
  else if (signals.fileCount > 1) score += 1;
  if (signals.hasRefactor) score += 3;
  if (signals.hasMultiFile) score += 2;
  if (signals.hasArchitecture) score += 2;
  if (signals.hasTest) score += 1;
  if (signals.taskLength > 1000) score += 1;
  if (signals.taskLength > 3000) score += 1;

  // Check for fast-track keywords
  if (FAST_KEYWORDS.some(k => task.toLowerCase().includes(k)) && score < 3) {
    score = 0;
  }

  let targetTier: 'fast' | 'standard' | 'heavy';
  if (score <= 2) targetTier = 'fast';
  else if (score <= 5) targetTier = 'standard';
  else targetTier = 'heavy';

  // Find best matching worker from pool
  const match = config.workerPool.find(w => w.tier === targetTier);
  if (match) return match;

  // Fallback: if no worker of that tier, use the closest available
  const tierOrder: Array<'fast' | 'standard' | 'heavy'> = ['fast', 'standard', 'heavy'];
  const targetIdx = tierOrder.indexOf(targetTier);

  // Try adjacent tiers with bounds checking
  for (let offset = 1; offset < tierOrder.length; offset++) {
    const upIdx = targetIdx + offset;
    const downIdx = targetIdx - offset;
    if (upIdx < tierOrder.length) {
      const up = config.workerPool.find(w => w.tier === tierOrder[upIdx]);
      if (up) return up;
    }
    if (downIdx >= 0) {
      const down = config.workerPool.find(w => w.tier === tierOrder[downIdx]);
      if (down) return down;
    }
  }

  return config.workerPool[0];
}
