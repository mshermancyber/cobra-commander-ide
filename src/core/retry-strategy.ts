import type { Config, WorkerPoolEntry } from './config.js';

export interface RetryStrategy {
  name: string;
  description: string;
  apply(task: string, context: string, error: string, attempt: number): {
    modifiedTask: string;
    modifiedContext: string;
    modelOverride?: string;
  };
}

/**
 * ErrorFocused — default strategy. Feeds the error back with structured fix instructions.
 */
class ErrorFocusedStrategy implements RetryStrategy {
  name = 'ErrorFocused';
  description = 'Feed error back with structured fix instructions';

  apply(task: string, context: string, error: string, _attempt: number): {
    modifiedTask: string;
    modifiedContext: string;
    modelOverride?: string;
  } {
    const modifiedContext = `${context}\n\n## RETRY — Previous Error\n${error}\n\nFix the errors above. Do not introduce new changes.`;
    return { modifiedTask: task, modifiedContext };
  }
}

/**
 * SimplifiedApproach — on 2nd retry, simplifies the task to focus only on fixing errors.
 */
class SimplifiedApproachStrategy implements RetryStrategy {
  name = 'SimplifiedApproach';
  description = 'Simplify task to focus only on fixing errors';

  apply(task: string, context: string, error: string, _attempt: number): {
    modifiedTask: string;
    modifiedContext: string;
    modelOverride?: string;
  } {
    const modifiedTask = `Fix the errors in the code. Do NOT refactor or improve other code.\n\nOriginal task: ${task}`;
    const modifiedContext = `${context}\n\n## RETRY — Focused Fix\nFocus ONLY on fixing the errors listed below. Do not refactor or improve other code.\n\n${error}`;
    return { modifiedTask, modifiedContext };
  }
}

/**
 * StepByStep — breaks the task into smaller steps.
 */
class StepByStepStrategy implements RetryStrategy {
  name = 'StepByStep';
  description = 'Break task into smaller steps';

  apply(task: string, context: string, error: string, _attempt: number): {
    modifiedTask: string;
    modifiedContext: string;
    modelOverride?: string;
  } {
    const modifiedTask = `Implement this change in 3 steps:
1) Read all relevant files to understand the current code
2) Make minimal changes to fix the errors
3) Verify each change compiles and works

Original task: ${task}`;
    const modifiedContext = `${context}\n\n## RETRY — Step by Step\n${error}\n\nFollow the 3-step process above. Read files first, then make minimal changes.`;
    return { modifiedTask, modifiedContext };
  }
}

/**
 * ModelFallback — switches to a different model from the worker pool.
 */
class ModelFallbackStrategy implements RetryStrategy {
  name = 'ModelFallback';
  description = 'Switch to a different model from the worker pool';
  private currentModel: string;
  private workerPool: WorkerPoolEntry[];

  constructor(currentModel: string, workerPool: WorkerPoolEntry[]) {
    this.currentModel = currentModel;
    this.workerPool = workerPool;
  }

  apply(task: string, context: string, error: string, _attempt: number): {
    modifiedTask: string;
    modifiedContext: string;
    modelOverride?: string;
  } {
    const fallback = getModelFallback(this.currentModel, this.workerPool);
    const modifiedContext = `${context}\n\n## RETRY — Model Fallback\n${error}\n\nAttempting with a different model.`;
    return {
      modifiedTask: task,
      modifiedContext,
      modelOverride: fallback || undefined,
    };
  }
}

/**
 * CleanSlate — reverts changes (git checkout) and retries from scratch.
 */
class CleanSlateStrategy implements RetryStrategy {
  name = 'CleanSlate';
  description = 'Revert changes and retry from scratch';

  apply(task: string, context: string, error: string, _attempt: number): {
    modifiedTask: string;
    modifiedContext: string;
    modelOverride?: string;
  } {
    const modifiedTask = `Start fresh. The previous attempt failed. Read the files carefully before making any changes.\n\nOriginal task: ${task}`;
    const modifiedContext = `${context}\n\n## RETRY — Clean Slate\nPrevious attempt failed with:\n${error}\n\nAll previous changes have been reverted. Start from scratch. Read files first, plan your approach, then implement carefully.`;
    return { modifiedTask, modifiedContext };
  }
}

/**
 * Get the appropriate retry strategy based on attempt number and error.
 */
export function getRetryStrategy(
  attempt: number,
  error: string,
  config: Config,
  currentModel?: string,
): RetryStrategy {
  const workerPool = config.workerPool;

  if (attempt >= 4) {
    // After 3+ failures, try clean slate
    return new CleanSlateStrategy();
  }

  if (attempt >= 3) {
    // On 3rd retry, try model fallback
    return new ModelFallbackStrategy(currentModel || config.worker.model, workerPool);
  }

  if (attempt === 2) {
    // On 2nd retry, use simplified approach
    return new SimplifiedApproachStrategy();
  }

  // On 1st retry, use error-focused (default)
  return new ErrorFocusedStrategy();
}

/**
 * Pick the next model in the fallback chain.
 */
export function getModelFallback(
  currentModel: string,
  workerPool: WorkerPoolEntry[],
): string | null {
  if (workerPool.length <= 1) return null;

  // Find current model index
  const currentIdx = workerPool.findIndex(
    w => w.provider.model === currentModel || w.name === currentModel,
  );

  if (currentIdx === -1) {
    // Current model not in pool, return first different model
    return workerPool[0].provider.model;
  }

  // Try next model in pool (wrap around)
  for (let i = 1; i < workerPool.length; i++) {
    const nextIdx = (currentIdx + i) % workerPool.length;
    const next = workerPool[nextIdx];
    if (next.provider.model !== currentModel) {
      return next.provider.model;
    }
  }

  return null;
}

/**
 * Build a retry prompt using the given strategy.
 */
export function buildRetryPrompt(
  strategy: RetryStrategy,
  task: string,
  context: string,
  error: string,
  attempt: number,
): { task: string; context: string; model?: string } {
  const result = strategy.apply(task, context, error, attempt);
  return {
    task: result.modifiedTask,
    context: result.modifiedContext,
    model: result.modelOverride,
  };
}
