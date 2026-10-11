import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute, basename } from 'node:path';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import type { Config, WorkerPoolEntry } from './config.js';
import { hydrateWorkerKey } from './config.js';
import { getAllTools, executeTool } from '../tools/index.js';
import { buildProjectContext } from './context-builder.js';
import { preloadFiles, smartPreload } from './file-preloader.js';
import type { AgentRole } from './agent-roles.js';
import { filterToolsForRole } from './agent-roles.js';
import { loadRules, getApplicableRules, formatRulesForPrompt } from './rules-loader.js';
import { parseVerificationOutput, formatFixInstructions } from './verification.js';
import type { VerificationError } from './verification.js';
import { getRetryStrategy, buildRetryPrompt } from './retry-strategy.js';
import { recordError, recordFix, getPreventivePrompt, recordSuccess } from './error-learner.js';
import { createProgressReporter } from './progress-reporter.js';
import type { ProgressReport } from './progress-reporter.js';
import { parseErrors } from './error-parser.js';
import type { ParsedError } from './error-parser.js';
import { compactConversation, handleOverflowError } from './context-compaction.js';
import type { CompactableMessage } from './context-compaction.js';
import { isContextOverflow } from './context-overflow.js';
import { truncateShellOutput, truncateToolOutput } from './tool-output-truncation.js';
import { DoomLoopDetector } from './doom-loop-detector.js';
import { consumeSteerMessages } from './worker-steering.js';
import { workerEvents } from './event-bus.js';
import { workerStore } from './worker-store.js';
import { detectRemovals, isOffBrief, isJustified } from './regression-guard.js';

const BASE_WORKER_SYSTEM = `You are a senior software developer. You receive tasks and implement them precisely.

## Workflow
1. READ the task description and relevant files. Never guess at contents.
2. IMPLEMENT the requested changes using your tools.
3. VERIFY your work using the build/test commands appropriate for the project.
4. REPORT what you changed, files modified, verification results, any issues.

## Report Format
When you finish a task, your final message must include:
1. **Task ID**: If a task ID was provided in your context, include "TASK {id} COMPLETED" on its own line.
2. **Changes**: Files created/modified/deleted and what changed.
3. **Verification**: Build/test results (pass/fail).
4. **Issues**: Anything you couldn't resolve or that needs the caller's decision.

## Rules
- Read files before editing — never guess at contents.
- Follow task instructions precisely. Don't add scope you weren't asked for.
- Write clean, production-quality code. No "TODO: implement" placeholders.
- If acceptance criteria are provided, verify each one.
- If you hit a blocker, report it clearly instead of guessing.
- ONLY work within the project directory specified in the task. Do NOT read or access files outside it.

## Target Directory (CRITICAL)
- Your working directory is set by the task dispatcher. ALL files you create or edit MUST be under this directory.
- If the task mentions paths like "src/core/foo.ts", that is RELATIVE to the project directory.
- Before creating any new file, verify you are writing to the correct project by checking that sibling files/dirs exist at that path.
- NEVER default to the orchestrator's own install directory — write only inside your project directory.

## Verify Before You Code
- Before importing a function, READ the source file to confirm the export exists and check its actual parameter types.
- Before calling a function, verify its signature matches what you're passing. Do not assume — grep or read the definition.
- If the task says "match existing patterns", actually open the existing files and match their conventions, types, and import paths.

## Parallel Work Rules
When working alongside other workers on the same codebase:
- Do NOT modify files outside your assigned scope
- If you encounter a file that looks recently modified by another worker, leave it alone
- Focus on YOUR task only — do not fix unrelated issues you find
- If your task conflicts with another worker's changes, STOP and report the conflict
`;

const CC_WORKER_SYSTEM = `
## Cobra Commander — Additional Context
You are on the Cobra Commander team. An orchestrator model plans; you build.
Do NOT run security scans yourself — the orchestrator handles scanning as a separate pipeline step.
`;

// Async so a slow build check doesn't block the daemon's event loop (every parallel worker + the API).
const execAsync = promisify(exec);

const WORKER_TOKEN_BUDGET = process.env.WORKER_TOKEN_BUDGET ? +process.env.WORKER_TOKEN_BUDGET : 3_000_000;
// 20 min repeatedly timed out medium-sized worker tasks; 30 min fits them.
const WORKER_TIME_BUDGET_MS = process.env.WORKER_TIME_BUDGET_MS ? +process.env.WORKER_TIME_BUDGET_MS : 1_800_000;

function detectBuildCommands(workDir: string): string[] {
  const commands: string[] = [];
  if (existsSync(resolve(workDir, 'tsconfig.json'))) commands.push('npx tsc --noEmit');
  if (existsSync(resolve(workDir, 'Cargo.toml'))) commands.push('cargo check');
  if (existsSync(resolve(workDir, 'go.mod'))) commands.push('go build ./...');
  if (existsSync(resolve(workDir, 'requirements.txt')) || existsSync(resolve(workDir, 'setup.py')) || existsSync(resolve(workDir, 'pyproject.toml')))
    commands.push("python3 -m compileall -q -x '(^|/)(\\.venv|venv|node_modules|_ref)(/|$)' .");
  return commands;
}

// Files a mutation tool call will touch, for the regression guard. Returns the
// path(s) as given in the tool input (resolved to absolute by the caller).
function mutationTargets(name: string, input: Record<string, unknown>): string[] {
  if (name === 'write_file' || name === 'edit_file' || name === 'patch_file') {
    return typeof input.path === 'string' ? [input.path] : [];
  }
  if (name === 'apply_unified_diff') {
    return typeof input.file_path === 'string' ? [input.file_path] : [];
  }
  if (name === 'write_files' && Array.isArray(input.files)) {
    return (input.files as Array<{ path?: string }>)
      .map(f => f.path)
      .filter((p): p is string => typeof p === 'string');
  }
  if (name === 'apply_patch' && typeof input.patch === 'string') {
    const paths: string[] = [];
    const re = /^\+\+\+\s+(?:b\/)?(\S+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input.patch)) !== null) {
      if (m[1] !== '/dev/null') paths.push(m[1]);
    }
    return paths;
  }
  return [];
}

function buildWorkerSystemPrompt(config: Config): string {
  let prompt = BASE_WORKER_SYSTEM;

  const isCC = config.workDir === config.homeDir ||
    config.workDir.replace(/\/$/, '') === config.homeDir.replace(/\/$/, '');

  if (isCC) {
    prompt += CC_WORKER_SYSTEM;
  }

  const detected = detectBuildCommands(config.workDir);
  const explicit = config.verification?.commands || [];
  const allCommands = [...new Set([...explicit, ...detected])];

  if (allCommands.length) {
    prompt += `\n## Build/Verify Commands\nRun these to verify your work:\n${allCommands.map(c => `- \`${c}\``).join('\n')}\n`;
  }

  return prompt;
}

export interface WorkerCallbacks {
  onText: (text: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string, isError: boolean) => void;
  onTokenUsage: (input: number, output: number) => void;
  onRetryStrategy?: (strategyName: string, attempt: number) => void;
  onProgressReport?: (report: ProgressReport) => void;
  onAskClarification?: (question: string, context: string, options: string[]) => Promise<string>;
  onPauseRequest?: (question: string, config: ClarificationConfig) => Promise<string>;
}

export interface ClarificationQuestion {
  question: string;
  context: string;
  options: string[];
  response?: string;
  timestamp: number;
}

/** DS-015: Clarification request used by PauseManager */
export interface ClarificationRequest {
  question: string;
  context: string;
  options: string[];
  timestamp: number;
  resolved: boolean;
  response?: string;
}

// ──────────────────────────────────────────────
// Pause / Clarification types (DS-015)
// ──────────────────────────────────────────────

export interface PauseState {
  paused: boolean;
  question: string;
  options: string[];
  timestamp: number;
  timeout: number;
  resolved: boolean;
  response?: string;
}

export interface ClarificationConfig {
  /** Multiple-choice options to present to the user */
  options?: string[];
  /** Timeout in ms before auto-continuing (0 = no timeout) */
  timeoutMs?: number;
  /** Default answer if timeout expires */
  defaultAnswer?: string;
  /** Priority level */
  priority?: 'low' | 'medium' | 'high' | 'blocking';
  /** Context about what the agent was doing */
  context?: string;
}

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export class Worker {
  private provider: OpenAICompatibleProvider;
  private config: Config;
  private callbacks: WorkerCallbacks;
  private role?: AgentRole;
  private lastVerificationErrors: VerificationError[] = [];
  private currentModelName: string;
  private clarificationHistory: ClarificationQuestion[] = [];
  private clarifyThreshold = 0.7; // confidence threshold for auto-clarification
  public workerId: string;

  constructor(config: Config, callbacks: WorkerCallbacks, modelName?: string, role?: AgentRole, workerId?: string) {
    const poolEntry = this.resolveWorker(config, modelName);
    this.provider = new OpenAICompatibleProvider(poolEntry.provider);
    this.config = config;
    this.callbacks = callbacks;
    this.role = role;
    this.currentModelName = poolEntry.provider.model;
    // Use the caller-supplied id when given, so the events this worker emits
    // match the id the run-coordinator/reactive-bus registered for it.
    this.workerId = workerId ?? `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private resolveWorker(config: Config, modelName?: string): WorkerPoolEntry {
    if (!modelName) {
      return config.workerPool[0] || { name: 'default', provider: config.worker, tier: 'standard' as const };
    }

    const byName = config.workerPool.find(w => w.name === modelName);
    if (byName) return byName;

    const byTier = config.workerPool.find(w => w.tier === modelName);
    if (byTier) return byTier;

    return config.workerPool[0] || { name: 'default', provider: config.worker, tier: 'standard' as const };
  }

  private async runVerification(): Promise<string | null> {
    const allErrors: VerificationError[] = [];
    const outputParts: string[] = [];

    // Determine verification commands from config
    // tsc without a tsconfig prints help and exits 1, which sent Python workers off "fixing" phantom
    // TypeScript errors. Drop it there and fall back to checks detected from the project.
    const hasTsconfig = existsSync(resolve(this.config.workDir, 'tsconfig.json'));
    const configured = (this.config.verification?.commands || ['npx tsc --noEmit'])
      .filter(cmd => hasTsconfig || !/\btsc\b/.test(cmd));
    const commands = configured.length ? configured : detectBuildCommands(this.config.workDir);
    const timeout = (this.config.verification?.timeout || 60) * 1000;
    const failOnWarnings = this.config.verification?.failOnWarnings ?? false;
    const skipPatterns = this.config.verification?.skipPatterns || [];

    // Read package.json once for lint and test checks
    let pkg: { scripts?: Record<string, string> } | null = null;
    const pkgPath = resolve(this.config.workDir, 'package.json');
    if (existsSync(pkgPath)) {
      try { pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')); } catch { /* skip */ }
    }

    // Run configured verification commands
    for (const cmd of commands) {
      try {
        await execAsync(cmd, {
          cwd: this.config.workDir,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, PATH: process.env.PATH },
        });
        outputParts.push(`[OK] ${cmd}`);
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        let output = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();

        // Apply skip patterns to filter out expected warnings
        if (skipPatterns.length > 0 && output) {
          const lines = output.split('\n');
          const filtered = lines.filter(line => {
            return !skipPatterns.some(pattern => {
              try {
                return new RegExp(pattern).test(line);
              } catch { return false; }
            });
          });
          output = filtered.join('\n');
        }

        if (output) {
          // Determine if this is a warning or error
          const isWarning = output.toLowerCase().includes('warning') && !output.toLowerCase().includes('error');
          if (isWarning && !failOnWarnings) {
            outputParts.push(`[WARN] ${cmd}\n${output.slice(0, 5000)}`);
            continue; // Don't treat warnings as errors unless failOnWarnings is true
          }

          outputParts.push(`[FAIL] ${cmd}\n${output.slice(0, 5000)}`);
          // Auto-detect source from command
          let source = 'runtime';
          if (cmd.includes('tsc')) source = 'typescript';
          else if (cmd.includes('eslint') || cmd.includes('lint')) source = 'eslint';
          else if (cmd.includes('test') || cmd.includes('jest') || cmd.includes('vitest')) source = 'test';
          const parsed = parseVerificationOutput(output, source);
          allErrors.push(...parsed);
        }
      }
    }

    // Also try lint if a lint script exists in package.json (supplementary)
    if (pkg && !commands.some(c => c.includes('lint'))) {
      const lintScript = pkg.scripts?.lint || pkg.scripts?.['lint:check'];
      if (lintScript) {
        try {
          await execAsync('npm run lint 2>&1', {
            cwd: this.config.workDir,
            timeout: 60_000,
            maxBuffer: 10 * 1024 * 1024,
          });
        } catch (lintErr) {
          const le = lintErr as { stdout?: string; stderr?: string };
          let output = [le.stdout, le.stderr].filter(Boolean).join('\n').trim();

          // Apply skip patterns
          if (skipPatterns.length > 0 && output) {
            const lines = output.split('\n');
            const filtered = lines.filter(line => {
              return !skipPatterns.some(pattern => {
                try { return new RegExp(pattern).test(line); } catch { return false; }
              });
            });
            output = filtered.join('\n');
          }

          if (output) {
            outputParts.push(`[FAIL] npm run lint\n${output.slice(0, 5000)}`);
            const parsed = parseVerificationOutput(output, 'eslint');
            allErrors.push(...parsed);
          }
        }
      }
    }

    // Also try test if package.json has a test script (supplementary)
    if (pkg && !commands.some(c => c.includes('test'))) {
      if (pkg.scripts?.test && !pkg.scripts.test.includes('echo') && !pkg.scripts.test.includes('no test')) {
        try {
          await execAsync('npm test 2>&1', {
            cwd: this.config.workDir,
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
          });
        } catch (testErr) {
          const te = testErr as { stdout?: string; stderr?: string };
          let output = [te.stdout, te.stderr].filter(Boolean).join('\n').trim();

          // Apply skip patterns
          if (skipPatterns.length > 0 && output) {
            const lines = output.split('\n');
            const filtered = lines.filter(line => {
              return !skipPatterns.some(pattern => {
                try { return new RegExp(pattern).test(line); } catch { return false; }
              });
            });
            output = filtered.join('\n');
          }

          if (output) {
            outputParts.push(`[FAIL] npm test\n${output.slice(0, 5000)}`);
            const parsed = parseVerificationOutput(output, 'test');
            allErrors.push(...parsed);
          }
        }
      }
    }

    // Store parsed errors for retry context
    this.lastVerificationErrors = allErrors;

    if (allErrors.length === 0) return null;

    // Use structured fix instructions
    const fixInstructions = formatFixInstructions(allErrors);
    return `Your changes introduced errors. Fix them:\n\n${fixInstructions}`;
  }

  async executeTask(task: string, context: string, criteria: string[]): Promise<string> {
    if (!this.config.worker.apiKey) {
      await hydrateWorkerKey(this.config);
      if (this.config.worker.apiKey) {
        const poolEntry = this.resolveWorker(this.config);
        this.provider = new OpenAICompatibleProvider(poolEntry.provider);
      }
    }

    const reporter = createProgressReporter({
      intervalMs: this.config.progressReportInterval ?? 240000,
      enabled: this.config.progressReportEnabled !== false,
      onReport: (report) => this.callbacks.onProgressReport?.(report),
    });
    reporter.start(task.slice(0, 60));
    reporter.update({ maxTurns: this.config.maxWorkerTurns });

    // buildProjectContext is async — previously called without await, so the
    // worker got the literal string "[object Promise]" and never received the
    // repo map / file tree. Await it and bound its size so it can't bloat the
    // seed message.
    const projectContext = (await buildProjectContext(this.config.workDir))?.slice(0, 12000) || '';
    // Bounded like projectContext: on a large repo unbounded preloads pushed the seed message
    // past the compaction threshold on turn 1.
    const preloaded = preloadFiles(this.config.workDir, task + '\n' + context)?.slice(0, 40000) || '';
    const smartContext = smartPreload(this.config.workDir, task + '\n' + context)?.slice(0, 20000) || '';

    // Add preventive prompt from error learning
    const preventivePrompt = getPreventivePrompt(this.currentModelName, this.config.homeDir);

    const userPrompt = [
      projectContext ? `## Auto-Context\n${projectContext}` : '',
      preloaded,
      smartContext,
      `## Task\n${task}`,
      context ? `\n## Context\n${context}` : '',
      criteria.length ? `\n## Acceptance Criteria\n${criteria.map(c => `- ${c}`).join('\n')}` : '',
      preventivePrompt,
      `\n## Instructions\nUse the tools to implement this task. When done, output a summary of what you did.`,
    ].filter(Boolean).join('\n');

    const messages: OAIMessage[] = [
      { role: 'user', content: userPrompt },
    ];

    // ── Harness guard state (per-task) ──
    const mutatedFiles = new Set<string>();
    const verifyReceipts: { cmd: string; ok: boolean }[] = [];
    const failCounts = new Map<string, number>();
    // Regression guard state: baseline pre-image per file (captured before the
    // worker's first mutation of it) + the removals we've already warned about.
    const baselinePreImages = new Map<string, string>();
    const warnedRemovals = new Set<string>();
    let regressionAbort = false;
    let regressionAbortMsg = '';
    let emptyCompletionNudges = 0;
    let receiptNudgeUsed = false;
    const TOOL_TIMEOUT_MS = parseInt(process.env.WORKER_TOOL_TIMEOUT_MS || '') || 120000;
    const startTime = Date.now();
    let cumulativeTokens = 0;
    let prevInputTokens = 0;
    let explicitComplete = false;
    let lastToolName = '';
    let lastToolResult = '';

    // Build system prompt with optional role overlay
    const basePrompt = buildWorkerSystemPrompt(this.config);
    const systemPrompt = this.role
      ? `${this.role.systemPromptOverlay}\n\n${basePrompt}`
      : basePrompt;

    // Load and apply project rules
    const rules = loadRules(this.config.homeDir);
    const applicableRules = getApplicableRules(rules, task + '\n' + context, this.config.homeDir);
    const rulesText = formatRulesForPrompt(applicableRules);
    const finalSystemPrompt = systemPrompt + rulesText + `
## Clarification Protocol
If you encounter ambiguity, missing context, conflicting requirements, or multiple valid approaches, you MUST pause and ask a specific question.
When you need clarification, prefix your question with "CLARIFICATION_NEEDED:" followed by one clear, specific question. STOP and await the response. Do NOT proceed with implementation until you receive a response.`;

    // Filter tools if role restricts them
    const allAvailableTools = getAllTools();
    const tools = this.role ? filterToolsForRole(allAvailableTools, this.role) : allAvailableTools;

    let turns = 0;
    let lastText = '';
    const doomDetector = new DoomLoopDetector();

    workerEvents.emit({ type: 'task.started', workerId: this.workerId, task: task.slice(0, 200), timestamp: Date.now() });
    workerStore.append({ workerId: this.workerId, timestamp: Date.now(), type: 'start', data: { task: task.slice(0, 500) } });

    while (turns < this.config.maxWorkerTurns) {
      turns++;

      // Budget check before each LLM turn
      if (cumulativeTokens > WORKER_TOKEN_BUDGET || (Date.now() - startTime) > WORKER_TIME_BUDGET_MS) {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        lastText = `BUDGET_EXCEEDED: worker stopped at ${cumulativeTokens} tokens / ${elapsedSec}s. ` + (lastText || '(no output)');
        break;
      }

      // Mid-task steering: inject queued messages from orchestrator
      const steerMsgs = consumeSteerMessages(this.workerId);
      for (const steerMsg of steerMsgs) {
        messages.push({ role: 'user', content: `[STEERING] ${steerMsg}` });
        workerEvents.emit({ type: 'steering.injected', workerId: this.workerId, message: steerMsg.slice(0, 200), timestamp: Date.now() });
        workerStore.append({ workerId: this.workerId, timestamp: Date.now(), type: 'steer', data: { message: steerMsg.slice(0, 500) } });
      }

      // MAX_STEPS_PROMPT: warn worker when approaching turn limit
      const turnLimit = this.config.maxWorkerTurns;
      if (turns >= Math.floor(turnLimit * 0.9) && turns < turnLimit) {
        messages.push({
          role: 'user',
          content: `APPROACHING TURN LIMIT: You have used ${turns}/${turnLimit} turns. Summarize what you've accomplished, what files you modified, what's left to do, and any blockers. Then stop.`,
        });
      }

      // Compact old tool outputs when context grows large
      const compactResult = compactConversation(messages as CompactableMessage[]);
      if (compactResult.compacted) {
        const next = [...compactResult.messages] as OAIMessage[];
        messages.length = 0;
        messages.push(...next);
      }

      let response;
      try {
        response = await this.provider.chat(
          finalSystemPrompt,
          messages,
          tools,
          16384,
        );
      } catch (err) {
        const errMsg = (err as Error).message || '';
        if (isContextOverflow(errMsg) || errMsg.includes('fetch failed')) {
          const recovery = handleOverflowError(err as Error, messages as Array<{ role: string; content: string }>);
          if (recovery.recovered) {
            const next = [...recovery.messages] as OAIMessage[];
            messages.length = 0;
            messages.push(...next);
            continue;
          }
        }
        throw err;
      }

      // Every turn re-sends the whole conversation; charging the full input each turn exhausted the
      // budget by ~turn 50 of 150. Count only input growth since the previous turn plus output.
      cumulativeTokens += Math.max(0, response.usage.input - prevInputTokens) + response.usage.output;
      prevInputTokens = response.usage.input;
      this.callbacks.onTokenUsage(response.usage.input, response.usage.output);
      workerEvents.emit({ type: 'turn.completed', workerId: this.workerId, turnNumber: turns, tokensIn: response.usage.input, tokensOut: response.usage.output, timestamp: Date.now() });
      workerStore.append({ workerId: this.workerId, timestamp: Date.now(), type: 'turn', data: { turn: turns, tokensIn: response.usage.input, tokensOut: response.usage.output } });

      if (response.text) {
        lastText = response.text;
        this.callbacks.onText(response.text);

        // DS-015: Check if worker is asking for clarification
        if (response.text.includes('CLARIFICATION_NEEDED:')) {
          const question = response.text.split('CLARIFICATION_NEEDED:')[1]?.split('\n')[0]?.trim() || 'Please provide more details.';
          return `CLARIFICATION_NEEDED: ${question}`;
        }
      }

      if (response.toolCalls.length === 0) {
        if (turns < this.config.maxWorkerTurns - 2) {
          reporter.update({ status: 'verifying' });
          const verifyErrors = await this.runVerification();
          if (verifyErrors) {
            reporter.update({ status: 'retrying' });
            this.callbacks.onText('[verification failed — self-correcting]');
            messages.push({ role: 'user', content: verifyErrors });
            continue;
          }
        }

        // --- Empty-completion guard ---
        const taskImpliesChanges = /creat|implement|add |fix |write |build |refactor|chang/i.test(task);
        const textDeclaresFailure = /FAIL|cannot|unable|blocked/i.test(response.text || '');
        if (mutatedFiles.size === 0 && taskImpliesChanges && !textDeclaresFailure) {
          if (emptyCompletionNudges < 2) {
            emptyCompletionNudges++;
            messages.push({ role: 'user', content: 'HARNESS REJECT: you modified zero files but the task requires changes. Either do the work now or reply starting with "FAILURE:" and the reason. Do not claim success.' });
            continue;
          }
        }

        // --- Receipt gate ---
        const textClaimsVerification = /tsc|type\s*check|tests?\s+pass|build\s+(succeed|clean|green|passes)/i.test(response.text || '');
        if (textClaimsVerification && !verifyReceipts.some(r => r.ok)) {
          if (!receiptNudgeUsed) {
            receiptNudgeUsed = true;
            messages.push({ role: 'user', content: 'HARNESS REJECT: you claim verification but no verify command succeeded in this session. Run it for real.' });
            continue;
          }
        }

        explicitComplete = true;
        break;
      }

      messages.push({
        role: 'assistant',
        content: response.text,
        tool_calls: response.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          },
        })),
      });

      let doomBreak = false;

      for (const tc of response.toolCalls) {
        this.callbacks.onToolCall(tc.name, tc.input);
        reporter.recordToolCall(tc.name, tc.input);
        const toolStart = Date.now();
        workerEvents.emit({ type: 'tool.called', workerId: this.workerId, tool: tc.name, args: JSON.stringify(tc.input).slice(0, 200), timestamp: toolStart });

        // Doom-loop detection
        const doomResult = doomDetector.record(tc.name, tc.input);

        // --- Regression guard: capture pre-edit baseline before mutating ---
        const guardTargets = mutationTargets(tc.name, tc.input);
        const preEdit = new Map<string, string>();
        for (const t of guardTargets) {
          const abs = isAbsolute(t) ? t : resolve(this.config.workDir, t);
          const cur = existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
          preEdit.set(abs, cur);
          if (!baselinePreImages.has(abs)) baselinePreImages.set(abs, cur);
        }

        // --- Repeat-failure breaker ---
        const failKey = tc.name + ':' + JSON.stringify(tc.input);
        let result: { tool_use_id: string; content: string; is_error?: boolean };
        if ('_raw' in tc.input) {
          result = {
            tool_use_id: tc.id,
            content: response.finishReason === 'length'
              ? 'Tool call NOT executed: your output was truncated at max_tokens, so the arguments are incomplete JSON. Split the content into smaller pieces (write_file the first part, then edit_file to append the rest).'
              : 'Tool call NOT executed: arguments were not valid JSON. Re-issue the call with valid JSON arguments.',
            is_error: true,
          };
        } else if ((failCounts.get(failKey) || 0) >= 2) {
          result = {
            tool_use_id: tc.id,
            content: 'REFUSED by harness: this exact call failed 2x already. Pivot to a different approach or report FAILURE.',
            is_error: true,
          };
        } else {
          // --- Per-tool timeout ---
          const toolPromise = executeTool(
            { id: tc.id, name: tc.name, input: tc.input },
            this.config.workDir,
            this.config.additionalDirs,
            { workerId: this.workerId },
          );
          const timeoutPromise = new Promise<{ tool_use_id: string; content: string; is_error?: boolean }>((resolve) => {
            setTimeout(() => resolve({
              tool_use_id: tc.id,
              content: `Tool call timed out after ${TOOL_TIMEOUT_MS / 1000}s (harness guard)`,
              is_error: true,
            }), TOOL_TIMEOUT_MS);
          });
          result = await Promise.race([toolPromise, timeoutPromise]);
        }

        // --- Regression / off-brief-deletion guard ---
        // After a successful mutation, diff the new content against the file's
        // pre-edit baseline. If the worker deleted a named definition or a large
        // block the task never referenced, roll the edit back and make it redo;
        // a repeat of the same deletion after a warning fails the task loud.
        if (!result.is_error && guardTargets.length) {
          const rationale = response.text || '';
          const taskText = task + '\n' + context;
          const trips: string[] = [];
          let mustAbort = false;
          for (const [abs, before] of preEdit) {
            const baseline = baselinePreImages.get(abs) ?? before;
            const after = existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
            if (after === baseline) continue;
            for (const rem of detectRemovals(baseline, after)) {
              if (!isOffBrief(rem, taskText)) continue;
              if (isJustified(rem, rationale)) {
                workerEvents.emit({ type: 'escalation.triggered', workerId: this.workerId, reason: 'regression_guard_justified', detail: `${basename(abs)}: ${rem.label}`.slice(0, 200), timestamp: Date.now() });
                continue;
              }
              const key = abs + '|' + rem.id;
              if (warnedRemovals.has(key)) mustAbort = true;
              else warnedRemovals.add(key);
              trips.push(rem.label);
            }
          }
          if (trips.length) {
            // Roll the offending edit back to its pre-edit state so the deletion
            // never lands on disk while the worker is told to redo it.
            for (const [abs, before] of preEdit) {
              try { writeFileSync(abs, before, 'utf-8'); } catch { /* best-effort revert */ }
            }
            if (mustAbort) {
              regressionAbort = true;
              regressionAbortMsg = `off-brief deletion repeated after warning: ${trips.join('; ')}`;
              workerEvents.emit({ type: 'escalation.triggered', workerId: this.workerId, reason: 'regression_guard_abort', detail: trips.join('; ').slice(0, 200), timestamp: Date.now() });
              result = { tool_use_id: tc.id, content: `GUARD ABORT: you again removed ${trips.join('; ')}, which your task did not ask you to remove. This is a repeat offense — the task is being failed to prevent a silent regression.`, is_error: true };
            } else {
              workerEvents.emit({ type: 'escalation.triggered', workerId: this.workerId, reason: 'regression_guard', detail: trips.join('; ').slice(0, 200), timestamp: Date.now() });
              result = { tool_use_id: tc.id, content: `Guard: your edit to ${guardTargets.join(', ')} removed ${trips.join('; ')}, which your task did not ask you to remove. The edit was rolled back. Re-apply your change PRESERVING existing functionality. If removal is genuinely required, redo the edit and explicitly state what you are removing and why.`, is_error: true };
            }
          }
        }

        // --- Update failCounts ---
        if (result.is_error) {
          failCounts.set(failKey, (failCounts.get(failKey) || 0) + 1);
        } else {
          failCounts.delete(failKey);
        }

        this.callbacks.onToolResult(tc.name, result.content, result.is_error ?? false);
        workerEvents.emit({ type: 'tool.completed', workerId: this.workerId, tool: tc.name, duration: Date.now() - toolStart, isError: result.is_error ?? false, timestamp: Date.now() });
        workerStore.append({ workerId: this.workerId, timestamp: Date.now(), type: 'tool', data: { tool: tc.name, isError: result.is_error ?? false, duration: Date.now() - toolStart } });

        // --- Last-action tracking ---
        lastToolName = tc.name;
        lastToolResult = result.content.slice(0, 80);

        // --- Mutation tracking ---
        if (!result.is_error) {
          const mutateTools = ['write_file', 'edit_file', 'patch_file', 'apply_patch', 'write_files', 'apply_unified_diff'];
          if (mutateTools.includes(tc.name)) {
            if (tc.name === 'write_files' && Array.isArray(tc.input.files)) {
              for (const f of tc.input.files as Array<{ path?: string }>) {
                if (typeof f.path === 'string') mutatedFiles.add(f.path);
              }
            } else if (tc.name === 'apply_unified_diff') {
              const p = tc.input.file_path;
              if (typeof p === 'string') mutatedFiles.add(p);
            } else {
              const p = tc.input.path;
              if (typeof p === 'string') mutatedFiles.add(p);
            }
          }
        }

        // --- Verification receipts ---
        if (tc.name === 'run_command') {
          const cmd = String(tc.input.command || '');
          if (/\b(tsc\s+--noEmit|node\s+--(import\s+tsx\s+--)?test|node\s+(--input-type=\S+\s+)?(--check|-c)\b|vitest|npm\s+(run\s+)?test|next\s+build|docker\s+compose\s+config|pytest|python3?\s+-m\s+(pytest|py_compile|compileall|mypy)|python3?\s+-c|ruff\s+check|mypy|go\s+(build|test|vet)|cargo\s+(build|check|test))\b/i.test(cmd)) {
            verifyReceipts.push({ cmd: cmd.slice(0, 80), ok: !result.is_error });
          }
        }

        const truncated = tc.name === 'run_command'
          ? truncateShellOutput(result.content)
          : truncateToolOutput(result.content);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: truncated.text,
        });

        if (doomResult.isDoom) {
          workerEvents.emit({ type: 'doom.detected', workerId: this.workerId, tool: tc.name, count: doomResult.count, timestamp: Date.now() });
          workerStore.append({ workerId: this.workerId, timestamp: Date.now(), type: 'error', data: { type: 'doom_loop', tool: tc.name, count: doomResult.count } });
          if (doomDetector.warnings >= 2) {
            // Second doom detection — hard abort
            messages.push({ role: 'user', content: `SECOND DOOM LOOP: Aborting. Report what you accomplished so far.` });
            doomBreak = true;
            break;
          } else {
            // First doom detection — redirect
            messages.push({ role: 'user', content: `DOOM LOOP: You called ${tc.name} with identical arguments ${doomResult.count} times. Re-read the target file and try a completely different approach.` });
          }
        }
      }

      if (doomBreak) {
        lastText = lastText
          ? `DOOM LOOP ABORT: Worker stuck in repeated tool calls. Last output:\n${lastText}`
          : 'DOOM LOOP ABORT: Worker repeatedly called the same tool with identical arguments and produced no output.';
        break;
      }

      if (regressionAbort) {
        lastText = 'UNVERIFIED: ' + regressionAbortMsg + (lastText ? '\n' + lastText : '');
        break;
      }

      // Context compaction — prune old tool outputs before they fill the context window
      const compaction = compactConversation(messages as CompactableMessage[]);
      if (compaction.compacted) {
        const next = [...compaction.messages] as unknown as OAIMessage[];
        messages.length = 0;
        messages.push(...next);
        this.callbacks.onText(`[context] compacted ${compaction.freedChars} chars from old turns`);
        workerEvents.emit({ type: 'compaction.triggered', workerId: this.workerId, freedChars: compaction.freedChars, timestamp: Date.now() });
        workerStore.append({ workerId: this.workerId, timestamp: Date.now(), type: 'compact', data: { freedChars: compaction.freedChars } });
      }

      reporter.update({ turnsUsed: turns });
    }

    // --- Post-loop harness guards ---
    const finalTaskImplies = /creat|implement|add |fix |write |build |refactor|chang/i.test(task);
    const finalTextDeclaresFailure = /FAIL|cannot|unable|blocked/i.test(lastText || '');

    // Empty-completion: if nudges exhausted, wrap with FAILURE
    if (mutatedFiles.size === 0 && finalTaskImplies && !finalTextDeclaresFailure && emptyCompletionNudges >= 2) {
      lastText = 'FAILURE: worker made no changes. ' + (lastText || '(no output)');
    }

    // Receipt gate: if claims verification with no receipt, mark UNVERIFIED
    const finalTextClaimsVerify = /tsc|type\s*check|tests?\s+pass|build\s+(succeed|clean|green|passes)/i.test(lastText || '');
    if (finalTextClaimsVerify && !verifyReceipts.some(r => r.ok)) {
      lastText = 'UNVERIFIED: ' + (lastText || '(no output)');
    }

    // Always append receipts + file summary
    const receiptsLine = '\n[receipts] ' + JSON.stringify(verifyReceipts) + ' [files] ' + [...mutatedFiles].join(',').slice(0, 500);
    lastText = (lastText || '(worker produced no output)') + receiptsLine;

    // Partial progress marker for non-clean exits (budget, max-turns, doom loop)
    if (!explicitComplete) {
      lastText += '\n[PARTIAL PROGRESS] files changed: ' + [...mutatedFiles].join(',') + ' | receipts: ' + JSON.stringify(verifyReceipts) + ' | last action: ' + lastToolName + ' ' + lastToolResult;
    }

    reporter.stop();
    const finalResult = lastText || '(worker produced no output)';
    const finalStatus = /^(DOOM LOOP ABORT|UNVERIFIED:|FAILURE:|BUDGET_EXCEEDED:)/.test(finalResult) ? 'failed' : 'done';
    workerEvents.emit({ type: 'task.completed', workerId: this.workerId, status: finalStatus as 'done' | 'failed', result: finalResult.slice(0, 500), timestamp: Date.now() });
    workerStore.append({ workerId: this.workerId, timestamp: Date.now(), type: 'complete', data: { status: finalStatus, result: finalResult.slice(0, 500), turns } });
    return finalResult;
  }

  async executeTaskWithRetry(
    task: string,
    context: string,
    criteria: string[],
    maxRetries = 3,
    onRetry?: (task: string, attempt: number) => void,
  ): Promise<string> {
    let lastError: string | null = null;
    let currentModel = this.currentModelName;
    let previousErrors: ParsedError[] = [];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        let retryContext = context;
        let retryTask = task;
        let modelOverride: string | undefined;

        if (lastError) {
          // Parse errors intelligently
          const parsedErrors = parseErrors(lastError);
          const hasRepeated = this.trackErrorPattern(parsedErrors);

          // Build a targeted retry prompt using parsed errors
          if (parsedErrors.length > 0) {
            previousErrors = parsedErrors;
            if (hasRepeated) {
              // Same error repeated — try a completely different approach
              retryTask = `The previous fix didn't work. Try a completely different approach to fix:\n\n${this.buildRetryPrompt(task, parsedErrors, this.config.workDir)}`;
              retryContext = `${context}\n\n## RETRY — Different Approach Needed\nPrevious attempts failed with the same errors. Try a fundamentally different approach.`;
            } else {
              retryTask = this.buildRetryPrompt(task, parsedErrors, this.config.workDir);
              retryContext = `${context}\n\n## RETRY — Fix Errors\n${lastError}`;
            }
          } else {
            // Fall back to existing retry strategy
            const strategy = getRetryStrategy(attempt, lastError, this.config, currentModel);

            if (this.callbacks.onRetryStrategy) {
              this.callbacks.onRetryStrategy(strategy.name, attempt);
            }

            const retryPrompt = buildRetryPrompt(strategy, task, context, lastError, attempt);
            retryTask = retryPrompt.task;
            retryContext = retryPrompt.context;
            modelOverride = retryPrompt.model;
          }

          // If model override, create a new provider for that model
          if (modelOverride && modelOverride !== currentModel) {
            const poolEntry = this.resolveWorker(this.config, modelOverride);
            this.provider = new OpenAICompatibleProvider(poolEntry.provider);
            currentModel = poolEntry.provider.model;
            this.currentModelName = currentModel;
          }
        }

        if (attempt > 1 && onRetry) {
          onRetry(retryTask, attempt);
        }

        const result = await this.executeTask(retryTask, retryContext, criteria);

        // Record success for error learning
        recordSuccess(currentModel, this.config.homeDir);

        // If there were previous errors, record fixes
        if (lastError && this.lastVerificationErrors.length > 0) {
          for (const err of this.lastVerificationErrors) {
            if (err.code) {
              recordFix(currentModel, err.code, 'Fixed by retry', this.config.homeDir);
            }
          }
        }

        // If we got here without throwing, success
        return result;
      } catch (err) {
        lastError = (err as Error).message;

        // Record errors for error learning
        if (this.lastVerificationErrors.length > 0) {
          for (const verr of this.lastVerificationErrors) {
            recordError(currentModel, verr, this.config.homeDir);
          }
        }

        if (attempt >= maxRetries) {
          workerEvents.emit({
            type: 'retry.exhausted',
            workerId: this.workerId,
            attempts: maxRetries,
            lastError: (lastError || 'Unknown error').slice(0, 500),
            timestamp: Date.now(),
          });
          throw new Error(`Failed after ${maxRetries} attempts. Last error: ${lastError}`);
        }
      }
    }

    workerEvents.emit({
      type: 'retry.exhausted',
      workerId: this.workerId,
      attempts: maxRetries,
      lastError: (lastError || 'Unknown error').slice(0, 500),
      timestamp: Date.now(),
    });
    throw new Error(`Failed after ${maxRetries} attempts. Last error: ${lastError}`);
  }

  private parseErrorDetails(errorText: string): string {
    const lines: string[] = [];

    // Extract TypeScript error file:line references
    const tsErrorPattern = /([\w./]+\.(?:ts|tsx|js|jsx))\((\d+),\d+\)/g;
    let match;
    while ((match = tsErrorPattern.exec(errorText)) !== null) {
      lines.push(`  TS error: ${match[1]}:${match[2]}`);
    }

    // Extract generic file:line patterns
    const fileLinePattern = /([\w./]+\.[tj]sx?):(\d+):(\d+)/g;
    while ((match = fileLinePattern.exec(errorText)) !== null) {
      lines.push(`  ${match[1]}:${match[2]}`);
    }

    // Extract test failure lines
    const testFailPattern = /FAIL\s+([\w./]+)/g;
    while ((match = testFailPattern.exec(errorText)) !== null) {
      lines.push(`  Test failure: ${match[1]}`);
    }

    // Extract lint error lines
    const lintPattern = /([\w./]+\.[tj]sx?)\s+line\s+(\d+)/g;
    while ((match = lintPattern.exec(errorText)) !== null) {
      lines.push(`  Lint: ${match[1]}:${match[2]}`);
    }

    if (lines.length === 0) {
      // Fallback: include the last 500 chars of the error
      return errorText.slice(-500);
    }

    return lines.join('\n');
  }

  /**
   * Build a targeted retry prompt from parsed errors, including file context around each error.
   */
  public buildRetryPrompt(originalTask: string, errors: ParsedError[], workDir: string): string {
    if (errors.length === 0) {
      return `The previous attempt failed. Retry the original task:\n\n${originalTask}`;
    }

    const errorLines: string[] = [];
    const fileContexts: string[] = [];

    for (const err of errors.slice(0, 10)) {
      const loc = err.column
        ? `${err.file}:${err.line}:${err.column}`
        : `${err.file}:${err.line}`;
      const codeStr = err.code ? ` ${err.code}` : '';
      errorLines.push(`- ${loc} —${codeStr}: ${err.message}`);

      // Read file content around the error location (±5 lines)
      if (err.file && err.line > 0) {
        const absFile = resolve(workDir, err.file);
        if (existsSync(absFile)) {
          try {
            const content = readFileSync(absFile, 'utf-8');
            const lines = content.split('\n');
            const start = Math.max(0, err.line - 6);
            const end = Math.min(lines.length, err.line + 5);
            const snippet = lines.slice(start, end).map((l: string, i: number) => {
              const lineNum = start + i + 1;
              const marker = lineNum === err.line ? '>' : ' ';
              return `  ${marker} ${String(lineNum).padStart(4)} | ${l}`;
            }).join('\n');
            fileContexts.push(`\n### ${err.file}:${err.line}\n\`\`\`\n${snippet}\n\`\`\``);
          } catch {
            // Skip if file can't be read
          }
        }
      }
    }

    const filesAffected = [...new Set(errors.map(e => e.file).filter(Boolean))];

    return `The previous attempt failed with ${errors.length} error(s). Fix these specific errors:

${errorLines.join('\n')}

Files to fix: ${filesAffected.join(', ')}

${fileContexts.join('\n')}

Original task: ${originalTask}

Fix ONLY these errors. Do not refactor or change unrelated code.`;
  }

  /**
   * Track error patterns across retry attempts to detect repeated errors.
   */
  private errorPatternHistory: Map<string, number> = new Map();

  private trackErrorPattern(errors: ParsedError[]): boolean {
    let hasRepeated = false;
    for (const err of errors) {
      const key = `${err.file}:${err.line}:${err.code || err.message}`;
      const count = (this.errorPatternHistory.get(key) || 0) + 1;
      this.errorPatternHistory.set(key, count);
      if (count >= 2) {
        hasRepeated = true;
      }
    }
    return hasRepeated;
  }

  // ---------------------------------------------------------------------------
  // DS-015: Agent "pause and ask" for clarification
  // ---------------------------------------------------------------------------

  /**
   * Pause execution and ask the user a specific clarifying question.
   * Waits for a response before continuing.
   */
  async askForClarification(
    question: string,
    context: string = '',
    options: string[] = [],
  ): Promise<string> {
    const entry: ClarificationQuestion = {
      question,
      context,
      options,
      timestamp: Date.now(),
    };

    this.clarificationHistory.push(entry);

    if (this.callbacks.onAskClarification) {
      const response = await this.callbacks.onAskClarification(question, context, options);
      entry.response = response;
      return response;
    }

    // Fallback: return empty string if no callback registered
    return '';
  }

  /**
   * Determine if the agent should pause and ask for clarification
   * based on the confidence of its current understanding.
   */
  private shouldAskForClarification(confidenceEstimate: number): boolean {
    return confidenceEstimate < this.clarifyThreshold;
  }

  /**
   * Build a clarifying question from the current task ambiguity.
   */
  private buildClarificationPrompt(messages: OAIMessage[], ambiguity: string): string {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const taskContext = lastUserMsg?.content?.slice(0, 500) || 'the current task';

    return `I need clarification on: ${ambiguity}

Context: ${taskContext}

Please provide more specific guidance so I can continue.`;
  }

  /**
   * Get all past clarification questions and responses.
   */
  getClarificationHistory(): ClarificationQuestion[] {
    return [...this.clarificationHistory];
  }

  /**
   * Clear the clarification history.
   */
  clearClarificationHistory(): void {
    this.clarificationHistory = [];
  }

  /**
   * Set the confidence threshold for when to auto-ask for clarification.
   * Default is 0.7 (ask if confidence < 70%).
   */
  setClarifyThreshold(threshold: number): void {
    this.clarifyThreshold = Math.max(0, Math.min(1, threshold));
  }

  /**
   * Pause execution and ask the user a specific question.
   * Enhanced version of askForClarification with PauseState tracking
   * and ClarificationConfig support.
   */
  async pauseForClarification(
    question: string,
    options: ClarificationConfig = {},
  ): Promise<string> {
    const pause: PauseState = {
      paused: true,
      question,
      options: options.options || [],
      timestamp: Date.now(),
      timeout: options.timeoutMs || 30000,
      resolved: false,
    };

    // Try the dedicated pause callback first
    if (this.callbacks.onPauseRequest) {
      try {
        const response = await this.callbacks.onPauseRequest(question, options);
        pause.resolved = true;
        pause.response = response;
        return response;
      } catch {
        // Fall through
      }
    }

    // Fall back to the existing askForClarification flow
    const response = await this.askForClarification(
      question,
      options.context || '',
      options.options || [],
    );

    pause.resolved = true;
    pause.response = response || options.defaultAnswer || 'continue';
    return pause.response;
  }

  /**
   * DS-015: Request clarification from the user (simplified entry point).
   * Returns the user's answer or a default if timeout.
   */
  async requestClarification(question: string): Promise<string> {
    return this.askForClarification(question, '', []);
  }

  /**
   * Continue task execution after receiving clarification from the user.
   */
  async continueWithClarification(
    task: string,
    context: string,
    criteria: string[],
    clarificationResponse: string,
  ): Promise<string> {
    const updatedContext = `${context}\n\n## Clarification Received\nThe user provided the following clarification:\n${clarificationResponse}\n\nProceed with the task using this guidance.`;
    return this.executeTask(task, updatedContext, criteria);
  }
}
