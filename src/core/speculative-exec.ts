/**
 * Result returned by speculativeStart.
 */
export interface SpecResult<T = unknown, S = unknown> {
  /** The resolved value from the blocking promise. */
  blocking: T;
  /**
   * The result of the speculative task.
   * `null` when the blocking promise failed (rejected or non-zero exit)
   * and the speculative result was discarded.
   */
  speculative: S | null;
  /** Whether the speculative result was discarded. */
  specDiscarded: boolean;
}

/**
 * Start a speculative work item while a blocking command (e.g., `tsc`, build)
 * is in flight.
 *
 * Both promises are started concurrently, but the speculative result is only
 * kept if the blocking promise **succeeds**. If the blocking promise rejects
 * (or, for number-typed resolutions, resolves with a non-zero exit code) the
 * speculative result is discarded and `speculative` is set to `null`.
 *
 * This is useful for optimising pipelines where a compilation step runs
 * while the worker begins reading the next task context — if compilation
 * fails the speculative work is thrown away.
 *
 * @param blockingPromise - The promise whose success gates the speculative result.
 * @param nextTask        - A factory returning the speculative work promise.
 * @returns A SpecResult with both results.
 */
export async function speculativeStart<T = unknown, S = unknown>(
  blockingPromise: Promise<T>,
  nextTask: () => Promise<S>,
): Promise<SpecResult<T, S>> {
  // Launch the speculative task immediately — don't wait for the blocker.
  const specPromise = nextTask();

  let blocking: T = undefined as unknown as T;
  try {
    blocking = await blockingPromise;
  } catch {
    // Blocking promise rejected — discard speculative and rethrow.
    try { await specPromise; } catch { /* discard */ }
    throw new Error('Blocking promise failed — speculative result discarded');
  }

  // Treat non-zero exit codes as failures when the value is a number.
  if (typeof blocking === 'number' && blocking !== 0) {
    try { await specPromise; } catch { /* discard */ }
    throw new Error('Blocking promise failed — speculative result discarded');
  }

  // Blocking succeeded — keep the speculative result.
  let speculative: S;
  let specDiscarded = false;
  try {
    speculative = await specPromise;
  } catch {
    speculative = null as unknown as S;
    specDiscarded = true;
  }

  return { blocking, speculative, specDiscarded };
}
