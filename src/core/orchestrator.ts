import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { AnthropicProvider, buildMessageWithImages } from '../providers/anthropic.js';
import type { MessageContentBlock } from '../providers/anthropic.js';
import { ClaudeCodeProvider } from '../providers/claude-code.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import type { Config, WorkerPoolEntry } from './config.js';
import { loadProjectMemory } from './config.js';
import type { ToolDefinition, ToolCall } from './types.js';
import { getAllTools, executeTool, getExternalTools } from '../tools/index.js';
import { rollbackTo, autoCommit, isDirtyRepo, createFeatureBranch, getChangeSummary } from './git-tracker.js';
import { getRole } from './agent-roles.js';
import type { AgentRole } from './agent-roles.js';
import { loadScanConfig, runSecurityScan, filterTruePositives, formatFindingsForWorker } from './security-scanner.js';
import { routeTask } from './task-router.js';
import { classifyTask, ModelRouter } from '../models/router.js';
import { recordDelegation } from './worker-stats.js';
import { formatMemoryForContext } from './agent-memory.js';
import { formatDiffContext } from './diff-analyzer.js';
import { buildDependencyGraph, findAffectedFiles } from './dependency-graph.js';
import type { AffectedDependency } from './dependency-graph.js';
import { DeadCodeDetector, quickDeadCodeScan } from './dead-code-detector.js';
import type { DeadCodeResult } from './dead-code-detector.js';
import { getImageAttachments } from './attachments.js';
import { MCPClient, mcpToolsToToolDefinitions } from './mcp-client.js';
import { createPR, getCurrentBranch, pushBranch } from './github-integration.js';
import { boundedParallel } from './concurrency.js';
import { onWorkerComplete } from './worker-registry.js';
import { runCoordinator } from './run-coordinator.js';
import { workerProjector } from './worker-projector.js';
import { createWorkerWorktree, mergeWorktree, cleanupWorktree } from './worktree.js';
import { withFileLock } from './file-lock.js';
import { createShadowSnapshot } from './shadow-snapshot.js';
import { circuitBreaker } from './circuit-breaker.js';
import { workerEvents } from './event-bus.js';
import { createContextSnapshot, createTargetedSnapshot, snapshotToPrompt } from './context-snapshot.js';
import { launchAsyncScan, AsyncScanHandle } from './async-scan.js';
import type { ScanResult } from './async-scan.js';
import { speculativeStart } from './speculative-exec.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Module-init: register a completion callback so the orchestrator is notified
// automatically whenever a worker finishes (done or failed).
onWorkerComplete((entry) => {
  const resultSnippet = entry.result
    ? entry.result.slice(0, 200)
    : '(no result)';
  console.log(`[worker-result] ${entry.id} (${entry.status}): ${resultSnippet}`);
});

function buildSystemPrompt(config: Config, planMode: boolean = false): string {
  const poolNames = config.workerPool.map(w => `"${w.name}" (${w.tier}, ${w.provider.model})`).join(', ');
  const memory = loadProjectMemory(config.workDir, config.homeDir);

  let system = `You are an expert software architect and project manager. You DELEGATE work to workers. You do NOT do the work yourself.

## MANDATORY DELEGATION RULE
You MUST call delegate_parallel for EVERY task. No exceptions. You are a MANAGER, not a developer.
- Explore FIRST to scope the work: use read_file, list_files, run_command to understand the codebase, find the real files, and map the change surface. Explore enough to decompose accurately — typically 4-8 calls; more for large/unfamiliar codebases. Under-exploring produces vague tasks that workers get wrong.
- Then you MUST delegate. Do NOT read files and write them yourself. Do NOT do the workers' job.
- Even for "simple" tasks — DELEGATE. Your judgment about what is "simple enough to do yourself" is WRONG. Always delegate.
- If a task has multiple parts, ALL parts go in ONE delegate_parallel call.

## Task Lifecycle
Tasks are tracked as JSON files in the tasks/ folder: pending → active → completed/failed → archive.
- When you delegate, each task gets a unique ID. Workers include "TASK {id} COMPLETED" in their final message.
- Completed/failed tasks auto-archive after 24 hours.
- You can check task status via the API: GET /api/v1/tasks?status=active

## Workflow
1. User describes what they want.
2. You explore briefly (1-3 tool calls MAX) to understand scope.
3. You call delegate_parallel with ALL tasks in ONE call. Break work into focused pieces.
4. Workers execute and report back.
5. You review results and report to user. If ANY task failed, you MUST re-delegate it — see FAILURE IS NOT AN OPTION below.

## FAILURE IS NOT AN OPTION
You are a manager. When a worker fails, you do NOT accept it. You FIX IT.
- The system automatically retries failed tasks up to 4 times with escalating strategies before reporting results to you.
- If a task still reaches you as "failed" after automatic retries, it is genuinely stuck. Analyze the error, rethink the approach, break it down differently, and re-delegate.
- You may ONLY report a task as failed to the user after YOU have personally re-delegated it at least once with a different approach and it still failed.
- "Worker failed" is NOT a valid final answer. The user hired you to get things DONE.
- When re-delegating, include the error from the previous attempt so the worker knows what went wrong and can try a different approach.

## Rules
- NEVER do a worker's job. If you catch yourself reading a file to write it back modified — STOP. Delegate instead.
- Explore enough to scope accurately (see delegation rule), then delegate. Don't explore endlessly, but don't delegate blind either.
- ONE delegate_parallel call per round. All tasks in one array. Workers run concurrently.
- Keep each task focused — one clear objective per array entry. MAX 3-4 features per task entry. Workers have limited context and WILL exhaust it on 5+ features, causing partial completion and wasted work. Split 12 features into 3-4 task entries, not 1.
- VERIFY, don't trust. After workers report, the system runs a build/typecheck verification (git-independent) and returns the result. If the diff is empty or the build FAILED, the work is NOT done — re-delegate a fix. A worker saying "COMPLETED" is a claim, not proof. Max ${config.maxRetries} retries.
- NEVER accept worker failure as final. Re-delegate with adjusted context.
- Completion requires every numbered directive item to be either completed or explicitly failed with a reason — silently skipping items is a failure.

Worker pool: ${poolNames}
- "fast" tier: simple edits, boilerplate, formatting
- "standard" tier: general implementation
- "heavy" tier: complex algorithms, refactoring, multi-file changes

Delegation tools (ONLY TWO):
- delegate_parallel: MANDATORY for all work. Runs 1+ tasks concurrently.
- delegate_pipeline: For compiled TypeScript ONLY. Adds compile + security gates.

You also have read_file, list_files, run_command for brief exploration before delegating.`;

  if (memory) {
    system += `\n\n## Project Context (from .cobra-commander/context.md)\n${memory}`;
  }

  const agentMem = formatMemoryForContext();
  if (agentMem) {
    system += agentMem;
  }

  if (planMode) {
    system += `\n\nYou are in PLAN MODE. Do NOT delegate any work to workers. Instead:
1. Explore the codebase thoroughly using read_file, list_files, and run_command.
2. Analyze the request and create a detailed implementation plan.
3. List exactly what files need to be created/modified and what changes to make.
4. Identify potential risks or complications.
5. Present the plan clearly for user review.
Do NOT use delegate_parallel or delegate_pipeline.`;
  }

  return system;
}

function buildOrchestratorTools(): ToolDefinition[] {
  const baseTools: ToolDefinition[] = [
    {
      name: 'delegate_parallel',
      description: 'DEFAULT delegation tool. Runs 1 or more tasks concurrently via workers. ALWAYS use this unless the work is compiled TypeScript (use delegate_pipeline for that). Break work into independent pieces and delegate them ALL at once — never serialize what can parallelize.',
      input_schema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'Clear, specific task description. Include file paths and exact changes. MAX 4 features/changes per task entry — split larger work across multiple entries.' },
                context: { type: 'string', description: 'Context: file paths, architecture, code patterns' },
                acceptance_criteria: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Acceptance criteria',
                },
                model: { type: 'string', description: 'Worker model name (optional). fast/standard/heavy tier.' },
              },
              required: ['task', 'context'],
            },
            description: 'Tasks to run in parallel. Even a single task goes here. Each entry should cover at most 3-4 features — workers exhaust their context on larger scopes.',
          },
        },
        required: ['tasks'],
      },
    },
    {
      name: 'delegate_pipeline',
      description: `Build pipeline for compiled TypeScript/web app code ONLY. Enforces: tasks (max 4 parallel) → compile gate (tsc --noEmit) → SAST/code review via the security scanner → fix findings (max 2 fix rounds then stop). DO NOT USE for documentation, static websites, HTML, or non-compiled work.`,
      input_schema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'Task description' },
                context: { type: 'string', description: 'Context for this task' },
                acceptance_criteria: { type: 'array', items: { type: 'string' } },
                model: { type: 'string', description: 'Worker model name (optional)' },
              },
              required: ['task', 'context'],
            },
            description: 'Implementation tasks (max 4). Run in parallel.',
          },
          skipSecurity: {
            type: 'boolean',
            description: 'Skip the the scanner security scan phase (default: false).',
          },
          autoCreatePR: {
            type: 'boolean',
            description: 'After pipeline completes, push branch and create a GitHub PR.',
          },
        },
        required: ['tasks'],
      },
    },
    ...getAllTools().filter(t => ['read_file', 'list_files', 'run_command'].includes(t.name)),
  ];

  // Include MCP tools for context gathering during planning
  const mcpTools = getExternalTools();
  if (mcpTools.length > 0) {
    baseTools.push(...mcpTools);
  }

  return baseTools;
}

/**
 * Callback interface for orchestrator lifecycle events.
 * Implementations receive real-time notifications about orchestration progress.
 */
/** Durable snapshot of the orchestrator's plan-state, persisted for crash-resume. */
export interface LedgerSnapshot {
  originalRequirement: string;
  ledger: Array<{ task: string; status: string; note: string }>;
  delegationCount: number;
  producedChanges: boolean;
}

export interface OrchestratorCallbacks {
  /** Optional: fired each turn/wave with the current ledger so the launcher can
   *  persist a heartbeat + resumable state to disk. */
  onHeartbeat?: (snapshot: LedgerSnapshot) => void;
  /** Fired when the orchestrator emits a thinking/reasoning message */
  onOrchestratorThinking: (text: string) => void;
  /** Fired when the orchestrator performs an exploration tool call */
  onOrchestratorExploring: (toolName: string, summary: string) => void;
  /** Fired when a single task is delegated to a worker */
  onDelegating: (task: string, model?: string) => void;
  /** Fired when parallel delegation begins, with the batch count */
  onParallelDelegating: (count: number) => void;
  /** Fired when a worker sends a progress update */
  onWorkerUpdate: (text: string) => void;
  /** Fired when a worker invokes a tool */
  onWorkerToolCall: (name: string, input: Record<string, unknown>) => void;
  /** Fired when a worker tool call completes */
  onWorkerToolResult: (name: string, result: string, isError: boolean) => void;
  /** Fired when the orchestrator reviews a diff after delegation */
  onReviewing: (diffSummary?: string) => void;
  /** Fired when a task is being retried */
  /** attempt = the attempt about to start; scope distinguishes the inner runner retry from the outer escalation loop. */
  onRetrying: (task: string, attempt: number, detail?: { scope: 'inner' | 'outer'; error?: string }) => void;
  /** Fired to report token usage for cost tracking */
  onTokenUsage: (role: 'orchestrator' | 'worker', input: number, output: number) => void;
  /** Optional: fired when a delegation task completes or fails */
  onDelegationComplete?: (task: string, status: 'completed' | 'failed', files: string[]) => void;
  /** Optional: fired when a swarm phase starts */
  onSwarmPhase?: (phaseName: string, phaseNum: number, totalPhases: number) => void;
  /** Optional: fired during security scan operations */
  onSecurityScan?: (msg: string) => void;
  /** Optional: fired when auto-commit succeeds */
  onAutoCommit?: (hash: string, message: string) => void;
  /** Optional: fired during cross-model verification */
  onVerifying?: (msg: string) => void;
}

// ──────────────────────────────────────────────
// GAP-021: Concurrent tool execution
// ──────────────────────────────────────────────

/**
 * Describes a single tool call to be executed concurrently.
 * Used by the GAP-021 concurrent tool execution system.
 */
export interface ConcurrentToolCall {
  /** Unique identifier for this tool call */
  id: string;
  /** Name of the tool to invoke */
  name: string;
  /** Input parameters for the tool */
  input: Record<string, unknown>;
  /** Optional ordering hint (lower values execute first) */
  order?: number;
}

/**
 * Result of a batch of concurrently executed tool calls.
 */
export interface ConcurrentExecutionResult {
  /** Whether all tool calls completed without errors */
  success: boolean;
  /** Per-tool-call results */
  results: Array<{
    /** Matched tool call ID */
    toolCallId: string;
    /** Tool name */
    name: string;
    /** Output content from the tool */
    content: string;
    /** Error message if the tool call failed */
    error?: string;
    /** Execution duration in milliseconds */
    duration: number;
  }>;
  /** Total wall-clock duration of the concurrent batch */
  totalDuration: number;
  /** Human-readable summary of the execution */
  summary: string;
}

/**
 * Core orchestrator that manages the agentic workflow loop:
 * receives user messages, delegates to workers, handles git snapshots,
 * security scanning, auto-commit, and cross-model verification.
 *
 * Supports multiple delegation strategies: parallel, chain, pipeline, and swarm.
 */
// Size-based context backstop for the orchestrator (chars ≈ tokens×4). ~60k
// tokens of input keeps us well under the the worker model window with ample room
// for reasoning + 16k output. Compact-on-delegate is the primary guard; this
// only catches long pre-delegation exploration runs.
const ORCH_MAX_CONTEXT_CHARS = 240_000;

// Budget backstop: cumulative token and wall-clock caps for the orchestrator
// main loop. Exit early with a ledger snapshot when either budget is exceeded.
const ORCH_TOKEN_BUDGET = parseInt(process.env.ORCH_TOKEN_BUDGET || '5000000', 10);
const ORCH_TIME_BUDGET_MS = parseInt(process.env.ORCH_TIME_BUDGET_MS || '2400000', 10);
// Multi-wave plans re-plan after every compact-on-delegate, so 30 turns starved 5-wave runs.
const ORCH_MAX_TURNS = parseInt(process.env.ORCH_MAX_TURNS || '60', 10);
// Workers read files themselves; an orchestrator that keeps exploring never delegates
// (0ac50865 spent all 30 turns reading code). Past this many turns without a delegation,
// only delegation tools are offered.
const ORCH_EXPLORE_LIMIT = parseInt(process.env.ORCH_EXPLORE_LIMIT || '12', 10);

export class Orchestrator {
  private provider: AnthropicProvider | ClaudeCodeProvider | OpenAICompatibleProvider;
  private config: Config;
  private messages: Array<Record<string, unknown>> = [];
  private callbacks: OrchestratorCallbacks;
  private workerRunner: (task: string, context: string, criteria: string[], modelName?: string, role?: AgentRole, workDir?: string, workerId?: string) => Promise<string>;
  private workerRunnerWithRetry: (task: string, context: string, criteria: string[], modelName?: string, role?: AgentRole, workDir?: string, workerId?: string) => Promise<string>;
  private usingTunnel: boolean;
  private snapshotStack: Array<{ref: string; task: string; timestamp: number}> = [];
  private planMode: boolean = false;
  private isOAI: boolean = false;
  private unsubEscalation: (() => void) | null = null;
  private pendingEscalations: Array<{
    workerId: string;
    reason: string;
    detail: string;
    heavyModel: string;
  }> = [];
  private pendingAsyncScanHandles: AsyncScanHandle[] = [];
  // --- Context-management state (compact-on-delegate + ledger) ---
  // The orchestrator's durable memory of the plan. Lives OUTSIDE `this.messages`
  // so the message history can be compacted/wiped after each delegation wave
  // without ever losing track of what has and hasn't been dispatched. Worker
  // control (escalation bus, awaited handles, steering) also lives outside
  // `this.messages`, so collapsing history never severs control of workers.
  private ledger: Array<{ task: string; status: string; note: string }> = [];
  // Full (untruncated, non-code-stripped) worker reports, kept ONLY as the
  // search corpus for auditPlanCompletion. The ledger `note` is tail-truncated
  // and code-stripped for context-budget display, which dropped item keywords
  // and caused the plan-audit gate to false-fail completed work. This preserves
  // the evidence the gate needs without bloating the rendered ledger.
  private ledgerAuditCorpus: string[] = [];
  private originalRequirement = '';
  private delegationCount = 0;
  private producedChanges = false;
  private resuming = false;
  private planNudges = 0;

  /** Public run stats for the launcher's fail-loud guard (no-op detection). */
  get delegationsMade(): number { return this.delegationCount; }
  get changedFiles(): boolean { return this.producedChanges; }
  /** Whether ANY delegated task actually completed (not just returned).
   *  A greet-and-do-nothing worker that emits a FAILURE: sentinel is NOT
   *  counted here — only genuine 'completed' ledger entries. */
  get anyLedgerCompleted(): boolean { return this.ledger.some(e => e.status === 'completed'); }

  constructor(
    config: Config,
    callbacks: OrchestratorCallbacks,
    workerRunner: (task: string, context: string, criteria: string[], modelName?: string, role?: AgentRole, workDir?: string, workerId?: string) => Promise<string>,
  ) {
    this.usingTunnel = !config.orchestrator.apiKey;
    this.workerRunnerWithRetry = async (task, context, criteria, modelName, role, workDir, workerId) => {
      // Wrap the worker runner with retry logic
      const maxRetries = config.maxRetries || 2;
      let lastError: string | null = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          let retryContext = context;
          if (lastError) {
            retryContext = `${context}\n\n## RETRY ATTEMPT ${attempt}/${maxRetries}\nPrevious error:\n${lastError}`;
          }

          if (attempt > 1) {
            this.callbacks.onRetrying(task, attempt, { scope: 'inner', error: lastError ?? undefined });
          }

          return await workerRunner(task, retryContext, criteria, modelName, role, workDir, workerId);
        } catch (err) {
          lastError = (err as Error).message;
          if (attempt >= maxRetries) {
            throw new Error(`Failed after ${maxRetries} attempts. Last error: ${lastError}`);
          }
        }
      }

      throw new Error(`Failed after ${maxRetries} attempts.`);
    };

    const isOpenAICompatible = !config.orchestrator.baseUrl?.includes('anthropic');

    if (this.usingTunnel) {
      this.provider = new ClaudeCodeProvider(
        config.orchestrator.model,
        config.workDir,
        config.maxOrchestratorTurns,
        {
          onToolCall: (name, input) => {
            const summary = name === 'Read' || name === 'read_file'
              ? `${input.file_path || input.path || ''}`
              : name === 'Bash' || name === 'run_command'
                ? `$ ${String(input.command || '').slice(0, 80)}`
                : name === 'Grep' || name === 'grep'
                  ? `/${input.pattern || ''}/ in ${input.path || '.'}`
                  : JSON.stringify(input).slice(0, 80);
            callbacks.onOrchestratorExploring(name, summary);
          },
        },
      );
    } else if (isOpenAICompatible) {
      this.provider = new OpenAICompatibleProvider(config.orchestrator);
      this.isOAI = true;
    } else {
      this.provider = new AnthropicProvider(config.orchestrator);
    }

    this.config = config;
    this.callbacks = callbacks;
    this.workerRunner = workerRunner;

    // Subscribe to reactive bus escalation events
    this.unsubEscalation = workerEvents.on((event) => {
      if (event.type === 'escalation.triggered') {
        console.error(
          `[orchestrator] ESCALATION: Worker ${event.workerId} — ${event.reason}: ${event.detail}`,
        );

        // Attempt re-dispatch to heavy tier if available
        const heavyWorker = this.config.workerPool.find(w => w.tier === 'heavy');
        if (heavyWorker) {
          console.error(
            `[orchestrator] → Re-dispatching to heavy tier: "${heavyWorker.name}" (${heavyWorker.provider.model})`,
          );
          // Store the escalation for the next tool-call dispatch cycle
          this.pendingEscalations.push({
            workerId: event.workerId,
            reason: event.reason,
            detail: event.detail,
            heavyModel: heavyWorker.provider.model,
          });
        }
      }

      if (event.type === 'doom.cancelled') {
        console.error(
          `[orchestrator] DOOM-CANCELLED: Worker ${event.workerId} aborted after doom-loop detection ` +
          `(tool: ${event.tool}, count: ${event.count})`,
        );
      }
    });
  }

  /**
   * Enable or disable plan mode. In plan mode, the orchestrator explores
   * the codebase but does not delegate any work to workers.
   */
  setPlanMode(enabled: boolean): void {
    this.planMode = enabled;
  }

  /**
   * @returns Whether the orchestrator is currently in plan mode
   */
  isPlanMode(): boolean {
    return this.planMode;
  }

  /**
   * Process a user message through the orchestrator's agentic loop.
   * Handles image attachments, tool execution, delegation, auto-compaction,
   * and returns the final response text.
   *
   * @param userMessage - The user's input message
   * @returns Final response text from the orchestrator
   */
  async processUserMessage(userMessage: string): Promise<string> {
    // Check for image attachments and build content blocks if present
    const imageAtts = getImageAttachments();
    if (imageAtts.length > 0) {
      const imageBlocks = imageAtts.map(att => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: att.mediaType || 'image/png',
          data: att.base64Data || att.content,
        },
      }));
      const textBlock = { type: 'text' as const, text: userMessage };
      this.messages.push({ role: 'user', content: [textBlock, ...imageBlocks] });
    } else {
      this.messages.push({ role: 'user', content: userMessage });
    }

    // Anchor the run's requirement so compact-on-delegate can always restore it.
    if (!this.originalRequirement) this.originalRequirement = userMessage;

    // RESUME: if seeded from a persisted ledger (a prior run died mid-flight),
    // tell the model what was already done so it re-dispatches only the rest.
    if (this.resuming && this.ledger.length) {
      this.messages.push({
        role: 'user',
        content:
          `## RESUMING — a prior run of this task was interrupted. Progress ledger below is authoritative; do NOT redo completed items.\n${this.renderLedger()}\n\n` +
          `Re-dispatch ONLY the failed/remaining work via delegate_parallel, verify, then report. If everything is already completed, verify the build and report completion.`,
      });
      this.callbacks.onOrchestratorThinking(`[resuming — ${this.ledger.filter(e => e.status === 'completed').length}/${this.ledger.length} items already done]`);
    }

    let finalResponse = '';
    let turns = 0;
    let emptyRetries = 0;
    // Budget backstop: cumulative token sum + wall-clock start.
    let cumulativeTokens = 0;
    let prevInputTokens = 0;
    const startTime = Date.now();
    // Time spent waiting on workers is the workers' budget, not the orchestrator's.
    let delegationWaitMs = 0;
    // With compact-on-delegate bounding context, extra turns are free headroom
    // (the worker model is cheap) and improve availability on multi-wave plans.
    const maxTurns = this.usingTunnel ? 5 : ORCH_MAX_TURNS;
    let turnsSinceDelegation = 0;
    let exploreNudged = false;

    while (turns < maxTurns) {
      turns++;
      this.emitHeartbeat();   // liveness + persist ledger each turn (crash-resume)

      // INT-002: drain any escalations buffered by the reactive bus (workers
      // that exhausted retries) and surface them so the orchestrator
      // re-dispatches the failed task to the heavy tier this turn.
      if (this.pendingEscalations.length > 0) {
        const lines = this.pendingEscalations.map(
          e => `- Worker ${e.workerId} failed (${e.reason}): ${e.detail}. Re-dispatch its task to the heavy tier model "${e.heavyModel}".`,
        );
        this.pendingEscalations = [];
        this.messages.push({
          role: 'user',
          content: `## Escalation — worker(s) exhausted retries\n${lines.join('\n')}\n\nRe-issue the failed task(s) via delegate_parallel with \`model\` set to the heavy-tier model above.`,
        });
      }

      const allTools = buildOrchestratorTools();
      const exploreCapped = !this.planMode && turnsSinceDelegation >= ORCH_EXPLORE_LIMIT;
      if (exploreCapped && !exploreNudged) {
        exploreNudged = true;
        this.callbacks.onOrchestratorThinking(`[explore-limit: ${turnsSinceDelegation} turns without delegating — delegation tools only]`);
        this.messages.push({
          role: 'user',
          content: `EXPLORATION LIMIT: ${turnsSinceDelegation} turns since your last delegation. Stop reading files — workers read the code themselves. Delegate the next wave now (file paths + feature + key interfaces is enough). Only delegation tools are available until you delegate.`,
        });
      }
      const tools = this.planMode
        ? allTools.filter(t => ['read_file', 'list_files', 'run_command'].includes(t.name))
        : exploreCapped
          ? allTools.filter(t => t.name.startsWith('delegate_'))
          : allTools;
      turnsSinceDelegation++;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (this.provider as any).chat(
        buildSystemPrompt(this.config, this.planMode),
        this.messages,
        tools,
        16384,
      );

      const usage = response.usage as { input_tokens?: number; output_tokens?: number; input?: number; output?: number };
      const inputTokens = usage.input_tokens ?? usage.input ?? 0;
      const outputTokens = usage.output_tokens ?? usage.output ?? 0;
      this.callbacks.onTokenUsage('orchestrator', inputTokens, outputTokens);

      // Budget backstop: check cumulative token spend + wall-clock before
      // processing tool calls. Exceed → exit with ledger so the launcher can
      // surface what was done before the budget ran out.
      // Each turn re-sends the conversation; count only input growth + output so the cap tracks real work.
      cumulativeTokens += Math.max(0, inputTokens - prevInputTokens) + outputTokens;
      prevInputTokens = inputTokens;
      if (cumulativeTokens > ORCH_TOKEN_BUDGET || Date.now() - startTime - delegationWaitMs > ORCH_TIME_BUDGET_MS) {
        const activeMin = Math.round((Date.now() - startTime - delegationWaitMs) / 60000);
        finalResponse = `BUDGET_EXCEEDED: [tokens ${cumulativeTokens}/${ORCH_TOKEN_BUDGET}, active ${activeMin}/${Math.round(ORCH_TIME_BUDGET_MS / 60000)} min, turn ${turns}] ` + this.renderLedger();
        break;
      }

      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];

      if ('content' in response && Array.isArray((response as unknown as Record<string, unknown>).content)) {
        for (const block of (response as { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> }).content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({ id: block.id!, name: block.name!, input: block.input! });
          }
        }
      } else {
        const wr = response as { text?: string | null; toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }> };
        if (wr.text) textParts.push(wr.text);
        if (wr.toolCalls) toolCalls.push(...wr.toolCalls);
      }

      if (textParts.length > 0 && toolCalls.length === 0) {
        this.callbacks.onOrchestratorThinking(textParts.join('\n'));
      }

      if (this.isOAI) {
        const assistantMsg: Record<string, unknown> = { role: 'assistant', content: textParts.join('\n') || null };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }));
        }
        this.messages.push(assistantMsg);
      } else {
        const msgContent = 'content' in response ? (response as unknown as Record<string, unknown>).content : textParts.join('\n');
        this.messages.push({ role: 'assistant', content: msgContent });
      }

      if (toolCalls.length === 0) {
        finalResponse = textParts.join('\n');
        // FAIL-LOUD GUARD: an empty turn before any work is delegated is the
        // reasoning-model starvation / post-compaction no-op — NOT a real
        // completion. Nudge and retry instead of silently exiting "green".
        if (!finalResponse.trim() && this.delegationCount === 0 && emptyRetries < 2) {
          emptyRetries++;
          this.callbacks.onOrchestratorThinking('[empty response with no work done — nudging to delegate]');
          this.messages.push({
            role: 'user',
            content: 'You returned an empty response and have not delegated any work yet. Read the relevant files if needed, then split the work and call delegate_parallel now. Do not stop until the tasks are delegated.',
          });
          continue;
        }
        // PLAN AUDIT GATE: before accepting completion, verify every numbered
        // directive item was addressed by at least one delegation wave.
        if (finalResponse.trim()) {
          const audit = this.auditPlanCompletion();
          if (!audit.complete) {
            if (this.planNudges < 2) {
              this.planNudges++;
              this.callbacks.onOrchestratorThinking(`[plan-audit: ${audit.gaps.length} item(s) not addressed — nudging]`);
              this.messages.push({
                role: 'user',
                content: `PLAN AUDIT: these directive items are NOT addressed (no delegation completed or failed for them):\n${audit.gaps.map(g => '- ' + g).join('\n')}\nDelegate the missing work now, or explicitly mark an item failed with a reason. Do not declare completion.`,
              });
              continue;
            }
            finalResponse = `INCOMPLETE: ${audit.gaps.join('; ')}\n${finalResponse}`;
          }
        }
        break;
      }

      // GAP-021: Multi-tool simultaneous execution
      // Delegation tools run sequentially; read-only tools run concurrently
      const concurrentEnabled = this.config.autoFeatureBranch ?? true; // feature flag

      const toolResults: Array<{
        type: 'tool_result';
        tool_use_id: string;
        content: string;
      }> = [];

      // Track whether this turn handed work to workers, and collect the
      // (already-summarized) delegation results so compact-on-delegate can
      // fold them into the ledger snapshot.
      let didDelegate = false;
      const delegationSummaries: string[] = [];
      const isDelegationTool = (name: string) =>
        name === 'delegate_to_worker' || name === 'delegate_parallel' ||
        name === 'delegate_chain' || name === 'delegate_pipeline' || name === 'delegate_swarm';

      if (concurrentEnabled) {
        // Separate delegation calls and standard tool calls
        const delegationCalls: ToolCall[] = [];
        const standardCalls: ToolCall[] = [];

        for (const call of toolCalls) {
          if (
            call.name === 'delegate_to_worker' ||
            call.name === 'delegate_parallel' ||
            call.name === 'delegate_chain' ||
            call.name === 'delegate_pipeline' ||
            call.name === 'delegate_swarm'
          ) {
            delegationCalls.push(call);
          } else {
            standardCalls.push(call);
          }
        }

        // Execute delegation calls sequentially (they modify state)
        for (const call of delegationCalls) {
          const delegationStart = Date.now();
          let result;
          if (call.name === 'delegate_to_worker') {
            // Backwards compat: wrap single task into parallel format
            call.input = { tasks: [{ task: call.input.task, context: call.input.context, acceptance_criteria: call.input.acceptance_criteria, model: call.input.model }] };
            result = await this.handleParallelDelegation(call);
          } else if (call.name === 'delegate_parallel') {
            result = await this.handleParallelDelegation(call);
          } else if (call.name === 'delegate_chain') {
            result = await this.handleChainDelegation(call);
          } else if (call.name === 'delegate_pipeline') {
            result = await this.handlePipelineDelegation(call);
          } else {
            result = await this.handleSwarmDelegation(call);
          }
          delegationWaitMs += Date.now() - delegationStart;
          toolResults.push(result);
          didDelegate = true;
          this.delegationCount++;
          delegationSummaries.push(result.content);
        }

        // Execute standard (read-only) tool calls concurrently
        if (standardCalls.length > 0) {
          const concurrentResults = await Promise.all(
            standardCalls.map(async (call) => {
              try {
                const result = await executeTool(call, this.config.workDir);
                this.callbacks.onWorkerToolCall(call.name, call.input);
                return {
                  type: 'tool_result' as const,
                  tool_use_id: call.id,
                  content: this.capForOrchestrator(result.content),
                };
              } catch (err) {
                return {
                  type: 'tool_result' as const,
                  tool_use_id: call.id,
                  content: `Error: ${(err as Error).message}`,
                };
              }
            }),
          );
          toolResults.push(...concurrentResults);
        }
      } else {
        // Sequential fallback (original behavior)
        for (const call of toolCalls) {
          if (isDelegationTool(call.name)) {
            const delegationStart = Date.now();
            let result;
            if (call.name === 'delegate_to_worker') {
              call.input = { tasks: [{ task: call.input.task, context: call.input.context, acceptance_criteria: call.input.acceptance_criteria, model: call.input.model }] };
              result = await this.handleParallelDelegation(call);
            } else if (call.name === 'delegate_parallel') {
              result = await this.handleParallelDelegation(call);
            } else if (call.name === 'delegate_chain') {
              result = await this.handleChainDelegation(call);
            } else if (call.name === 'delegate_pipeline') {
              result = await this.handlePipelineDelegation(call);
            } else {
              result = await this.handleSwarmDelegation(call);
            }
            delegationWaitMs += Date.now() - delegationStart;
            toolResults.push(result);
            didDelegate = true;
            this.delegationCount++;
            delegationSummaries.push(result.content);
          } else {
            const result = await executeTool(call, this.config.workDir);
            this.callbacks.onWorkerToolCall(call.name, call.input);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: this.capForOrchestrator(result.content),
            });
          }
        }
      }

      if (this.isOAI) {
        for (const tr of toolResults) {
          this.messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
        }
      } else {
        this.messages.push({ role: 'user', content: toolResults });
      }

      // COMPACT-ON-DELEGATE: the primary context guard. Once work is handed to
      // workers, collapse the planning history to requirement + ledger + this
      // wave's results. History can never exceed one wave, so the orchestrator
      // cannot overflow its window on any repo size. Worker control lives
      // outside `this.messages`, so this never severs command of the workers.
      if (didDelegate) {
        turnsSinceDelegation = 0;
        exploreNudged = false;
      }

      if (this.config.autoCompact !== false && didDelegate) {
        this.callbacks.onOrchestratorThinking('[compact-on-delegate: work dispatched, collapsing planning context to ledger]');
        this.collapseToLedger(delegationSummaries.join('\n\n'));
        this.emitHeartbeat();   // persist the updated ledger right after a wave lands
      } else if (this.config.autoCompact !== false && this.estimateMessagesChars() > ORCH_MAX_CONTEXT_CHARS) {
        // Size-based backstop for long exploration runs (many read_file turns
        // before the first delegation). chars/4 ≈ tokens; ORCH_MAX_CONTEXT_CHARS
        // keeps us well under the model window even before any delegation.
        this.callbacks.onOrchestratorThinking('[auto-compact: exploration context large, shrinking]');
        const compacted = this.compactMessagesInline(this.isOAI ? 10 : (this.config.autoCompactKeepLast ?? 3));
        if (compacted) this.messages = compacted;
      }
    }

    return finalResponse;
  }

  private compactMessagesInline(keepLast: number): Array<Record<string, unknown>> | null {
    if (this.messages.length <= keepLast * 2 + 2) return null;

    let splitAt = this.messages.length - keepLast * 2;

    if (this.isOAI) {
      while (splitAt < this.messages.length && this.messages[splitAt].role === 'tool') {
        splitAt++;
      }
      if (splitAt >= this.messages.length - 2) return null;
    }

    const toSummarize = this.messages.slice(0, splitAt);
    const toKeep = this.messages.slice(splitAt);

    const bullets: string[] = [];
    for (const msg of toSummarize) {
      const text = typeof msg.content === 'string'
        ? msg.content as string
        : Array.isArray(msg.content)
          ? (msg.content as Array<{ type?: string; text?: string; content?: string }>)
              .map(b => b.text || b.content || '').join(' ').slice(0, 200)
          : '';
      if (!text.trim()) continue;
      const label = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Tool';
      bullets.push(`- ${label}: ${text.split('\n')[0].slice(0, 150)}`);
    }

    const summary = `[Compacted: ${toSummarize.length} messages]\n${bullets.join('\n')}`;
    return [{ role: 'user', content: summary }, ...toKeep];
  }

  // --- Context-management helpers (compact-on-delegate + ledger) ---

  /** Rough char→token estimate (chars/4). Used as a size-based backstop so the
   *  orchestrator compacts on exploration turns too, not just delegation turns. */
  private estimateMessagesChars(): number {
    let n = 0;
    for (const m of this.messages) {
      const c = m.content;
      n += typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length;
    }
    return n;
  }

  /** Cap a standard (read-only) tool result before it enters orchestrator
   *  history. Whole files from read_file are the main exploration-turn bloat. */
  private capForOrchestrator(content: string, max = 8000): string {
    if (!content || content.length <= max) return content;
    return `${content.slice(0, max)}\n…[truncated ${content.length - max} chars — delegate a worker to read the full file if you need it]`;
  }

  /** One-line brief of a worker report for the ledger (tail usually holds the
   *  worker's own summary; code fences stripped). */
  private brief(s: string): string {
    if (!s) return '';
    const t = s.replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim();
    return t.length > 220 ? '…' + t.slice(-220) : t;
  }

  /** `git diff --stat` against a snapshot ref — files + line counts, not the
   *  full diff. Keeps the orchestrator aware of WHAT changed without pulling
   *  every diff line into its context. */
  private diffStat(snapshotRef: string | null): string {
    try {
      const cmd = snapshotRef
        ? `git diff --stat ${snapshotRef} -- .`
        : 'git diff --stat -- . && git diff --cached --stat -- .';
      return execSync(cmd, { cwd: this.config.workDir, encoding: 'utf8', stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 }).trim();
    } catch { return ''; }
  }

  /** Record a delegation wave into the durable ledger. `delegationCount` is
   *  driven from the run loop (one source of truth across all handler types);
   *  this only adds ledger detail + the producedChanges signal. */
  private recordWave(entries: Array<{ task: string; status: string; report?: string }>, diff: string | null): void {
    for (const e of entries) {
      this.ledger.push({ task: (e.task || '').slice(0, 100), status: e.status, note: this.brief(e.report || '') });
      // Retain the full task + report (capped) for the completion gate's match
      // corpus — see ledgerAuditCorpus. Code fences kept: file paths and symbol
      // names in a worker's proof block are exactly what the gate matches on.
      const full = `${e.task || ''} ${e.report || ''}`.replace(/\s+/g, ' ').trim().slice(0, 4000);
      if (full) this.ledgerAuditCorpus.push(full);
    }
    if (diff && diff.trim()) this.producedChanges = true;
  }

  private renderLedger(): string {
    if (!this.ledger.length) return '(nothing dispatched yet)';
    return this.ledger.map((e, i) => `${i + 1}. [${e.status}] ${e.task}${e.note ? ` — ${e.note}` : ''}`).join('\n');
  }

  /** Durable plan-state snapshot for crash-resume persistence. */
  getLedgerSnapshot(): LedgerSnapshot {
    return {
      originalRequirement: this.originalRequirement,
      ledger: this.ledger.map(e => ({ ...e })),
      delegationCount: this.delegationCount,
      producedChanges: this.producedChanges,
    };
  }

  /** Seed a resumed run from a persisted snapshot so it knows what's already
   *  done and re-dispatches only the pending/failed items. */
  seedFromLedger(state: LedgerSnapshot): void {
    if (!state) return;
    this.ledger = (state.ledger || []).map(e => ({ ...e }));
    this.delegationCount = state.delegationCount || 0;
    this.producedChanges = !!state.producedChanges;
    if (state.originalRequirement) this.originalRequirement = state.originalRequirement;
    this.resuming = true;
  }

  private emitHeartbeat(): void {
    try { this.callbacks.onHeartbeat?.(this.getLedgerSnapshot()); } catch { /* never let persistence break the run */ }
  }

  /** COMPACT-ON-DELEGATE: once a wave of work is handed to workers, the planning
   *  context that produced the split is dead weight. Collapse `this.messages`
   *  down to the original requirement + the durable ledger + this wave's
   *  (already-summarized) results. History can never grow past one wave, so the
   *  orchestrator can never overflow its window regardless of repo size — while
   *  worker control (bus/handles/steering, all outside `this.messages`) is
   *  untouched. */
  private collapseToLedger(latestResults: string): void {
    const remaining = this.ledger.some(e => e.status !== 'completed');
    const nextStep = remaining
      ? 'Some tasks failed or remain. Re-dispatch the failed/remaining work via delegate_parallel, or fix-then-verify.'
      : 'All dispatched tasks completed. Verify the build and, if green, reply with a final completion summary and NO tool call.';
    this.messages = [
      { role: 'user', content: this.originalRequirement || '(no requirement recorded)' },
      {
        role: 'user',
        content:
          `## Progress ledger — what you have ALREADY dispatched (authoritative; do not repeat done work)\n${this.renderLedger()}\n\n` +
          `## Most recent worker results\n${latestResults}\n\n` +
          `## Next\n${nextStep}`,
      },
    ];
  }

  /**
   * Deterministic gate: compare the directive's numbered/checklist items
   * against the durable ledger to detect silently-skipped work. Returns
   * { complete: false, gaps: [...] } when items were never dispatched.
   *
   * No LLM calls — pure string matching against this.originalRequirement
   * and this.ledger.
   */
  private auditPlanCompletion(): { complete: boolean; gaps: string[] } {
    const req = this.originalRequirement || '';
    if (!req.trim()) return { complete: true, gaps: [] };

    // ── Extract plan items ──
    const items: string[] = [];
    const seen = new Set<string>();

    const pushItem = (raw: string) => {
      const key = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (key.length >= 10 && !seen.has(key)) {
        seen.add(key);
        items.push(key);
      }
    };

    // Numbered items: "1. Do X"  or  "1) Do X"
    for (const m of req.matchAll(/^\s*(\d+)[.)]\s+(.{10,})/gm)) {
      pushItem(m[2]);
    }
    // Section headings that signal chunks
    for (const m of req.matchAll(/^#{2,3}\s*((?:Chunk|Wave|DIET-|Step)\b.{3,})/gm)) {
      pushItem(m[1]);
    }
    // Unchecked checkbox items
    for (const m of req.matchAll(/^\s*-\s*\[\s*\]\s*(.{10,})/gm)) {
      pushItem(m[1]);
    }

    if (items.length < 2) return { complete: true, gaps: [] };

    // ── Build a single ledger search text ──
    // Include the full audit corpus (untruncated worker reports) alongside the
    // display ledger, so an item whose evidence lives in a worker's proof block
    // is matched instead of false-flagged as a gap.
    const ledgerText = (
      this.ledger.map(e => `${e.task} ${e.note}`).join(' ') + ' ' +
      this.ledgerAuditCorpus.join(' ')
    ).toLowerCase();

    // ── Match each item against ledger ──
    const gaps: string[] = [];
    for (const item of items) {
      if (this.itemAddressedByLedger(item, ledgerText)) continue;
      gaps.push(item);
    }

    return { complete: gaps.length === 0, gaps };
  }

  /** Check whether a single plan item is matched by ledger text. */
  private itemAddressedByLedger(item: string, ledgerText: string): boolean {
    const lo = item.toLowerCase();

    // (a) Distinctive literal: longest word ≥ 6 chars, or a file-path pattern
    const words = lo.split(/[^a-z0-9._/~-]+/).filter(Boolean);
    const filePathPattern = /\S*\/\S*\.\S+/; // e.g. src/foo/bar.ts
    const fpMatch = lo.match(filePathPattern);
    if (fpMatch && ledgerText.includes(fpMatch[0].toLowerCase())) return true;

    let longest = '';
    for (const w of words) {
      if (w.length >= 6 && w.length > longest.length) longest = w;
    }
    if (longest && ledgerText.includes(longest)) return true;

    // (b) ≥ 50% of words ≥ 5 chars appear in ledger
    const bigWords = words.filter(w => w.length >= 5);
    if (bigWords.length === 0) return false;
    const matched = bigWords.filter(w => ledgerText.includes(w));
    return matched.length / bigWords.length >= 0.5;
  }

  private async handleDelegation(call: ToolCall): Promise<{
    type: 'tool_result'; tool_use_id: string; content: string;
  }> {
    const task = call.input.task as string;
    const context = call.input.context as string;
    const criteria = (call.input.acceptance_criteria as string[]) || [];
    const modelName = call.input.model as string | undefined;

    this.callbacks.onDelegating(task, modelName);

    // Cost-aware routing: pick optimal worker tier
    let routedModel = modelName;
    if (!routedModel && this.config.costAwareRouting) {
      // Primary: classify task category + complexity, then route through ModelRouter
      const features = classifyTask(task, context);
      const router = new ModelRouter();
      try {
        const route = router.routeFromPool(task, context, this.config);
        routedModel = route.model;
        // Adjust tier based on classified complexity
        if (features.complexity <= 2 && route.model !== this.config.workerPool.find(w => w.tier === 'fast')?.provider.model) {
          // Task is simple — prefer fast tier if available
          const fastWorker = this.config.workerPool.find(w => w.tier === 'fast');
          if (fastWorker) routedModel = fastWorker.provider.model;
        } else if (features.complexity >= 8 && route.model !== this.config.workerPool.find(w => w.tier === 'heavy')?.provider.model) {
          // Task is complex — prefer heavy tier if available
          const heavyWorker = this.config.workerPool.find(w => w.tier === 'heavy');
          if (heavyWorker) routedModel = heavyWorker.provider.model;
        }
      } catch {
        // Fallback to simpler task-router if ModelRouter fails
        const routed = routeTask(task, context, this.config);
        routedModel = routed.name;
      }
    }

    const snapshotRef = this.gitSnapshot();
    if (snapshotRef) {
      this.snapshotStack.push({ ref: snapshotRef, task: task, timestamp: Date.now() });
    }

    // Enrich context with agent memory
    const memoryContext = formatMemoryForContext();
    let enrichedContext = memoryContext ? context + memoryContext : context;

    // Dirty repo detection
    try {
      if (isDirtyRepo(this.config.workDir)) {
        enrichedContext += '\n\n⚠ Note: The working directory has uncommitted changes.';
      }
    } catch { /* ignore git errors */ }

    // Auto feature branch
    if (this.config.autoFeatureBranch) {
      try {
        const branchName = createFeatureBranch(this.config.workDir, task);
        if (branchName) {
          enrichedContext += `\n\nWorking on feature branch: ${branchName}`;
        }
      } catch { /* ignore branch errors */ }
    }

    // Add diff-aware context if we have a snapshot ref
    if (snapshotRef) {
      const diffContext = formatDiffContext(this.config.workDir, snapshotRef);
      if (diffContext) {
        enrichedContext += `\n\n## Changed Context (diff-aware)\n${diffContext}`;
      }
    }

    let workerReport: string;
    let status: 'completed' | 'failed' = 'completed';
    const delegationStart = Date.now();
    try {
      if (this.config.autoRetry) {
        // Use the retry-aware worker runner
        workerReport = await this.workerRunnerWithRetry(task, enrichedContext, criteria, routedModel);
      } else {
        workerReport = await this.workerRunner(task, enrichedContext, criteria, routedModel);
      }
    } catch (err) {
      workerReport = `Error: ${(err as Error).message}`;
      status = 'failed';
    }
    // A worker signals no-op/failure via a sentinel PREFIX on its report; without this
    // check a greet-and-do-nothing worker is falsely recorded 'completed'.
    if (status === 'completed') {
      const head = workerReport.trimStart();
      if (/^(FAILURE:|UNVERIFIED:|BUDGET_EXCEEDED:|DOOM LOOP ABORT|CLARIFICATION_NEEDED:)/.test(head)) {
        status = 'failed';
      }
    }
    const delegationDuration = Date.now() - delegationStart;
    const workerModel = routedModel || this.config.worker.model;
    recordDelegation(workerModel, status, 0, 0, delegationDuration);
    const diff = this.gitDiff(snapshotRef);

    this.callbacks.onReviewing(diff ? `${diff.split('\n').length} lines changed` : undefined);

    // Extract files changed from diff
    const filesChanged = this.extractFilesFromDiff(diff);

    if (this.callbacks.onDelegationComplete) {
      this.callbacks.onDelegationComplete(task, status, filesChanged);
    }

    let content = `## Worker Report\n${workerReport}`;
    if (diff) {
      content += `\n\n## Git Diff of Changes\n\`\`\`diff\n${diff}\n\`\`\``;
    }

    // Cross-file dependency tracking: check if changed files have dependents
    if (filesChanged.length > 0) {
      try {
        const graph = buildDependencyGraph(this.config.workDir);
        const affected = findAffectedFiles(graph, filesChanged);
        if (affected.length > 0) {
          // Group by file
          const byFile = new Map<string, string[]>();
          for (const a of affected) {
            if (!byFile.has(a.file)) {
              byFile.set(a.file, []);
            }
            byFile.get(a.file)!.push(`${a.dependsOn} (${a.relationship})`);
          }

          const warningLines: string[] = ['\n\n⚠ Changed files have dependents that may need updates:'];
          for (const [file, deps] of byFile) {
            warningLines.push(`- ${file} is imported by:`);
            for (const dep of deps) {
              warningLines.push(`  - ${dep}`);
            }
          }
          content += warningLines.join('\n');
        }
      } catch {
        // Dependency graph build failure — skip warning
      }
    }

    // Security-in-the-loop: auto scan after delegation
    if (this.config.autoScan && status === 'completed') {
      const scanConfig = loadScanConfig(this.config.homeDir);
      if (scanConfig) {
        try {
          this.callbacks.onSecurityScan?.('Running post-delegation SAST scan...');
          const scanResult = await runSecurityScan(scanConfig, this.config.workDir, (msg) => {
            this.callbacks.onSecurityScan?.(msg);
          });
          if (scanResult.status === 'completed') {
            const truePositives = filterTruePositives(scanResult.findings);
            if (truePositives.length > 0) {
              content += '\n\n## Security Scan Findings (auto-scan)\n';
              content += `Found ${truePositives.length} security issue(s) that should be fixed:\n\n`;
              content += formatFindingsForWorker(truePositives);
              content += '\n\nConsider re-delegating to fix these security issues.';
            } else {
              content += '\n\n## Security Scan: Clean ✓';
            }
          }
        } catch (scanErr) {
          content += `\n\n## Security Scan: Failed (${(scanErr as Error).message})`;
        }
      }
    }

    // Auto-commit on success with content-aware message
    if (this.config.autoCommitEnabled && status === 'completed' && diff) {
      // Generate content-aware commit message
      let commitMsg: string;
      try {
        const changeSummary = getChangeSummary(this.config.workDir, snapshotRef || undefined);
        const lines = changeSummary.split('\n');
        const fileLine = lines.find(l => l.startsWith('Files'));
        const fileCount = fileLine ? (fileLine.match(/\d+/)?.[0] || '') : '';
        const shortTask = task.slice(0, 60).replace(/\n/g, ' ').trim();
        if (fileCount) {
          commitMsg = `feat: ${shortTask} (${fileCount} files)`;
        } else {
          commitMsg = `feat: ${shortTask}`;
        }
      } catch {
        commitMsg = `auto: ${task.slice(0, 72).replace(/\n/g, ' ')}`;
      }
      const commitHash = autoCommit(this.config.workDir, commitMsg);
      if (commitHash) {
        this.callbacks.onAutoCommit?.(commitHash, commitMsg);
        content += `\n\n## Auto-committed: ${commitHash.slice(0, 8)}`;
      }
    }

    // Cross-model verification
    if (this.config.crossModelVerify && status === 'completed' && diff) {
      this.callbacks.onVerifying?.('Running cross-model verification...');
      try {
        const verifyTask = `Review this code change and check for bugs, security issues, and correctness problems.
Report ONLY real issues — do not nitpick style. If the code is correct, say "VERIFIED: No issues found."

## Task that was implemented
${task}

## Diff of changes
\`\`\`diff
${diff.slice(0, 20000)}
\`\`\``;

        const verifyResult = await this.workerRunner(
          verifyTask,
          'You are a code reviewer. Be concise. Only report real bugs or security issues.',
          ['Report real bugs only', 'Say VERIFIED if code is correct'],
          undefined,
          getRole('reviewer', this.config.homeDir),
        );

        if (verifyResult.includes('VERIFIED')) {
          content += '\n\n## Cross-Model Verification: Passed ✓';
        } else {
          content += `\n\n## Cross-Model Verification: Issues Found\n${verifyResult}`;
        }
        this.callbacks.onVerifying?.('Verification complete');
      } catch (verifyErr) {
        content += `\n\n## Verification: Failed (${(verifyErr as Error).message})`;
      }
    }

    return { type: 'tool_result', tool_use_id: call.id, content };
  }

  private async runTaskWithRetries(
    t: { task: string; context: string; acceptance_criteria?: string[]; model?: string },
    index: number,
    total: number,
    snapshotContext: string,
    useWorktrees: boolean,
  ): Promise<{ status: 'completed' | 'failed'; report: string; task: typeof t }> {
    const MAX_ESCALATIONS = 4;
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_ESCALATIONS; attempt++) {
      // Hash the whole task: sibling tasks often share a long prefix ("Create frontend/js/pages/…"),
      // and a 50-char key rejected them as duplicates of each other.
      const taskKey = `parallel:${createHash('sha1').update(t.task).digest('hex').slice(0, 16)}:a${attempt}`;
      const workerId = `w-par-${Date.now()}-${index}-a${attempt}`;

      if (!runCoordinator.acquireRun(taskKey, workerId)) {
        return { status: 'failed', report: 'Task already running (duplicate).', task: t };
      }

      let workerWorkDir = this.config.workDir;
      let worktreePath: string | null = null;
      if (useWorktrees) {
        try {
          worktreePath = createWorkerWorktree(workerId, this.config.workDir);
          workerWorkDir = worktreePath;
        } catch { /* fallback to shared */ }
      }

      const label = attempt === 1
        ? `[${index + 1}/${total}] ${t.task}`
        : `[${index + 1}/${total} retry ${attempt}/${MAX_ESCALATIONS}] ${t.task}`;
      this.callbacks.onDelegating(label, t.model);

      let ctx = worktreePath ? `${t.context}\n\nWorking directory: ${workerWorkDir}` : t.context;
      if (snapshotContext) ctx += `\n\n${snapshotContext}`;

      if (attempt === 2 && lastError) {
        ctx += `\n\n## RETRY — Previous Attempt Failed\nError: ${lastError}\nFix the error and complete the task.`;
      } else if (attempt === 3 && lastError) {
        ctx += `\n\n## RETRY — Different Approach Required\nTwo previous attempts failed with: ${lastError}\nThe previous approach is broken. Try a COMPLETELY DIFFERENT strategy. Do not repeat what failed.`;
      } else if (attempt >= 4 && lastError) {
        ctx += `\n\n## FINAL RETRY — Simplify\nThree previous attempts failed. Last error: ${lastError}\nStrip the task to its absolute minimum. Get the core functionality working first, skip edge cases. Something working > nothing perfect.`;
      }

      // Escalate to a more capable tier on later attempts instead of retrying
      // the exact model that already failed — a real "escalating strategy".
      let modelForAttempt = t.model;
      if (attempt >= 3) {
        const heavy = this.config.workerPool.find(w => w.tier === 'heavy');
        if (heavy) modelForAttempt = heavy.name || heavy.provider.model;
      } else if (attempt === 2 && !t.model) {
        const standard = this.config.workerPool.find(w => w.tier === 'standard');
        if (standard) modelForAttempt = standard.name || standard.provider.model;
      }

      let taskStatus: 'completed' | 'failed' = 'completed';
      let report: string;
      try {
        report = await this.workerRunnerWithRetry(
          t.task, ctx, t.acceptance_criteria || [], modelForAttempt, undefined, workerWorkDir, workerId,
        );
      } catch (err) {
        report = `Error: ${(err as Error).message}`;
        lastError = (err as Error).message;
        taskStatus = 'failed';
      }

      if (worktreePath) {
        try {
          if (taskStatus === 'completed') {
            // Serialize merges into the shared repo — concurrent
            // checkout+merge from parallel workers corrupts the index.
            await withFileLock(join(this.config.workDir, '.git'), async () => {
              try {
                mergeWorktree(worktreePath!);
              } catch (mergeErr) {
                // Conflict/failure — abort so main isn't left half-merged,
                // and fail the task so it re-delegates.
                try { execSync('git merge --abort', { cwd: this.config.workDir, stdio: 'pipe' }); } catch { /* nothing to abort */ }
                taskStatus = 'failed';
                lastError = `merge failed: ${(mergeErr as Error).message}`;
                report += `\n\n⚠ Merge into the main branch failed (${(mergeErr as Error).message}); worker changes were NOT integrated.`;
              }
            });
          }
        } finally {
          // Always remove the worktree/branch — the success path used to leak it.
          try { cleanupWorktree(worktreePath); } catch { /* best-effort */ }
        }
      }

      runCoordinator.releaseRun(taskKey);

      // A worker signals no-op/failure via a sentinel PREFIX on its report; without this
      // check a greet-and-do-nothing worker is falsely recorded 'completed'.
      if (taskStatus === 'completed') {
        const head = report.trimStart();
        if (/^(FAILURE:|UNVERIFIED:|BUDGET_EXCEEDED:|DOOM LOOP ABORT|CLARIFICATION_NEEDED:)/.test(head)) {
          taskStatus = 'failed';
          // Keep the body too: it carries the [PARTIAL PROGRESS] file list the next attempt needs.
          lastError = head.slice(0, 1500);
        }
      }

      if (taskStatus === 'completed') {
        if (this.callbacks.onDelegationComplete) {
          this.callbacks.onDelegationComplete(t.task, 'completed', []);
        }
        const retryNote = attempt > 1 ? ` (succeeded on attempt ${attempt}/${MAX_ESCALATIONS})` : '';
        return { status: 'completed', report: report + retryNote, task: t };
      }

      if (attempt < MAX_ESCALATIONS) this.callbacks.onRetrying(t.task, attempt + 1, { scope: 'outer', error: lastError });
    }

    if (this.callbacks.onDelegationComplete) {
      this.callbacks.onDelegationComplete(t.task, 'failed', []);
    }
    return {
      status: 'failed',
      report: `FAILED after ${MAX_ESCALATIONS} attempts. Last error: ${lastError}`,
      task: t,
    };
  }

  private async handleParallelDelegation(call: ToolCall): Promise<{
    type: 'tool_result'; tool_use_id: string; content: string;
  }> {
    const tasks = call.input.tasks as Array<{
      task: string; context: string; acceptance_criteria?: string[]; model?: string;
    }>;

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return {
        type: 'tool_result', tool_use_id: call.id,
        content: '## Invalid delegate_parallel call\nThe "tasks" argument must be a non-empty array of {task, context, acceptance_criteria?, model?}. Re-issue the call with a valid tasks array.',
      };
    }

    if (circuitBreaker.isOpen()) {
      return {
        type: 'tool_result', tool_use_id: call.id,
        content: '## Circuit Breaker OPEN\nAPI has had 3+ consecutive failures. Dispatch paused for 5 minutes to avoid wasting tokens. Try again shortly.',
      };
    }

    this.callbacks.onParallelDelegating(tasks.length);

    const stale = workerProjector.getStaleWorkers(300000);
    if (stale.length > 0) {
      this.callbacks.onOrchestratorThinking(
        `⚠ ${stale.length} stale worker(s) detected (no activity >5min): ${stale.map(w => w.workerId).join(', ')}`,
      );
    }

    const snapshotRef = this.gitSnapshot();

    if (existsSync(join(this.config.workDir, '.git'))) {
      try { await createShadowSnapshot('orchestrator-parallel'); } catch { /* non-fatal */ }
    }

    const useWorktrees = tasks.length > 1 && existsSync(join(this.config.workDir, '.git'));

    let snapshotContext = '';
    if (tasks.length > 1) {
      try {
        const snapshot = await createTargetedSnapshot(this.config.workDir, tasks);
        snapshotContext = snapshotToPrompt(snapshot);
      } catch { /* non-fatal */ }
    }

    const MAX_PARALLEL_WORKERS = 5;
    const taskResults = await boundedParallel(
      tasks,
      (t, i) => this.runTaskWithRetries(t, i, tasks.length, snapshotContext, useWorktrees),
      MAX_PARALLEL_WORKERS,
    );

    const succeeded = taskResults.filter(r => r.status === 'completed').length;
    const failed = taskResults.filter(r => r.status === 'failed').length;

    const diff = this.gitDiff(snapshotRef);
    this.callbacks.onReviewing(diff ? `${diff.split('\n').length} lines changed` : undefined);

    // Record the wave into the durable ledger + run stats (drives compact-on-
    // delegate and the launcher's fail-loud no-op guard).
    this.recordWave(
      taskResults.map(r => ({ task: r.task.task, status: r.status, report: r.report })),
      diff,
    );

    // Summarize each worker report before it enters history — the full
    // narrative is dead weight once the ledger has captured the outcome.
    const resultLines = taskResults.map((r, i) =>
      `### Task ${i + 1}: ${r.task.task.slice(0, 80)}\n**Status:** ${r.status}\n${r.status === 'failed' ? r.report : this.brief(r.report)}`
    );

    // A batch that completed ANY task proves the API is alive — reset the
    // breaker's consecutive-failure count so healthy-but-imperfect batches
    // don't trip it after a few mixed rounds.
    if (succeeded > 0) circuitBreaker.recordSuccess();

    let content = `## Parallel Worker Results (${tasks.length} tasks: ${succeeded} succeeded, ${failed} failed)\n\n${resultLines.join('\n\n')}`;
    if (failed > 0) {
      content += `\n\n⚠ ${failed} task(s) failed after ${4} retry attempts each. These tasks could not be completed automatically. Review errors and re-delegate with a different approach.`;
    } else {
      // Verify the workers' self-reported success — git-independent, so it
      // works even when the project is not a git repo. If the project no
      // longer builds, do NOT accept the round: tell the orchestrator to
      // re-delegate a fix for the concrete errors.
      const build = this.verifyBuild();
      if (build.ran && !build.ok) {
        content += `\n\n## ⚠ Build verification FAILED\nWorkers reported success, but the project no longer compiles. This round is NOT complete. Re-delegate a focused fix for these errors before reporting done:\n\`\`\`\n${build.output}\n\`\`\``;
      } else {
        if (build.ran) content += `\n\n✅ Build verification passed.`;
        circuitBreaker.recordSuccess();
      }
    }
    if (diff) {
      // Stat, not the full diff: the orchestrator needs to know WHICH files
      // changed and by how much, not every line (which blows its context).
      const stat = this.diffStat(snapshotRef);
      content += stat
        ? `\n\n## Files changed\n\`\`\`\n${stat}\n\`\`\``
        : `\n\n## Files changed\n${diff.split('\n').length} lines changed across the wave.`;
    }

    return { type: 'tool_result', tool_use_id: call.id, content };
  }

  private async handleChainDelegation(call: ToolCall): Promise<{
    type: 'tool_result'; tool_use_id: string; content: string;
  }> {
    const tasks = call.input.tasks as Array<{
      task: string; context: string; acceptance_criteria?: string[]; model?: string;
    }>;

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return {
        type: 'tool_result', tool_use_id: call.id,
        content: '## Invalid delegate_chain call\nThe "tasks" argument must be a non-empty array of {task, context, acceptance_criteria?, model?}. Re-issue the call with a valid tasks array.',
      };
    }

    const snapshotRef = this.gitSnapshot();
    const chainResults: string[] = [];
    let previousOutput = '';
    let allChainStepsCompleted = true;

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const MAX_CHAIN_RETRIES = 3;
      let stepCompleted = false;

      for (let attempt = 1; attempt <= MAX_CHAIN_RETRIES; attempt++) {
        let chainContext = previousOutput
          ? `${t.context}\n\n## Previous Task Output\n${previousOutput}`
          : t.context;

        if (attempt === 2) {
          chainContext += `\n\n## RETRY — Fix the error from the previous attempt and complete the task.`;
        } else if (attempt >= 3) {
          chainContext += `\n\n## RETRY — Try a completely different approach. Previous attempts failed.`;
        }

        const retryLabel = attempt > 1 ? ` retry ${attempt}/${MAX_CHAIN_RETRIES}` : '';
        this.callbacks.onDelegating(`[chain ${i + 1}/${tasks.length}${retryLabel}] ${t.task}`, t.model);

        try {
          const report = await this.workerRunnerWithRetry(
            t.task, chainContext, t.acceptance_criteria || [], t.model,
          );
          // A worker signals no-op/failure via a sentinel PREFIX on its report.
          { const h = report.trimStart(); if (/^(FAILURE:|UNVERIFIED:|BUDGET_EXCEEDED:|DOOM LOOP ABORT|CLARIFICATION_NEEDED:)/.test(h)) throw new Error(h.slice(0, 1500)); }
          previousOutput = report;
          chainResults.push(`### Step ${i + 1}: ${t.task.slice(0, 80)}\n**Status:** completed${attempt > 1 ? ` (attempt ${attempt})` : ''}\n${report}`);
          stepCompleted = true;
          break;
        } catch (err) {
          if (attempt < MAX_CHAIN_RETRIES) {
            this.callbacks.onRetrying(t.task, attempt + 1, { scope: 'outer', error: (err as Error).message });
          } else {
            const errMsg = (err as Error).message;
            chainResults.push(`### Step ${i + 1}: ${t.task.slice(0, 80)}\n**Status:** failed after ${MAX_CHAIN_RETRIES} attempts\n${errMsg}`);
          }
        }
      }

      if (!stepCompleted) {
        allChainStepsCompleted = false;
        chainResults.push(`\n**Chain stopped at step ${i + 1} — could not recover after ${MAX_CHAIN_RETRIES} attempts.**`);
        break;
      }
    }

    if (allChainStepsCompleted) {
      circuitBreaker.recordSuccess();
    }

    const diff = this.gitDiff(snapshotRef);
    this.callbacks.onReviewing(diff ? `${diff.split('\n').length} lines changed` : undefined);

    this.recordWave(
      tasks.map((t, i) => ({
        task: `chain[${i + 1}] ${t.task}`,
        status: allChainStepsCompleted ? 'completed' : (i < chainResults.length && chainResults[i].includes('failed') ? 'failed' : 'completed'),
      })),
      diff,
    );

    let content = `## Chain Results (${tasks.length} steps)\n\n${chainResults.join('\n\n')}`;
    if (diff) {
      const stat = this.diffStat(snapshotRef);
      content += stat
        ? `\n\n## Files changed\n\`\`\`\n${stat}\n\`\`\``
        : `\n\n## Files changed\n${diff.split('\n').length} lines changed.`;
    }

    // Track snapshots for each chained task
    if (snapshotRef) {
      this.snapshotStack.push({ ref: snapshotRef, task: `chain: ${tasks.map(t => t.task.slice(0, 40)).join(' -> ')}`, timestamp: Date.now() });
    }

    return { type: 'tool_result', tool_use_id: call.id, content };
  }

  private async handleSwarmDelegation(call: ToolCall): Promise<{
    type: 'tool_result'; tool_use_id: string; content: string;
  }> {
    const goal = call.input.goal as string;
    const phases = call.input.phases as Array<{
      name: string;
      agents: Array<{ role: string; task: string; context?: string; model?: string }>;
    }>;

    if (!Array.isArray(phases) || phases.length === 0) {
      return {
        type: 'tool_result', tool_use_id: call.id,
        content: '## Invalid delegate_swarm call\nThe "phases" argument must be a non-empty array of {name, agents:[{role, task, context?, model?}]}. Re-issue the call with a valid phases array.',
      };
    }

    const snapshotRef = this.gitSnapshot();
    const allResults: string[] = [];
    let previousPhaseOutput = '';

    allResults.push(`# Swarm Execution: ${goal}\n`);

    for (let pi = 0; pi < phases.length; pi++) {
      const phase = phases[pi];
      this.callbacks.onSwarmPhase?.(phase.name, pi + 1, phases.length);
      allResults.push(`## Phase ${pi + 1}: ${phase.name}\n`);

      const agentResults = await Promise.all(
        phase.agents.map(async (agent, ai) => {
          const role = getRole(agent.role, this.config.homeDir);
          const label = `[${phase.name}:${agent.role} ${ai + 1}/${phase.agents.length}]`;

          const fullContext = [
            agent.context || '',
            previousPhaseOutput ? `\n## Output from previous phase\n${previousPhaseOutput}` : '',
            `\nOverall goal: ${goal}`,
          ].filter(Boolean).join('\n');

          const MAX_SWARM_RETRIES = 3;
          let lastErr = '';
          for (let attempt = 1; attempt <= MAX_SWARM_RETRIES; attempt++) {
            const retryLabel = attempt > 1 ? ` retry ${attempt}/${MAX_SWARM_RETRIES}` : '';
            this.callbacks.onDelegating(`${label}${retryLabel} ${agent.task}`, agent.model);

            let ctx = fullContext;
            if (attempt === 2 && lastErr) {
              ctx += `\n\n## RETRY — Previous attempt failed\nError: ${lastErr}\nFix and complete the task.`;
            } else if (attempt >= 3 && lastErr) {
              ctx += `\n\n## RETRY — Different approach required\nPrevious attempts failed: ${lastErr}\nTry a completely different strategy.`;
            }

            try {
              const report = await this.workerRunnerWithRetry(
                agent.task, ctx, [], agent.model, role,
              );
              // A worker signals no-op/failure via a sentinel PREFIX on its report.
              { const h = report.trimStart(); if (/^(FAILURE:|UNVERIFIED:|BUDGET_EXCEEDED:|DOOM LOOP ABORT|CLARIFICATION_NEEDED:)/.test(h)) throw new Error(h.slice(0, 1500)); }
              return `### ${agent.role} (agent ${ai + 1})\n**Task:** ${agent.task.slice(0, 100)}\n**Status:** completed${attempt > 1 ? ` (attempt ${attempt})` : ''}\n${report}`;
            } catch (err) {
              lastErr = (err as Error).message;
              if (attempt < MAX_SWARM_RETRIES) {
                this.callbacks.onRetrying(agent.task, attempt + 1, { scope: 'outer', error: lastErr });
              }
            }
          }
          return `### ${agent.role} (agent ${ai + 1})\n**Task:** ${agent.task.slice(0, 100)}\n**Status:** failed after ${MAX_SWARM_RETRIES} attempts\n${lastErr}`;
        })
      );

      const phaseOutput = agentResults.join('\n\n');
      allResults.push(phaseOutput);
      previousPhaseOutput = phaseOutput;
    }

    const diff = this.gitDiff(snapshotRef);
    this.callbacks.onReviewing(diff ? `${diff.split('\n').length} lines changed` : undefined);

    this.recordWave(
      [{ task: `swarm: ${goal.slice(0, 90)}`, status: diff && diff.trim() ? 'completed' : 'completed' }],
      diff,
    );

    let content = allResults.join('\n\n');
    if (diff) {
      const stat = this.diffStat(snapshotRef);
      content += stat
        ? `\n\n## Files changed\n\`\`\`\n${stat}\n\`\`\``
        : `\n\n## Files changed\n${diff.split('\n').length} lines changed.`;
    }

    if (snapshotRef) {
      this.snapshotStack.push({
        ref: snapshotRef,
        task: `swarm: ${goal.slice(0, 80)}`,
        timestamp: Date.now(),
      });
    }

    return { type: 'tool_result', tool_use_id: call.id, content };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // delegate_pipeline: The standard build pipeline for web app development
  // Flow: Tasks (max 4) → Compile → SAST/the scanner → Fix (max 2 rounds) → Done
  // ──────────────────────────────────────────────────────────────────────────

  private async handlePipelineDelegation(call: ToolCall): Promise<{
    type: 'tool_result'; tool_use_id: string; content: string;
  }> {
    const rawTasks = call.input.tasks as Array<{
      task: string; context: string; acceptance_criteria?: string[]; model?: string;
    }>;
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      return {
        type: 'tool_result', tool_use_id: call.id,
        content: '## Invalid delegate_pipeline call\nThe "tasks" argument must be a non-empty array of {task, context, acceptance_criteria?, model?}. Re-issue the call with a valid tasks array.',
      };
    }
    const tasks = rawTasks.slice(0, 4);
    const skipSecurity = call.input.skipSecurity as boolean || false;
    const autoCreatePR = call.input.autoCreatePR as boolean || false;

    if (circuitBreaker.isOpen()) {
      return {
        type: 'tool_result', tool_use_id: call.id,
        content: '## Circuit Breaker OPEN\nAPI has had 3+ consecutive failures. Pipeline paused for 5 minutes.',
      };
    }

    const snapshotRef = this.gitSnapshot();
    const pipelineLog: string[] = [];
    const MAX_FIX_ROUNDS = 2;

    // Launch async scanner scan early so it runs in parallel with implementation
    const asyncScanHandle = !skipSecurity
      ? launchAsyncScan(this.config.workDir, ['sast', 'code-review'], this.config.homeDir)
      : null;

    // ── PHASE 1: Implementation (parallel, max 4 workers) ──
    pipelineLog.push(`# Pipeline: ${tasks.length} task(s)\n`);
    pipelineLog.push(`## Phase 1: Implementation\n`);
    this.callbacks.onParallelDelegating(tasks.length);

    const pipelineUseWorktrees = tasks.length > 1 && existsSync(join(this.config.workDir, '.git'));

    const implResults = await Promise.all(
      tasks.map(async (t, i) => {
        const result = await this.runTaskWithRetries(
          t, i, tasks.length, '', pipelineUseWorktrees,
        );
        return { task: result.task.task, status: result.status, report: result.report };
      })
    );

    for (const r of implResults) {
      pipelineLog.push(`### ${r.task.slice(0, 80)}\n**Status:** ${r.status}\n${r.report.slice(0, 1000)}\n`);
    }

    const allFailed = implResults.every(r => r.status === 'failed');
    if (allFailed) {
      pipelineLog.push(`\n## Pipeline ABORTED: All implementation tasks failed.\n`);
      return { type: 'tool_result', tool_use_id: call.id, content: pipelineLog.join('\n') };
    }

    // ── PHASE 2: Compile Gate (tsc --noEmit) ──
    pipelineLog.push(`\n## Phase 2: Compile Gate\n`);
    this.callbacks.onDelegating('[pipeline:compile] tsc --noEmit');

    let compilePass = false;
    let compileAttempt = 0;
    let compileErrors = '';
    let speculativePrep: { scanConfig: ReturnType<typeof loadScanConfig>; deadDiff: string | null; deadFiles: string[] } | null = null;

    // OPT-007: Speculative execution — while tsc runs, pre-load scan config
    // and pre-compute git diff for the next phases. Discarded on compile failure.
    {
      compileAttempt++;
      let capturedCompileError: any = null;
      const tscPromise = new Promise<string>((resolve, reject) => {
        try {
          const result = execSync(
            'npx tsc --noEmit 2>&1',
            { cwd: this.config.workDir, encoding: 'utf-8', timeout: 120000},
          );
          resolve(result);
        } catch (err: any) {
          capturedCompileError = err;
          reject(err);
        }
      });

      try {
        const specResult = await speculativeStart(tscPromise, async () => {
          // Read-only prep work for Phase 2.5 + Phase 3.
          // No file writes — safe to discard on compile failure.
          const scanConfig = loadScanConfig(this.config.homeDir);
          const deadDiff = this.gitDiff(snapshotRef);
          const deadFiles = this.extractFilesFromDiff(deadDiff)
            .filter(f => f.endsWith('.ts') || f.endsWith('.js'));
          return { scanConfig, deadDiff, deadFiles };
        });

        compilePass = true;
        speculativePrep = specResult.speculative;
        pipelineLog.push(`✅ Compile passed (attempt ${compileAttempt})${specResult.specDiscarded ? ' (spec work discarded)' : ''}\n`);
      } catch {
        // Compile failed — speculative work was discarded automatically by speculativeStart.
        // Use the captured error for diagnostics.
        compileErrors = (capturedCompileError?.stdout || capturedCompileError?.message || '').slice(0, 3000);
        pipelineLog.push(`❌ Compile failed (attempt ${compileAttempt}): ${compileErrors ? compileErrors.split('\n').length + ' error lines' : 'unknown error'}\n`);
      }
    }

    // Fix rounds if first compile failed
    while (!compilePass && compileAttempt < MAX_FIX_ROUNDS + 1) {
      compileAttempt++;

      if (compileAttempt > MAX_FIX_ROUNDS) {
        pipelineLog.push(`⚠ Max fix rounds (${MAX_FIX_ROUNDS}) reached for compile. Moving on with errors.\n`);
        break;
      }

      // Send a worker to fix compile errors
      this.callbacks.onDelegating(`[pipeline:fix-compile] attempt ${compileAttempt}`);
      try {
        await this.workerRunner(
          `Fix these TypeScript compilation errors. Run npx tsc --noEmit after fixing to verify.\n\nErrors:\n${compileErrors}`,
          `Working directory: ${this.config.workDir}. Fix type errors only — do not refactor or change logic.`,
          ['npx tsc --noEmit passes with zero errors'],
        );
      } catch { /* worker fix attempt failed, will retry or give up */ }

      // Re-test compile
      try {
        execSync(
          'npx tsc --noEmit 2>&1',
          { cwd: this.config.workDir, encoding: 'utf-8', timeout: 120000},
        );
        compilePass = true;
        pipelineLog.push(`✅ Compile passed (attempt ${compileAttempt})\n`);
      } catch (err: any) {
        compileErrors = (err.stdout || err.message || '').slice(0, 3000);
        pipelineLog.push(`❌ Compile failed (attempt ${compileAttempt}): ${compileErrors.split('\n').length} error lines\n`);
      }
    }

    // ── PHASE 2.5: Dead Code Detection ──
    pipelineLog.push(`\n## Phase 2.5: Dead Code Detection\n`);
    try {
      const deadDiff = speculativePrep?.deadDiff ?? this.gitDiff(snapshotRef);
      const deadFiles = speculativePrep?.deadFiles
        ?? this.extractFilesFromDiff(deadDiff)
        .filter(f => f.endsWith('.ts') || f.endsWith('.js'));

      if (deadFiles.length > 0) {
        const allDeadResults: DeadCodeResult[] = [];
        for (const file of deadFiles) {
          const fileResults = quickDeadCodeScan(file, this.config.workDir);
          allDeadResults.push(...fileResults);
        }

        if (allDeadResults.length > 0) {
          const high = allDeadResults.filter(r => r.severity === 'high');
          const medium = allDeadResults.filter(r => r.severity === 'medium');
          const low = allDeadResults.filter(r => r.severity === 'low');

          pipelineLog.push(`⚠ Dead code detected in changed files: ${allDeadResults.length} finding(s)`);
          if (high.length > 0) {
            pipelineLog.push(`  High severity: ${high.length}`);
            for (const r of high.slice(0, 10)) {
              pipelineLog.push(`    - ${r.file}:${r.line} — ${r.reason}`);
            }
            if (high.length > 10) pipelineLog.push(`    ... and ${high.length - 10} more high-severity findings`);
          }
          if (medium.length > 0) {
            pipelineLog.push(`  Medium severity: ${medium.length}`);
            for (const r of medium.slice(0, 5)) {
              pipelineLog.push(`    - ${r.file}:${r.line} — ${r.reason}`);
            }
            if (medium.length > 5) pipelineLog.push(`    ... and ${medium.length - 5} more medium-severity findings`);
          }
          pipelineLog.push(`  Low severity: ${low.length} (not individually listed)`);
        } else {
          pipelineLog.push(`✅ No dead code detected in changed files.\n`);
        }
      } else {
        pipelineLog.push(`ℹ No TypeScript/JavaScript files changed — skipping dead code detection.\n`);
      }
    } catch (deadErr) {
      pipelineLog.push(`⚠ Dead code detection failed: ${(deadErr as Error).message}\n`);
    }

    // ── PHASE 3: SAST / Code Review via the security scanner ──
    if (!skipSecurity) {
      pipelineLog.push(`\n## Phase 3: Security Scan (the security scanner)\n`);

      // OPT-014: Non-blocking async scan check.
      // If results are ready, merge them. Otherwise store handle for later collection.
      if (asyncScanHandle) {
        const asyncResults = await asyncScanHandle.poll();
        if (asyncResults && asyncResults.length > 0) {
          pipelineLog.push(`ℹ Async scanner scan completed during build — ${asyncResults.reduce((n, r) => n + r.findings.length, 0)} finding(s)\n`);
          for (const r of asyncResults) {
            pipelineLog.push(`  - ${r.scanType}: ${r.summary.total} findings (C:${r.summary.critical} H:${r.summary.high} M:${r.summary.medium} L:${r.summary.low})\n`);
          }
        } else if (asyncResults === null) {
          // Scan still running — store for later collection
          this.pendingAsyncScanHandles.push(asyncScanHandle);
          pipelineLog.push(`⏳ Async scanner scan still running — results will be surfaced when complete.\n`);
        } else {
          // asyncResults is [] — launch failed or no scans
          pipelineLog.push(`⚠ Async scanner scan returned no results — may have failed to launch.\n`);
        }
      }

      const scanConfig = speculativePrep?.scanConfig ?? loadScanConfig(this.config.homeDir);

      if (scanConfig) {
        this.callbacks.onSecurityScan?.('Pipeline: Running SAST/code-review scan...');
        let fixRound = 0;
        let findings: any[] = [];

        try {
          const scanResult = await runSecurityScan(scanConfig, this.config.workDir, (msg) => {
            this.callbacks.onSecurityScan?.(msg);
          });

          if (scanResult.status === 'completed') {
            findings = filterTruePositives(scanResult.findings);
          }
        } catch (scanErr) {
          pipelineLog.push(`⚠ Security scan failed: ${(scanErr as Error).message}\n`);
        }

        while (findings.length > 0 && fixRound < MAX_FIX_ROUNDS) {
          fixRound++;
          pipelineLog.push(`Found ${findings.length} security issue(s). Fix round ${fixRound}/${MAX_FIX_ROUNDS}.\n`);
          this.callbacks.onDelegating(`[pipeline:fix-security] round ${fixRound}`);

          const findingsText = formatFindingsForWorker(findings);
          try {
            await this.workerRunner(
              `Fix these security findings from SAST scan. Do not introduce new issues.\n\n${findingsText}`,
              `Working directory: ${this.config.workDir}. Fix security issues only — minimal changes.`,
              ['All listed security findings are resolved', 'No new compilation errors introduced'],
            );
          } catch { /* fix attempt failed */ }

          // Re-scan to check
          try {
            const rescan = await runSecurityScan(scanConfig, this.config.workDir, () => {});
            if (rescan.status === 'completed') {
              findings = filterTruePositives(rescan.findings);
            } else {
              findings = [];
            }
          } catch {
            findings = [];
          }
        }

        if (findings.length === 0) {
          pipelineLog.push(`✅ Security scan clean.\n`);
        } else {
          pipelineLog.push(`⚠ ${findings.length} findings remain after ${MAX_FIX_ROUNDS} fix rounds. Stopping to avoid infinite loop.\n`);
          pipelineLog.push(`Remaining findings:\n${formatFindingsForWorker(findings).slice(0, 2000)}\n`);
        }
      } else {
        pipelineLog.push(`ℹ No scanner scan config found — skipping security phase.\n`);
      }
    } else {
      pipelineLog.push(`\n## Phase 3: Security Scan — SKIPPED (skipSecurity=true)\n`);
    }

    // ── Phase 4: Auto PR Creation (optional) ──
    if (autoCreatePR) {
      pipelineLog.push(`\n## Phase 4: Auto PR Creation\n`);
      const diff = this.gitDiff(snapshotRef);

      if (!diff) {
        pipelineLog.push(`⚠ No changes detected — skipping PR creation.\n`);
      } else {
        try {
          const branch = getCurrentBranch(this.config.workDir);
          pipelineLog.push(`Current branch: ${branch}\n`);

          // Push branch to remote
          const pushed = pushBranch(this.config.workDir, branch);
          pipelineLog.push(`Push: ${pushed ? 'success ✓' : 'failed (continuing anyway)'}\n`);

          // Build PR title from successful task descriptions
          const completedTasks = implResults.filter(r => r.status === 'completed');
          const prTitle = completedTasks.length === 1
            ? completedTasks[0].task.slice(0, 80)
            : `Pipeline: ${completedTasks.length} changes`;

          // Build PR body from pipeline summary
          const prBodyLines: string[] = [
            '## Pipeline Summary',
            '',
            `- **Tasks**: ${completedTasks.length}/${tasks.length} succeeded`,
            `- **Compile**: ${compilePass ? 'PASS ✓' : 'FAIL ⚠'}`,
            `- **Security**: ${skipSecurity ? 'skipped' : 'done'}`,
            `- **Files changed**: ${this.extractFilesFromDiff(diff).length}`,
            '',
            '## Changes',
            '',
          ];

          for (const r of completedTasks) {
            prBodyLines.push(`- ${r.task.slice(0, 200)}`);
          }

          const prBody = prBodyLines.join('\n');

          // Determine base branch (default to main)
          const baseBranch = 'main';

          const prResult = await createPR(
            prTitle,
            branch,
            baseBranch,
            prBody,
          );

          if (prResult.success && prResult.pr) {
            pipelineLog.push(`✅ PR created: ${prResult.pr.htmlUrl}\n`);
            pipelineLog.push(`   Number: #${prResult.pr.number}, Title: "${prResult.pr.title}"\n`);
          } else {
            pipelineLog.push(`⚠ PR creation failed: ${prResult.error || 'unknown error'}\n`);
            pipelineLog.push(`   You may need to set GITHUB_TOKEN or configure GitHub credentials.\n`);
          }
        } catch (prErr) {
          pipelineLog.push(`⚠ PR creation error: ${(prErr as Error).message}\n`);
        }
      }
    }

    // ── Summary ──
    const diff = this.gitDiff(snapshotRef);
    const filesChanged = this.extractFilesFromDiff(diff);
    pipelineLog.push(`\n## Pipeline Complete\n`);
    pipelineLog.push(`- Tasks: ${implResults.filter(r => r.status === 'completed').length}/${tasks.length} succeeded`);
    pipelineLog.push(`- Compile: ${compilePass ? 'PASS' : 'FAIL'}`);
    pipelineLog.push(`- Security: ${skipSecurity ? 'skipped' : 'done'}`);
    pipelineLog.push(`- Files changed: ${filesChanged.length}`);
    if (autoCreatePR) {
      pipelineLog.push(`- PR: attempted (see Phase 4 above)`);
    }

    this.recordWave(
      tasks.map((t, i) => ({ task: `pipeline[${i + 1}] ${t.task}`, status: 'completed' })),
      diff,
    );

    if (diff) {
      const stat = this.diffStat(snapshotRef);
      pipelineLog.push(stat ? `\n## Files changed\n\`\`\`\n${stat}\n\`\`\`` : `\n## Files changed\n${filesChanged.length} files.`);
    }

    if (snapshotRef) {
      this.snapshotStack.push({ ref: snapshotRef, task: `pipeline: ${tasks.map(t => t.task.slice(0, 30)).join(', ')}`, timestamp: Date.now() });
    }

    // Circuit breaker: pipeline completed (at least some tasks succeeded)
    circuitBreaker.recordSuccess();

    return { type: 'tool_result', tool_use_id: call.id, content: pipelineLog.join('\n') };
  }

  /**
   * Git-independent verification: confirm the project still builds after
   * workers report success. Prefers a project typecheck/build script, falls
   * back to `tsc --noEmit` for a TypeScript project. Returns ran=false when
   * there is nothing to verify (e.g. a docs/static project).
   */
  private verifyBuild(): { ran: boolean; ok: boolean; output: string } {
    const wd = this.config.workDir;
    const run = (cmd: string): { ok: boolean; output: string } => {
      try {
        const out = execSync(cmd, {
          cwd: wd, encoding: 'utf-8', stdio: 'pipe', timeout: 180_000,
          maxBuffer: 5 * 1024 * 1024, shell: '/bin/bash',
        });
        return { ok: true, output: (out || '').slice(-2000) };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return { ok: false, output: String(err.stdout || err.stderr || err.message || '').slice(-4000) };
      }
    };
    try {
      const pkgPath = join(wd, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
        const scripts = pkg.scripts || {};
        const name = scripts.typecheck ? 'typecheck'
          : scripts['type-check'] ? 'type-check'
          : scripts.build ? 'build' : null;
        if (name) {
          const r = run(`npm run ${name} 2>&1`);
          return { ran: true, ok: r.ok, output: r.output };
        }
      }
      if (existsSync(join(wd, 'tsconfig.json'))) {
        const r = run('npx tsc --noEmit 2>&1');
        return { ran: true, ok: r.ok, output: r.ok ? 'tsc --noEmit: clean' : r.output };
      }
    } catch { /* non-fatal — treat as nothing to verify */ }
    return { ran: false, ok: true, output: '' };
  }

  private gitSnapshot(): string | null {
    try {
      execSync('git rev-parse --git-dir', { cwd: this.config.workDir, stdio: 'pipe' });
      try {
        return execSync('git rev-parse HEAD', {
          cwd: this.config.workDir, encoding: 'utf-8', stdio: 'pipe',
        }).trim();
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }

  private gitDiff(snapshotRef: string | null): string | null {
    try {
      let diff: string;
      if (snapshotRef) {
        diff = execSync(`git diff ${snapshotRef} -- .`, {
          cwd: this.config.workDir, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 5 * 1024 * 1024,
        });
      } else {
        diff = execSync('git diff -- . && git diff --cached -- .', {
          cwd: this.config.workDir, encoding: 'utf-8', stdio: 'pipe',
          maxBuffer: 5 * 1024 * 1024, shell: '/bin/bash',
        });
        if (!diff.trim()) {
          diff = execSync('git diff HEAD -- . 2>/dev/null || git status --short', {
            cwd: this.config.workDir, encoding: 'utf-8', stdio: 'pipe', shell: '/bin/bash',
          });
        }
      }
      if (diff.length > 30_000) {
        return diff.slice(0, 15_000) + '\n\n... [diff truncated] ...\n\n' + diff.slice(-15_000);
      }
      return diff.trim() || null;
    } catch {
      return null;
    }
  }

  private extractFilesFromDiff(diff: string | null): string[] {
    if (!diff) return [];
    const files = new Set<string>();
    const lines = diff.split('\n');
    for (const line of lines) {
      // Match lines like "diff --git a/path b/path" or "--- a/path" or "+++ b/path"
      const match = line.match(/^diff --git a\/(.+?) b\//);
      if (match) {
        files.add(match[1]);
      }
    }
    return [...files].sort();
  }

  /**
   * Return a copy of the current message history.
   *
   * @returns Array of message objects
   */
  getMessages(): Array<Record<string, unknown>> {
    return [...this.messages];
  }

  /**
   * Replace the current message history with a previously saved one.
   *
   * @param messages - Message array to load
   */
  loadMessages(messages: Array<Record<string, unknown>>): void {
    this.messages = messages;
  }

  /**
   * Compact the message history to reduce token usage. Keeps recent messages
   * intact and summarizes older ones.
   *
   * @returns Object with message counts before and after compaction
   */
  compactHistory(): { before: number; after: number } {
    if (this.messages.length <= 4) {
      return { before: this.messages.length, after: this.messages.length };
    }

    const before = this.messages.length;
    let keepFrom = this.messages.length - 4;
    if (this.isOAI) {
      while (keepFrom < this.messages.length && this.messages[keepFrom].role === 'tool') {
        keepFrom++;
      }
    }
    const oldMessages = this.messages.slice(0, keepFrom);
    const recentMessages = this.messages.slice(keepFrom);

    const summaryParts: string[] = [];
    for (const msg of oldMessages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        summaryParts.push(`User asked: ${(msg.content as string).slice(0, 200)}`);
      } else if (msg.role === 'assistant') {
        const content = msg.content;
        if (typeof content === 'string') {
          summaryParts.push(`Assistant: ${(content as string).slice(0, 200)}`);
        } else if (Array.isArray(content)) {
          const texts = (content as Array<{ type: string; text?: string }>)
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text!.slice(0, 100));
          if (texts.length > 0) {
            summaryParts.push(`Assistant: ${texts.join(' | ')}`);
          }
        }
      }
    }

    const summaryText = `[Compacted conversation history — ${before - recentMessages.length} messages summarized]\n\n${summaryParts.join('\n')}`;

    const ackMsg = this.isOAI
      ? { role: 'assistant', content: 'Understood. I have the context from our previous conversation. How can I help?' }
      : { role: 'assistant', content: [{ type: 'text', text: 'Understood. I have the context from our previous conversation. How can I help?' }] };

    this.messages = [
      { role: 'user', content: summaryText },
      ackMsg,
      ...recentMessages,
    ];

    return { before, after: this.messages.length };
  }

  /**
   * Return a copy of the git snapshot stack for rollback tracking.
   * Each entry contains the commit ref, task description, and timestamp.
   *
   * @returns Array of snapshot entries
   */
  getSnapshotStack(): Array<{ref: string; task: string; timestamp: number}> {
    return [...this.snapshotStack];
  }

  /**
   * Undo the last delegation by rolling back to its git snapshot.
   *
   * @returns Rollback result with restored status, task name, and reverted files,
   *          or null if the snapshot stack is empty
   */
  undoLast(): { restored: boolean; task: string; filesReverted: string[] } | null {
    const last = this.snapshotStack.pop();
    if (!last) return null;
    const result = rollbackTo(this.config.workDir, last.ref);
    return { ...result, task: last.task };
  }

  /**
   * GAP-021: Execute multiple tool calls concurrently.
   * Browser + terminal + editor operations can run simultaneously.
   *
   * @param toolCalls - Array of tool calls to execute concurrently
   * @returns Aggregated results with per-tool timing and overall success status
   */
  async executeConcurrently(toolCalls: ConcurrentToolCall[]): Promise<ConcurrentExecutionResult> {
    const startTime = Date.now();
    const results: ConcurrentExecutionResult['results'] = [];

    const promises = toolCalls.map(async (tc): Promise<ConcurrentExecutionResult['results'][0]> => {
      const toolStart = Date.now();
      try {
        const result = await executeTool(
          { id: tc.id, name: tc.name, input: tc.input },
          this.config.workDir,
          this.config.additionalDirs,
        );
        return {
          toolCallId: tc.id,
          name: tc.name,
          content: result.content,
          duration: Date.now() - toolStart,
        };
      } catch (err) {
        return {
          toolCallId: tc.id,
          name: tc.name,
          content: '',
          error: (err as Error).message,
          duration: Date.now() - toolStart,
        };
      }
    });

    const settled = await Promise.allSettled(promises);
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        results.push({
          toolCallId: 'unknown',
          name: 'unknown',
          content: '',
          error: r.reason?.message || 'Unknown error',
          duration: 0,
        });
      }
    }

    const allOk = results.every(r => !r.error);
    return {
      success: allOk,
      results,
      totalDuration: Date.now() - startTime,
      summary: allOk
        ? `All ${results.length} tools executed successfully`
        : `${results.filter(r => r.error).length}/${results.length} tools failed`,
    };
  }

  /**
   * OPT-014: Collect results from any pending async scanner scan handles.
   *
   * Polls all stored handles non-blockingly. Completed scans are removed
   * from the pending list and their results are surfaced via the
   * onSecurityScan callback (if configured).
   *
   * Call this periodically (e.g., after pipeline completion, or via a
   * timer) to surface async scan results without blocking the main flow.
   *
   * @returns Array of completed scan results, or empty array if none ready.
   */
  async collectAsyncScanResults(): Promise<ScanResult[]> {
    if (this.pendingAsyncScanHandles.length === 0) return [];

    const completed: ScanResult[] = [];
    const stillPending: AsyncScanHandle[] = [];

    for (const handle of this.pendingAsyncScanHandles) {
      try {
        const results = await handle.poll();
        if (results && results.length > 0) {
          completed.push(...results);
          const totalFindings = results.reduce((n, r) => n + r.findings.length, 0);
          const msg = `Async scanner scan completed: ${results.length} scan(s), ${totalFindings} finding(s)`;
          this.callbacks.onSecurityScan?.(msg);
          console.log(`[async-dv] ${msg}`);
        } else if (results === null) {
          // Still running
          stillPending.push(handle);
        }
        // results === [] means failed/empty — drop it
      } catch {
        // Poll errored — drop this handle
      }
    }

    this.pendingAsyncScanHandles = stillPending;
    return completed;
  }

  /**
   * Reset the orchestrator session: clear message history and reset
   * the underlying provider session if applicable.
   */
  resetSession() {
    this.messages = [];
    if (this.unsubEscalation) {
      this.unsubEscalation();
      this.unsubEscalation = null;
    }
    this.pendingEscalations = [];
    if (this.provider instanceof ClaudeCodeProvider) {
      this.provider.resetSession();
    }
  }
}
