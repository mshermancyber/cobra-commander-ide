interface ModelStats {
  model: string;
  delegations: number;
  successes: number;
  failures: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalDurationMs: number;
  avgDurationMs: number;
  successRate: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  estimatedCacheSavings: number;
}

const stats = new Map<string, {
  delegations: number;
  successes: number;
  failures: number;
  tokensIn: number;
  tokensOut: number;
  totalDurationMs: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}>();

export function recordDelegation(
  model: string,
  status: 'completed' | 'failed',
  tokensIn: number,
  tokensOut: number,
  durationMs: number,
  cacheHitTokens = 0,
  cacheMissTokens = 0,
): void {
  const existing = stats.get(model) || {
    delegations: 0, successes: 0, failures: 0,
    tokensIn: 0, tokensOut: 0, totalDurationMs: 0,
    cacheHitTokens: 0, cacheMissTokens: 0,
  };

  existing.delegations++;
  if (status === 'completed') existing.successes++;
  else existing.failures++;
  existing.tokensIn += tokensIn;
  existing.tokensOut += tokensOut;
  existing.totalDurationMs += durationMs;
  existing.cacheHitTokens += cacheHitTokens;
  existing.cacheMissTokens += cacheMissTokens;

  stats.set(model, existing);
}

/** Calculate estimated cost savings from prompt caching */
function estimateCacheSavings(cacheHitTokens: number, cacheMissTokens: number): number {
  // Rough estimates: standard input ~$0.27/MTok, cached input ~$0.14/MTok
  const standardCost = ((cacheHitTokens + cacheMissTokens) / 1_000_000) * 0.27;
  const cachedCost = (cacheHitTokens / 1_000_000) * 0.14 + (cacheMissTokens / 1_000_000) * 0.27;
  return Math.max(0, Math.round((standardCost - cachedCost) * 10000) / 10000);
}

export function getModelStats(): ModelStats[] {
  return Array.from(stats.entries()).map(([model, s]) => ({
    model,
    delegations: s.delegations,
    successes: s.successes,
    failures: s.failures,
    totalTokensIn: s.tokensIn,
    totalTokensOut: s.tokensOut,
    totalDurationMs: s.totalDurationMs,
    avgDurationMs: s.delegations > 0 ? Math.round(s.totalDurationMs / s.delegations) : 0,
    successRate: s.delegations > 0 ? Math.round((s.successes / s.delegations) * 100) : 0,
    cacheHitTokens: s.cacheHitTokens,
    cacheMissTokens: s.cacheMissTokens,
    estimatedCacheSavings: estimateCacheSavings(s.cacheHitTokens, s.cacheMissTokens),
  }));
}

export function resetStats(): void {
  stats.clear();
}

/** Get total cache savings across all models */
export function getTotalCacheSavings(): { hitTokens: number; missTokens: number; estimatedSavings: number } {
  let hitTokens = 0;
  let missTokens = 0;

  for (const [, s] of stats) {
    hitTokens += s.cacheHitTokens;
    missTokens += s.cacheMissTokens;
  }

  return {
    hitTokens,
    missTokens,
    estimatedSavings: estimateCacheSavings(hitTokens, missTokens),
  };
}
