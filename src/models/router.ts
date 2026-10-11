import type { Config, WorkerPoolEntry, ProviderConfig } from '../core/config.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export type TaskCategory =
  | 'code-generation'   // Writing new code from scratch
  | 'code-editing'      // Modifying existing code
  | 'code-review'       // Reviewing/analyzing code for issues
  | 'chat'              // General conversation / Q&A
  | 'completion'        // Inline tab-completion suggestions
  | 'analysis'          // Deep code analysis, architecture review
  | 'refactoring'       // Large-scale code restructuring
  | 'documentation'     // Writing docs, comments, READMEs
  | 'testing'           // Writing tests, test analysis
  | 'debugging'         // Debugging errors, stack traces
  | 'security'          // Security scanning and vulnerability analysis
  | 'configuration'     // Config files, CI/CD, infrastructure
  | 'data-processing'   // SQL queries, data transforms
  | 'unknown';          // Fallback

export interface ModelCapability {
  modelName: string;
  /** Task categories this model excels at */
  strengths: TaskCategory[];
  /** Task categories this model can handle but isn't optimal */
  adequate: TaskCategory[];
  /** Relative cost multiplier (1.0 = baseline) */
  costMultiplier: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** Maximum context window in tokens */
  maxContextTokens: number;
  /** Does this model support tool calling? */
  supportsTools: boolean;
  /** Does this model support vision? */
  supportsVision: boolean;
  /** Minimum task complexity (0-10) this model should handle */
  minComplexity: number;
  /** Maximum task complexity (0-10) this model should handle */
  maxComplexity: number;
  /** Tier for task routing */
  tier: 'fast' | 'standard' | 'heavy';
}

export interface ModelRoute {
  /** Selected model name */
  model: string;
  /** Provider configuration */
  provider: ProviderConfig;
  /** Task category this was routed for */
  taskCategory: TaskCategory;
  /** Why this model was selected */
  reason: string;
  /** Confidence in the routing decision (0-1) */
  confidence: number;
  /** Estimated cost for this task */
  estimatedCost: number;
  /** Estimated latency for this task */
  estimatedLatencyMs: number;
}

export interface FallbackEntry {
  /** The model that failed */
  failedModel: string;
  /** The error/reason for failure */
  failureReason: string;
  /** The fallback model to use */
  fallbackModel: string;
  /** Cooldown period in ms before retrying the failed model */
  cooldownMs: number;
}

export interface ModelPerformanceMetrics {
  modelName: string;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  avgLatencyMs: number;
  avgTokensPerCall: number;
  totalCost: number;
  lastUsedAt: number;
  failureReasons: Map<string, number>;
}

export interface RoutingConfig {
  /** Enable cost optimization (route cheap tasks to cheap models) */
  costOptimization: boolean;
  /** Enable latency optimization (route urgent tasks to fast models) */
  latencyOptimization: boolean;
  /** Maximum spend budget (in USD, approximate) */
  maxBudget?: number;
  /** Fallback chain: ordered list of model names */
  fallbackChain?: string[];
  /** Cooldown period for failed models (ms) */
  failureCooldownMs: number;
  /** Maximum consecutive failures before model is quarantined */
  maxConsecutiveFailures: number;
  /** Current spend tracking */
  currentSpend?: number;
}

// ─── Model Capability Matrix ───────────────────────────────────────────────

/**
 * Predefined capability matrix for known models. Unlisted models fall back to the
 * tier implied by their endpoint, so an unknown name still routes sensibly.
 */
const MODEL_CAPABILITIES: ModelCapability[] = [
  {
    modelName: 'gpt-5.1',
    strengths: ['code-generation', 'code-editing', 'refactoring', 'analysis', 'debugging'],
    adequate: ['code-review', 'testing', 'documentation', 'configuration', 'security'],
    costMultiplier: 1.0,
    avgLatencyMs: 2500,
    maxContextTokens: 128_000,
    supportsTools: true,
    supportsVision: false,
    minComplexity: 3,
    maxComplexity: 10,
    tier: 'heavy',
  },
  {
    modelName: 'gpt-5.1-mini',
    strengths: ['chat', 'code-review', 'documentation', 'testing'],
    adequate: ['code-editing', 'analysis', 'debugging', 'configuration'],
    costMultiplier: 0.3,
    avgLatencyMs: 1200,
    maxContextTokens: 64_000,
    supportsTools: true,
    supportsVision: false,
    minComplexity: 0,
    maxComplexity: 7,
    tier: 'standard',
  },
  {
    modelName: 'claude-opus-4-20250514',
    strengths: ['code-generation', 'code-review', 'analysis', 'refactoring', 'security'],
    adequate: ['code-editing', 'testing', 'documentation', 'debugging', 'configuration', 'chat'],
    costMultiplier: 3.5,
    avgLatencyMs: 4000,
    maxContextTokens: 200_000,
    supportsTools: true,
    supportsVision: true,
    minComplexity: 5,
    maxComplexity: 10,
    tier: 'heavy',
  },
  {
    modelName: 'claude-sonnet-4-20250514',
    strengths: ['code-generation', 'code-editing', 'code-review', 'debugging'],
    adequate: ['analysis', 'refactoring', 'documentation', 'testing', 'chat'],
    costMultiplier: 1.5,
    avgLatencyMs: 2000,
    maxContextTokens: 200_000,
    supportsTools: true,
    supportsVision: true,
    minComplexity: 2,
    maxComplexity: 8,
    tier: 'standard',
  },
  {
    modelName: 'claude-haiku-4-20250514',
    strengths: ['completion', 'chat', 'documentation'],
    adequate: ['code-editing', 'testing', 'configuration'],
    costMultiplier: 0.2,
    avgLatencyMs: 500,
    maxContextTokens: 200_000,
    supportsTools: true,
    supportsVision: false,
    minComplexity: 0,
    maxComplexity: 4,
    tier: 'fast',
  },
  {
    modelName: 'gpt-4o',
    strengths: ['code-generation', 'code-editing', 'analysis', 'chat'],
    adequate: ['code-review', 'refactoring', 'testing', 'documentation', 'debugging', 'security'],
    costMultiplier: 2.0,
    avgLatencyMs: 1800,
    maxContextTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    minComplexity: 3,
    maxComplexity: 9,
    tier: 'standard',
  },
  {
    modelName: 'gpt-4o-mini',
    strengths: ['chat', 'completion', 'documentation'],
    adequate: ['code-editing', 'testing', 'configuration', 'code-review'],
    costMultiplier: 0.1,
    avgLatencyMs: 400,
    maxContextTokens: 128_000,
    supportsTools: true,
    supportsVision: true,
    minComplexity: 0,
    maxComplexity: 5,
    tier: 'fast',
  },
  {
    modelName: 'gemini-2.5-pro',
    strengths: ['code-generation', 'analysis', 'refactoring'],
    adequate: ['code-editing', 'code-review', 'testing', 'documentation', 'debugging', 'security'],
    costMultiplier: 1.2,
    avgLatencyMs: 2200,
    maxContextTokens: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    minComplexity: 2,
    maxComplexity: 9,
    tier: 'standard',
  },
];

// ─── Default Routing Config ────────────────────────────────────────────────

const DEFAULT_ROUTING: RoutingConfig = {
  costOptimization: true,
  latencyOptimization: false,
  failureCooldownMs: 60_000,
  maxConsecutiveFailures: 3,
  currentSpend: 0,
};

// ─── Task Classifier ───────────────────────────────────────────────────────

interface TaskFeatures {
  category: TaskCategory;
  complexity: number;
  estimatedTokens: number;
  isUrgent: boolean;
  requiresTools: boolean;
  requiresVision: boolean;
  keywords: string[];
}

/**
 * Classify a task into a category and extract features for routing.
 */
export function classifyTask(
  task: string,
  context?: string,
): TaskFeatures {
  const combined = (task + ' ' + (context || '')).toLowerCase();
  const keywords: string[] = [];
  let category: TaskCategory = 'unknown';
  let complexity = 3;
  let estimatedTokens = Math.ceil(task.length / 4);

  // ── Category detection ──

  // Code generation: write, create, build, implement, scaffold
  if (/\b(write|create|build|implement|scaffold|generate|add)\b.*\b(code|file|module|class|function|component|app|api|endpoint|route|interface)\b/.test(combined)) {
    category = 'code-generation';
    complexity += 3;
    keywords.push('code-generation');
  }
  // Code editing: modify, change, update, fix, correct, edit
  else if (/\b(modify|change|update|fix|correct|edit|patch|adjust|rename|remove|replace|add\s+import|change\s+import)\b/.test(combined)) {
    category = 'code-editing';
    complexity += 1;
    keywords.push('code-editing');
  }
  // Refactoring
  else if (/\b(refactor|restructure|reorganize|rewrite|redesign|migrate|extract)\b/.test(combined)) {
    category = 'refactoring';
    complexity += 5;
    keywords.push('refactoring');
  }
  // Testing
  else if (/\b(test|spec|unit test|integration test|e2e|coverage|assert|expect|describe|it\()\b/.test(combined)) {
    category = 'testing';
    complexity += 2;
    keywords.push('testing');
  }
  // Code review
  else if (/\b(review|audit|inspect|check|examine|assess|evaluate)\b/.test(combined)) {
    category = 'code-review';
    complexity += 1;
    keywords.push('code-review');
  }
  // Analysis
  else if (/\b(analyze|analysis|investigate|understand|explain|how does|what does|why does)\b/.test(combined)) {
    category = 'analysis';
    complexity += 2;
    keywords.push('analysis');
  }
  // Debugging
  else if (/\b(debug|error|bug|crashe?|exception|stack trace|traceback|why.*fail|not working)\b/.test(combined)) {
    category = 'debugging';
    complexity += 2;
    keywords.push('debugging');
  }
  // Documentation
  else if (/\b(doc|document|readme|comment|jsdoc|explain the code|describe)\b/.test(combined)) {
    category = 'documentation';
    complexity += 0;
    keywords.push('documentation');
  }
  // Security
  else if (/\b(security|vulnerability|vuln|cve|exploit|injection|xss|csrf|auth|sql injection|penetration)\b/.test(combined)) {
    category = 'security';
    complexity += 3;
    keywords.push('security');
  }
  // Configuration
  else if (/\b(config|env|environment|docker|ci|cd|pipeline|deploy|yaml|json|toml|makefile)\b/.test(combined)) {
    category = 'configuration';
    complexity += 1;
    keywords.push('configuration');
  }
  // Data processing
  else if (/\b(sql|query|data|transform|csv|json|parse|extract data|aggregate)\b/.test(combined)) {
    category = 'data-processing';
    complexity += 2;
    keywords.push('data-processing');
  }
  // Chat / general conversation
  else if (task.length < 100 && !/\b(code|file|implement|write|create|modify|fix|bug|error)\b/.test(combined)) {
    category = 'chat';
    keywords.push('chat');
  }

  // ── Complexity heuristics ──

  if (task.length > 2000) complexity += 2;
  if (task.length > 5000) complexity += 2;
  if (context && context.length > 3000) complexity += 1;
  if (/\b(multi[-\s]?file|across|entire|all\s+files|every|multiple|complex|advanced)\b/.test(combined)) complexity += 2;
  if (/\b(simple|easy|quick|trivial|minor|typo)\b/.test(combined)) complexity = Math.max(1, complexity - 3);

  // ── Other features ──

  const isUrgent = /\b(urgent|asap|immediately|critical|emergency|hotfix|now|quick)\b/.test(combined);
  const requiresTools = !/\b(just\s+chat|conversation|tell\s+me|what\s+is|who\s+is|explain\s+concept)\b/.test(combined);
  const requiresVision = /\b(screenshot|image|picture|diagram|mockup|figma|design)\b/.test(combined);

  // ── Complexity clamping ──
  complexity = Math.max(0, Math.min(10, complexity));

  return {
    category,
    complexity,
    estimatedTokens,
    isUrgent,
    requiresTools,
    requiresVision,
    keywords,
  };
}

// ─── Model Router ──────────────────────────────────────────────────────────

export class ModelRouter {
  private capabilities: ModelCapability[];
  private routing: RoutingConfig;
  private performance: Map<string, ModelPerformanceMetrics> = new Map();
  private failureCooldowns: Map<string, number> = new Map(); // modelName -> cooldownUntil
  private failureCounts: Map<string, number> = new Map();     // modelName -> consecutive failures
  private quarantine: Set<string> = new Set();

  constructor(capabilities?: ModelCapability[], routing?: Partial<RoutingConfig>) {
    this.capabilities = capabilities || MODEL_CAPABILITIES;
    this.routing = { ...DEFAULT_ROUTING, ...routing };
  }

  /**
   * Route a task to the optimal model based on task features.
   */
  route(features: TaskFeatures, availableModels?: string[]): ModelRoute {
    const available = availableModels || this.capabilities.map(c => c.modelName);

    // Filter to available, non-quarantined, non-cooldown models
    const now = Date.now();
    const candidates = this.capabilities.filter(c => {
      if (!available.includes(c.modelName)) return false;
      if (this.quarantine.has(c.modelName)) return false;
      const cooldownUntil = this.failureCooldowns.get(c.modelName);
      if (cooldownUntil && now < cooldownUntil) return false;
      return true;
    });

    if (candidates.length === 0) {
      // All models unavailable — fall back to first available
      const firstAvailable = this.capabilities.find(c => available.includes(c.modelName));
      if (!firstAvailable) {
        throw new Error('No available models for routing');
      }
      return this.buildRoute(firstAvailable, features, 'No optimal model available — using first available');
    }

    // Score each candidate
    const scored = candidates.map(model => ({
      model,
      score: this.scoreModel(model, features),
    }));

    scored.sort((a, b) => b.score - a.score);

    const best = scored[0].model;
    return this.buildRoute(best, features, `Best match: ${best.modelName} (score: ${scored[0].score.toFixed(2)})`);
  }

  /**
   * Route using the existing worker pool from config.
   */
  routeFromPool(
    task: string,
    context: string,
    config: Config,
  ): ModelRoute {
    const features = classifyTask(task, context);

    // Map worker pool entries to capabilities
    const poolModelNames = config.workerPool.map(w => w.provider.model);

    // Try to match with capability matrix
    const route = this.route(features, poolModelNames);

    // Override provider with config's provider
    const poolEntry = config.workerPool.find(w => w.provider.model === route.model);
    if (poolEntry) {
      route.provider = { ...poolEntry.provider };
    }

    return route;
  }

  /**
   * Get the fallback chain for a failed model.
   */
  getFallbackChain(failedModel: string, reason: string): string[] {
    // Record failure
    this.recordFailure(failedModel, reason);

    const chain: string[] = [];

    // Use configured fallback chain if available
    if (this.routing.fallbackChain && this.routing.fallbackChain.length > 0) {
      for (const modelName of this.routing.fallbackChain) {
        if (modelName !== failedModel && !this.quarantine.has(modelName)) {
          chain.push(modelName);
        }
      }
      return chain;
    }

    // Auto-generate fallback chain: same tier first, then adjacent tiers
    const failedCap = this.capabilities.find(c => c.modelName === failedModel);
    const tierOrder: Array<ModelCapability['tier']> = ['fast', 'standard', 'heavy'];

    if (failedCap) {
      const tierIdx = tierOrder.indexOf(failedCap.tier);

      // Same tier alternatives first
      const sameTier = this.capabilities.filter(
        c => c.tier === failedCap.tier && c.modelName !== failedModel && !this.quarantine.has(c.modelName)
      );
      chain.push(...sameTier.map(c => c.modelName));

      // Then cheaper tier
      if (tierIdx > 0) {
        const cheaper = this.capabilities.filter(
          c => c.tier === tierOrder[tierIdx - 1] && !this.quarantine.has(c.modelName)
        );
        chain.push(...cheaper.map(c => c.modelName));
      }

      // Then expensive tier
      if (tierIdx < tierOrder.length - 1) {
        const heavier = this.capabilities.filter(
          c => c.tier === tierOrder[tierIdx + 1] && !this.quarantine.has(c.modelName)
        );
        chain.push(...heavier.map(c => c.modelName));
      }
    }

    return chain;
  }

  /**
   * Record a successful call for performance tracking.
   */
  recordSuccess(
    modelName: string,
    latencyMs: number,
    tokensUsed: number,
    cost: number,
  ): void {
    const metrics = this.getOrCreateMetrics(modelName);
    metrics.totalCalls++;
    metrics.successfulCalls++;
    metrics.avgLatencyMs =
      (metrics.avgLatencyMs * (metrics.successfulCalls - 1) + latencyMs) / metrics.successfulCalls;
    metrics.avgTokensPerCall =
      (metrics.avgTokensPerCall * (metrics.successfulCalls - 1) + tokensUsed) / metrics.successfulCalls;
    metrics.totalCost += cost;
    metrics.lastUsedAt = Date.now();

    // Reset failure counts on success
    this.failureCounts.set(modelName, 0);

    // Update current spend
    this.routing.currentSpend = (this.routing.currentSpend || 0) + cost;
  }

  /**
   * Get performance metrics for all models.
   */
  getPerformance(): ModelPerformanceMetrics[] {
    return [...this.performance.values()];
  }

  /**
   * Get performance for a specific model.
   */
  getModelPerformance(modelName: string): ModelPerformanceMetrics | null {
    return this.performance.get(modelName) || null;
  }

  /**
   * Check if the routing budget has been exceeded.
   */
  isBudgetExceeded(): boolean {
    if (this.routing.maxBudget === undefined) return false;
    return (this.routing.currentSpend || 0) >= this.routing.maxBudget;
  }

  /**
   * Reset all performance tracking.
   */
  resetPerformance(): void {
    this.performance.clear();
    this.failureCounts.clear();
    this.failureCooldowns.clear();
    this.quarantine.clear();
    this.routing.currentSpend = 0;
  }

  /**
   * Manually quarantine a model.
   */
  quarantineModel(modelName: string): void {
    this.quarantine.add(modelName);
  }

  /**
   * Remove a model from quarantine.
   */
  releaseModel(modelName: string): void {
    this.quarantine.delete(modelName);
    this.failureCounts.set(modelName, 0);
    this.failureCooldowns.delete(modelName);
  }

  /**
   * Get the list of currently quarantined models.
   */
  getQuarantinedModels(): string[] {
    return [...this.quarantine];
  }

  /**
   * Get the capability matrix.
   */
  getCapabilities(): ModelCapability[] {
    return [...this.capabilities];
  }

  /**
   * Add or update a model capability entry.
   */
  upsertCapability(capability: ModelCapability): void {
    const idx = this.capabilities.findIndex(c => c.modelName === capability.modelName);
    if (idx >= 0) {
      this.capabilities[idx] = capability;
    } else {
      this.capabilities.push(capability);
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private scoreModel(model: ModelCapability, features: TaskFeatures): number {
    let score = 0;

    // ── Category fit (0-4 points) ──
    if (model.strengths.includes(features.category)) {
      score += 4;
    } else if (model.adequate.includes(features.category)) {
      score += 2;
    }

    // ── Complexity fit (0-3 points) ──
    if (features.complexity >= model.minComplexity && features.complexity <= model.maxComplexity) {
      score += 3;
    } else if (
      features.complexity >= model.minComplexity - 1 &&
      features.complexity <= model.maxComplexity + 1
    ) {
      score += 1;
    }

    // ── Tool requirement (0-2 points) ──
    if (features.requiresTools && model.supportsTools) {
      score += 2;
    } else if (!features.requiresTools) {
      score += 2; // No tools needed, any model works
    }

    // ── Vision requirement (0-2 points) ──
    if (features.requiresVision && model.supportsVision) {
      score += 2;
    } else if (!features.requiresVision) {
      score += 2;
    }

    // ── Cost optimization (0-3 points) ──
    if (this.routing.costOptimization) {
      // Prefer cheaper models for low-complexity tasks
      if (features.complexity <= 3) {
        score += (1 - model.costMultiplier / 4) * 3;
      } else if (features.complexity <= 6) {
        score += (1 - model.costMultiplier / 4) * 1.5;
      }
      // Budget check
      if (this.isBudgetExceeded() && model.costMultiplier > 0.5) {
        score -= 3;
      }
    }

    // ── Latency optimization (0-2 points) ──
    if (this.routing.latencyOptimization || features.isUrgent) {
      const latencyScore = (5000 - Math.min(model.avgLatencyMs, 5000)) / 5000 * 2;
      score += latencyScore;
    }

    // ── Context window check (0-1 points) ──
    if (features.estimatedTokens <= model.maxContextTokens * 0.8) {
      score += 1;
    } else if (features.estimatedTokens > model.maxContextTokens) {
      score -= 5; // Penalize if task won't fit
    }

    // ── Past performance bonus (0-1 points) ──
    const perf = this.performance.get(model.modelName);
    if (perf && perf.totalCalls > 5) {
      const successRate = perf.successfulCalls / perf.totalCalls;
      score += successRate;
    }

    return score;
  }

  private buildRoute(
    model: ModelCapability,
    features: TaskFeatures,
    reason: string,
  ): ModelRoute {
    // Build a provider config (will be overridden by caller if needed)
    const provider: ProviderConfig = {
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: model.modelName,
    };

    // Estimate cost (approximate: $0.002 per 1K tokens as baseline, multiplied by cost factor)
    const estimatedCost = (features.estimatedTokens / 1000) * 0.002 * model.costMultiplier;

    return {
      model: model.modelName,
      provider,
      taskCategory: features.category,
      reason,
      confidence: Math.min(1.0, 0.5 + (features.complexity >= model.minComplexity && features.complexity <= model.maxComplexity ? 0.5 : 0.2)),
      estimatedCost: Math.round(estimatedCost * 10000) / 10000,
      estimatedLatencyMs: model.avgLatencyMs,
    };
  }

  private recordFailure(modelName: string, reason: string): void {
    const metrics = this.getOrCreateMetrics(modelName);
    metrics.totalCalls++;
    metrics.failedCalls++;

    const failCount = metrics.failureReasons.get(reason) || 0;
    metrics.failureReasons.set(reason, failCount + 1);

    // Track consecutive failures
    const consecutive = (this.failureCounts.get(modelName) || 0) + 1;
    this.failureCounts.set(modelName, consecutive);

    // Apply cooldown
    this.failureCooldowns.set(modelName, Date.now() + this.routing.failureCooldownMs);

    // Quarantine on too many consecutive failures
    if (consecutive >= this.routing.maxConsecutiveFailures) {
      this.quarantine.add(modelName);
    }
  }

  private getOrCreateMetrics(modelName: string): ModelPerformanceMetrics {
    const existing = this.performance.get(modelName);
    if (existing) return existing;

    const metrics: ModelPerformanceMetrics = {
      modelName,
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      avgLatencyMs: 0,
      avgTokensPerCall: 0,
      totalCost: 0,
      lastUsedAt: 0,
      failureReasons: new Map(),
    };

    this.performance.set(modelName, metrics);
    return metrics;
  }
}

// ─── Convenience Functions ─────────────────────────────────────────────────

/**
 * Quick route: classify and route in one call.
 */
export function quickRoute(
  task: string,
  context: string,
  config?: Config,
): ModelRoute {
  const router = new ModelRouter();
  const features = classifyTask(task, context);

  if (config) {
    return router.routeFromPool(task, context, config);
  }

  return router.route(features);
}

/**
 * Get all known model capabilities.
 */
export function getModelCapabilities(): ModelCapability[] {
  return MODEL_CAPABILITIES;
}

/**
 * Get capability info for a specific model.
 */
export function getModelCapability(modelName: string): ModelCapability | null {
  return MODEL_CAPABILITIES.find(c => c.modelName === modelName) || null;
}

/**
 * Estimate task cost before execution.
 */
export function estimateTaskCost(
  task: string,
  context?: string,
  modelName?: string,
): { estimatedTokens: number; estimatedCost: number; model: string } {
  const features = classifyTask(task, context);
  const capability = modelName
    ? MODEL_CAPABILITIES.find(c => c.modelName === modelName)
    : MODEL_CAPABILITIES[0];

  if (!capability) {
    return {
      estimatedTokens: features.estimatedTokens,
      estimatedCost: 0,
      model: 'unknown',
    };
  }

  const estimatedCost = (features.estimatedTokens / 1000) * 0.002 * capability.costMultiplier;

  return {
    estimatedTokens: features.estimatedTokens,
    estimatedCost: Math.round(estimatedCost * 10000) / 10000,
    model: capability.modelName,
  };
}

/**
 * Build a fallback entry for error reporting.
 */
export function createFallbackEntry(
  failedModel: string,
  failureReason: string,
  fallbackModel: string,
  cooldownMs: number = 60_000,
): FallbackEntry {
  return {
    failedModel,
    failureReason,
    fallbackModel,
    cooldownMs,
  };
}
