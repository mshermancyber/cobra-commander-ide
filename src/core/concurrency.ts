/**
 * Run an async function over an array of items with bounded concurrency.
 * At most `concurrency` promises will be in-flight at any time.
 * Results preserve the input order.
 */
export async function boundedParallel<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  if (concurrency <= 0) {
    throw new Error('concurrency must be >= 1');
  }

  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  // Launch up to `concurrency` workers
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, items.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}
