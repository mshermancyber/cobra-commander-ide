// forked from core/retry-strategy.ts @ 2026-07-04 — DOWNSTREAM fork, do not backport to core

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
 * ModelFallback — switches to a different model.
 */
class ModelFallbackStrategy implements RetryStrategy {
  name = 'ModelFallback';
  description = 'Switch to a different model';
  private currentModel: string;
  private fallbackModel: string;

  constructor(currentModel: string, fallbackModel: string) {
    this.currentModel = currentModel;
    this.fallbackModel = fallbackModel;
  }

  apply(task: string, context: string, error: string, _attempt: number): {
    modifiedTask: string;
    modifiedContext: string;
    modelOverride?: string;
  } {
    const fallback = getDestroModelFallback(this.currentModel, this.fallbackModel);
    const modifiedContext = `${context}\n\n## RETRY — Model Fallback\n${error}\n\nAttempting with a different model.`;
    return {
      modifiedTask: task,
      modifiedContext,
      modelOverride: fallback || undefined,
    };
  }
}

/**
 * BackoffAndReask — tells the LLM to rephrase the question differently
 * rather than retrying the same approach.
 */
class BackoffAndReaskStrategy implements RetryStrategy {
  name = 'BackoffAndReask';
  description = 'Rephrase the question differently instead of retrying the same approach';

  apply(task: string, context: string, error: string, _attempt: number): {
    modifiedTask: string;
    modifiedContext: string;
    modelOverride?: string;
  } {
    const modifiedTask = `Your previous approach failed. Do NOT retry the same solution.
Instead, rephrase the problem and try a completely different strategy.

Original task: ${task}`;
    const modifiedContext = `${context}\n\n## RETRY — Backoff and Reask\nThe previous attempt failed with:\n${error}\n\nRephrase the question. Take a different approach. Do not repeat what failed before.`;
    return { modifiedTask, modifiedContext };
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
 * Get the appropriate Destro retry strategy based on attempt number and error.
 * Uses BackoffAndReask at attempt 3+ (no model fallback in the default chain).
 */
export function getDestroRetryStrategy(
  attempt: number,
  error: string,
  currentModel?: string,
  fallbackModel?: string,
): RetryStrategy {
  if (attempt >= 4) {
    // After 3+ failures, try clean slate
    return new CleanSlateStrategy();
  }

  if (attempt >= 3) {
    // On 3rd retry, tell the LLM to rephrase — don't repeat the same approach
    return new BackoffAndReaskStrategy();
  }

  if (attempt === 2) {
    // On 2nd retry, use simplified approach
    return new SimplifiedApproachStrategy();
  }

  // On 1st retry, use error-focused (default)
  return new ErrorFocusedStrategy();
}

/**
 * Pick a fallback model. Returns the fallback model if it differs from current.
 */
export function getDestroModelFallback(
  currentModel: string,
  fallbackModel: string,
): string | null {
  if (!fallbackModel || fallbackModel === currentModel) return null;
  return fallbackModel;
}

/**
 * Build a retry prompt using the given strategy.
 */
export function buildDestroRetryPrompt(
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
