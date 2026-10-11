// Destro agent — Claude-Code-style autonomous remediation loop. Created 2026-07-04.
// The heart of Destro: ingests context, consults incident memory, loops through
// LLM turns with tool execution, self-correction, and auto-remediation recording.

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  createDestroSession,
  autocompactSession,
  appendSteerMessage,
  drainSteerMessages,
  setAbortFlag,
  checkAbortFlag,
  buildSessionContext,
  appendMessage,
  appendToolResult,
} from './destro-session.js';
import type { DestroSessionState } from './destro-session.js';
import type { DestroConfig } from './destro-config.js';
import type { DestroMessage } from './destro-context.js';
import { DestroHooks, redactSecrets } from './destro-hooks.js';
import { validateToolCall } from './tool-validator.js';
import type { ToolValidationResult } from './tool-validator.js';
import { runCheck, replayHttp, captureBaseline, compareResults } from './verify.js';
import type { VerifyResult } from './verify.js';
import { queryIncidentMemory, recordRemediation, recordFailedAttempt, queryFailedAttempts } from './incident-memory.js';
import type { RemediationEntry, FailedAttempt } from './incident-memory.js';
import { executeOpsTool, getAllOpsTools } from './ops-tools.js';
import { executeWebTool, getAllWebTools } from './web-tools.js';
import { executeDestroShell, destroShellTool, classifyCommand, commandTargetsSystemPath } from './destro-shell.js';
import type { CommandRisk } from './destro-shell.js';
import { classifyDestroError } from './destro-error-classifier.js';
import { truncateDestroOutput, truncateDestroShellOutput } from './destro-tool-output.js';
import { validateEdit } from './edit-validator.js';
import { BackgroundProcess } from './background-exec.js';
import { chatCompletionsUrl } from '../core/api-endpoint.js';
import {
  dispatchPipelineTool,
  executeDispatchPipeline,
  awaitTaskTool,
  executeAwaitTask,
} from './dispatch.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface DestroAgentOptions {
  targetDir: string;
  service?: string;
  failureSignature?: string;
  userMessage: string;
  sessionId?: string;
  config: DestroConfig;
  /** Hard-refuse all mutation tools (diagnose-only). CLI defaults to this. */
  readOnly?: boolean;
  mockLlm?: MockLlmHandler;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  onTurn?: (turn: number, status: string) => void;
}

export interface DestroAgentResult {
  status: 'resolved' | 'escalated' | 'aborted' | 'max_turns_exceeded' | 'error';
  summary: string;
  actionsLedger: { tool: string; args: string; outcome: string; ts: number }[];
  session: DestroSessionState;
  error?: string;
}

export type MockLlmHandler = (
  messages: DestroMessage[],
  tools: ToolDef[],
) => Promise<{
  content: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}>;

// ──────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface LlmResponse {
  content: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  usage?: { total_tokens: number; prompt_tokens: number; completion_tokens: number };
}

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const MAX_EMPTY_RESPONSE_RETRIES = 2;
const MAX_TOOL_VALIDATION_RETRIES = 3;
const MAX_SELF_CORRECT_ATTEMPTS = 2;
const CONTEXT_FILE_MAX_CHARS = 8000;
const SYSTEM_PROMPT_PATH = join(import.meta.dirname, 'system-prompt.md');

const CONTEXT_FILES = [
  'CLAUDE.md',
  'README.md',
  'docker-compose.yml',
  '.env.example',
];

const MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'docker_restart',
  'systemctl_restart',
  'docker_compose_up',
]);

const TERMINATION_PATTERNS = [
  /TERMINATE/i,
  /incident resolved/i,
  /issue resolved/i,
  /fixed successfully/i,
  /problem solved/i,
  /resolution complete/i,
];

// ──────────────────────────────────────────────
// R3 run_command risk gating (§6)
// ──────────────────────────────────────────────

const MUTATING_SHELL_RE = /docker\s+(compose\s+)?(build|up|rm|restart|stop)|systemctl|rm\s|mv\s|chmod|chown|tee\s|>\s|>>|sed\s+-i|git\s+(commit|push)|npm\s+(install|ci)|pip\s+install|kill|sudo|cp\s.*\/etc\//;

const DESTRO_REPEAT_LIMIT = parseInt(process.env.DESTRO_REPEAT_LIMIT || '2', 10) || 2;
// Raised 5→12: transient/sandbox tool errors (bash process substitution, grep
// no-match exit codes, a read-only-refused command) each add a failedKey, so a
// low ceiling force-converged real audits to INCONCLUSIVE after only a few
// probes. 12 gives headroom to push through sandbox noise before concluding.
const DESTRO_EXPLORE_LIMIT = parseInt(process.env.DESTRO_EXPLORE_LIMIT || '12', 10) || 12;
const DESTRO_TOKEN_BUDGET = parseInt(process.env.DESTRO_TOKEN_BUDGET || '4000000', 10) || 4000000;
// Raised 30min→60min so long audits (which check in every ~8 min, see system
// prompt) have room for several cycles before the wall-clock budget trips.
const DESTRO_TIME_BUDGET_MS = parseInt(process.env.DESTRO_TIME_BUDGET_MS || '3600000', 10) || 3600000;

// ──────────────────────────────────────────────
// P08 DEFINITIVE-RESULT settled assertions
// ──────────────────────────────────────────────

const VERIFY_CHECK_RE = /tsc|curl.*-w|http_code|--test|vitest|npm (run )?test|docker compose config/;

const VERIFY_CLASS_TOOLS = new Set([
  'http_health_probe',
  'port_check',
  'run_check',
]);

function isVerifyClassTool(name: string, input: Record<string, unknown>): boolean {
  if (VERIFY_CLASS_TOOLS.has(name)) return true;
  if (name === 'run_command') {
    const cmd = String(input.command || '');
    return VERIFY_CHECK_RE.test(cmd);
  }
  return false;
}

function settledKey(name: string, input: Record<string, unknown>): string {
  const suffix = input.url || input.port || input.path || String(input.command || '').slice(0, 60);
  return name + ':' + suffix;
}

// ──────────────────────────────────────────────
// Synthetic tool definitions
// ──────────────────────────────────────────────

const readFileTool: ToolDef = {
  name: 'read_file',
  description: 'Read a file from the project. Returns the file contents.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to project root' },
      offset: { type: 'number', description: 'Start line (0-based). Omit to read from start.' },
      limit: { type: 'number', description: 'Max lines to read. Omit to read entire file.' },
    },
    required: ['path'],
  },
};

const writeFileTool: ToolDef = {
  name: 'write_file',
  description: 'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to project root' },
      content: { type: 'string', description: 'Full file content to write' },
    },
    required: ['path', 'content'],
  },
};

const editFileTool: ToolDef = {
  name: 'edit_file',
  description: 'Replace a specific string in a file. The old_string must appear exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to project root' },
      old_string: { type: 'string', description: 'Exact string to find and replace' },
      new_string: { type: 'string', description: 'Replacement string' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
};

const applyPatchTool: ToolDef = {
  name: 'apply_patch',
  description: 'Apply a patch to one or more files using *** Begin Patch / *** End Patch format.',
  input_schema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'The full patch text' },
      workDir: { type: 'string', description: 'Working directory to resolve relative paths against' },
    },
    required: ['patch'],
  },
};

const recordHypothesisTool: ToolDef = {
  name: 'record_hypothesis',
  description: 'Record a working hypothesis about the root cause. Status can be open, falsified, or confirmed. Falsified hypotheses are pinned and will never be retried.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The hypothesis text (what you believe is the root cause)' },
      status: { type: 'string', enum: ['open', 'falsified', 'confirmed'], description: 'Current status of this hypothesis' },
    },
    required: ['text', 'status'],
  },
};

// ──────────────────────────────────────────────
// Tool schema map builder
// ──────────────────────────────────────────────

function buildToolSchemaMap(): Map<string, ToolDef> {
  const map = new Map<string, ToolDef>();

  const opsTools = getAllOpsTools();
  for (const t of opsTools) {
    map.set(t.name, { name: t.name, description: t.description, input_schema: t.input_schema });
  }

  const webTools = getAllWebTools();
  for (const t of webTools) {
    map.set(t.name, { name: t.name, description: t.description, input_schema: t.input_schema });
  }

  map.set(destroShellTool.name, {
    name: destroShellTool.name,
    description: destroShellTool.description,
    input_schema: destroShellTool.input_schema,
  });

  map.set(dispatchPipelineTool.name, {
    name: dispatchPipelineTool.name,
    description: dispatchPipelineTool.description,
    input_schema: dispatchPipelineTool.input_schema,
  });

  map.set(awaitTaskTool.name, {
    name: awaitTaskTool.name,
    description: awaitTaskTool.description,
    input_schema: awaitTaskTool.input_schema,
  });

  const synthetic = [readFileTool, writeFileTool, editFileTool, applyPatchTool, recordHypothesisTool];
  for (const t of synthetic) {
    map.set(t.name, t);
  }

  return map;
}

/**
 * Build a Record<string, ToolDef> for validateToolCall.
 */
function buildToolSchemaRecord(): Record<string, ToolDef> {
  const map = buildToolSchemaMap();
  const rec: Record<string, ToolDef> = {};
  for (const [key, val] of map) {
    rec[key] = val;
  }
  return rec;
}

function getAllToolDefs(): ToolDef[] {
  return [
    ...getAllOpsTools().map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    ...getAllWebTools().map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    { name: destroShellTool.name, description: destroShellTool.description, input_schema: destroShellTool.input_schema },
    readFileTool,
    writeFileTool,
    editFileTool,
    applyPatchTool,
    recordHypothesisTool,
    dispatchPipelineTool,
    awaitTaskTool,
  ];
}

// ──────────────────────────────────────────────
// Project context ingestion
// ──────────────────────────────────────────────

async function ingestProjectContext(targetDir: string): Promise<string[]> {
  const contextFiles: string[] = [];

  for (const filename of CONTEXT_FILES) {
    const filePath = join(targetDir, filename);
    if (!existsSync(filePath)) continue;

    try {
      const raw = await readFile(filePath, 'utf-8');
      const truncated = raw.length > CONTEXT_FILE_MAX_CHARS
        ? raw.slice(0, CONTEXT_FILE_MAX_CHARS) + '\n... (truncated)'
        : raw;
      contextFiles.push(`### ${filename}\n\`\`\`\n${truncated}\n\`\`\``);
    } catch {
      // file unreadable — skip
    }
  }

  return contextFiles;
}

// ──────────────────────────────────────────────
// System prompt assembly
// ──────────────────────────────────────────────

async function buildSystemPrompt(
  incidentMemory: string,
  projectContext: string[],
): Promise<string> {
  let systemPrompt = '';

  try {
    systemPrompt = await readFile(SYSTEM_PROMPT_PATH, 'utf-8');
  } catch {
    systemPrompt = `You are Destro, an autonomous incident remediation agent.
Your job is to diagnose and fix incidents in production systems.
Use the available tools to investigate, diagnose, and remediate.
Always verify your fixes. Do not make changes without understanding the root cause.`;
  }

  const sections: string[] = [systemPrompt];

  if (incidentMemory) {
    sections.push(`\n\n## Past Incident Memory\n${incidentMemory}`);
  }

  if (projectContext.length > 0) {
    sections.push(`\n\n## Project Context\n${projectContext.join('\n\n')}`);
  }

  return sections.join('\n');
}

// ──────────────────────────────────────────────
// LLM API call
// ──────────────────────────────────────────────

async function callDestroLlm(
  config: DestroConfig,
  systemPrompt: string,
  messages: DestroMessage[],
  tools: ToolDef[],
  mockLlm?: MockLlmHandler,
): Promise<LlmResponse> {
  if (mockLlm) {
    return mockLlm(messages, tools);
  }

  const baseUrl = config.provider.baseUrl || 'https://api.openai.com/v1';
  const url = chatCompletionsUrl(baseUrl);

  const openaiTools = tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  const body = {
    model: config.provider.model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_use_id) msg.tool_call_id = m.tool_use_id;
        if (m.name) msg.name = m.name;
        return msg;
      }),
    ],
    tools: openaiTools,
    max_tokens: 8192,
    temperature: 0.1,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'unknown error');
        if (resp.status >= 400 && resp.status < 500) {
          return {
            content: `API error (${resp.status}): ${errText}`,
            toolCalls: [],
          };
        }
        // 5xx — retry
        lastError = new Error(`API error ${resp.status}: ${errText}`);
        continue;
      }

      const data = (await resp.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{
              id: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: {
          total_tokens: number;
          prompt_tokens: number;
          completion_tokens: number;
        };
      };

      const choice = data.choices?.[0];
      const msg = choice?.message;
      const content = msg?.content || '';

      const rawToolCalls = msg?.tool_calls || [];
      const toolCalls = rawToolCalls.map(tc => {
        let input: Record<string, unknown> = {};
        try {
          input = tc.function?.arguments
            ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
            : {};
        } catch {
          input = { _raw_args: tc.function?.arguments || '' };
        }
        return {
          id: tc.id,
          name: tc.function?.name || 'unknown',
          input,
        };
      });

      return { content, toolCalls, usage: data.usage };
    } catch (err: unknown) {
      lastError = err as Error;
      // network error — retry once
      continue;
    }
  }

  return {
    content: `LLM call failed after retries: ${lastError?.message || 'unknown error'}`,
    toolCalls: [],
  };
}

// ──────────────────────────────────────────────
// Tool execution dispatcher
// ──────────────────────────────────────────────

async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  workDir: string,
  targetDir: string,
  incidentId: string,
  hooks: DestroHooks,
): Promise<{ result: string; isError: boolean }> {
  const absWorkDir = resolve(workDir || targetDir);
  const absTargetDir = resolve(targetDir);

  try {
    // ── ops-tools ────────────────────────────
    if (getAllOpsTools().some(t => t.name === name)) {
      const opsResult = await executeOpsTool(name, input, absWorkDir);
      const raw = JSON.stringify(opsResult, null, 2);
      const clamped = truncateDestroShellOutput(raw);
      const redacted = redactSecrets(clamped.text);
      return { result: redacted, isError: !opsResult.ok };
    }

    // ── web-tools ────────────────────────────
    if (getAllWebTools().some(t => t.name === name)) {
      const webResult = await executeWebTool(name, input);
      const raw = JSON.stringify(webResult, null, 2);
      const clamped = truncateDestroOutput(raw);
      const redacted = redactSecrets(clamped.text);
      return { result: redacted, isError: !webResult.ok };
    }

    // ── run_command ──────────────────────────
    if (name === 'run_command') {
      const shellResult = await executeDestroShell(
        { command: input.command as string, timeout: input.timeout as number | undefined },
        absWorkDir,
      );
      const clamped = truncateDestroShellOutput(shellResult.result);
      const redacted = redactSecrets(clamped.text);
      return { result: redacted, isError: shellResult.is_error };
    }

    // ── read_file ────────────────────────────
    if (name === 'read_file') {
      const filePath = resolve(absTargetDir, input.path as string);
      if (!filePath.startsWith(absTargetDir + '/') && filePath !== absTargetDir) {
        return { result: 'Error: path traversal detected', isError: true };
      }
      const content = await readFile(filePath, 'utf-8');
      let output = content;
      if (input.offset !== undefined || input.limit !== undefined) {
        const lines = content.split('\n');
        const start = (input.offset as number) || 0;
        const end = input.limit !== undefined ? start + (input.limit as number) : lines.length;
        output = lines.slice(start, end).join('\n');
      }
      const clamped = truncateDestroOutput(output);
      const redacted = redactSecrets(clamped.text);
      return { result: redacted, isError: false };
    }

    // ── write_file ───────────────────────────
    if (name === 'write_file') {
      const filePath = resolve(absTargetDir, input.path as string);
      if (!filePath.startsWith(absTargetDir + '/') && filePath !== absTargetDir) {
        return { result: 'Error: path traversal detected', isError: true };
      }

      const content = input.content as string;

      // Capture old content for validation
      let oldContent = '';
      try { oldContent = await readFile(filePath, 'utf-8'); } catch { /* new file */ }

      // Corruption guard: empty/missing content over an existing non-empty file is
      // a truncation signature, not a plausible edit (this exact path 0-byted
      // core/task-store.ts on 2026-07-04). Refuse; demand explicit full content.
      if ((!content || content.trim().length === 0) && oldContent.length > 0) {
        return {
          result: `REFUSED: write_file with empty content would truncate existing non-empty file ${input.path} (${oldContent.length} bytes). If you truly intend to empty it, say so explicitly and rewrite with a placeholder comment; otherwise provide the full new content.`,
          isError: true,
        };
      }

      // Pre-mutation safety
      const targets = [filePath];
      await hooks.preMutation(absWorkDir, incidentId, targets);

      await writeFile(filePath, content, 'utf-8');

      // Post-mutation
      await hooks.postMutation(absWorkDir, incidentId, `write_file ${input.path}`, targets);

      // Validate edit
      const validation = await validateEdit(filePath, absTargetDir);
      if (!validation.valid) {
        return {
          result: redactSecrets(`File written but validation warnings: ${validation.diagnostics?.join('; ') || ''}`),
          isError: false,
        };
      }

      const clamped = truncateDestroOutput('File written successfully.');
      return { result: redactSecrets(clamped.text), isError: false };
    }

    // ── edit_file ────────────────────────────
    if (name === 'edit_file') {
      const filePath = resolve(absTargetDir, input.path as string);
      if (!filePath.startsWith(absTargetDir + '/') && filePath !== absTargetDir) {
        return { result: 'Error: path traversal detected', isError: true };
      }

      const oldStr = input.old_string as string;
      const newStr = input.new_string as string;

      // Pre-mutation safety
      const targets = [filePath];
      await hooks.preMutation(absWorkDir, incidentId, targets);

      const oldContent = await readFile(filePath, 'utf-8');

      if (!oldContent.includes(oldStr)) {
        return {
          result: redactSecrets(`Error: old_string not found in file. The file may have changed.`),
          isError: true,
        };
      }

      const occurrences = oldContent.split(oldStr).length - 1;
      if (occurrences > 1) {
        return {
          result: redactSecrets(`Error: old_string appears ${occurrences} times in the file. It must be unique.`),
          isError: true,
        };
      }

      const newContent = oldContent.replace(oldStr, newStr);
      await writeFile(filePath, newContent, 'utf-8');

      // Post-mutation
      await hooks.postMutation(absWorkDir, incidentId, `edit_file ${input.path}`, targets);

      // Validate edit
      const validation = await validateEdit(filePath, absTargetDir);
      if (!validation.valid) {
        return {
          result: redactSecrets(`Edit applied but validation warnings: ${validation.diagnostics?.join('; ') || ''}`),
          isError: false,
        };
      }

      const clamped = truncateDestroOutput('Edit applied successfully.');
      return { result: redactSecrets(clamped.text), isError: false };
    }

    // ── apply_patch ──────────────────────────
    if (name === 'apply_patch') {
      const patchStr = input.patch as string;
      const patchWorkDir = (input.workDir as string) || absTargetDir;

      // Pre-mutation safety
      const targets: string[] = [];
      const patchLines = patchStr.split('\n');
      for (const line of patchLines) {
        const m = line.match(/^\+\+\+ b\/(.+)$/);
        if (m) targets.push(resolve(patchWorkDir, m[1]));
      }

      await hooks.preMutation(absWorkDir, incidentId, targets);

      // Apply patch via shell (uses patch command)
      const tempPatchPath = join(absWorkDir, `.destro-patch-${incidentId}.patch`);
      await writeFile(tempPatchPath, patchStr, 'utf-8');

      try {
        const patchResult = await executeDestroShell(
          { command: `patch -p1 < "${tempPatchPath}"`, timeout: 30 },
          patchWorkDir,
        );

        // Post-mutation
        await hooks.postMutation(absWorkDir, incidentId, 'apply_patch', targets);

        const clamped = truncateDestroShellOutput(patchResult.result);
        return { result: redactSecrets(clamped.text), isError: patchResult.is_error };
      } finally {
        try { await readFile(tempPatchPath); /* noop */ } catch { /* already cleaned */ }
      }
    }

    // ── background_exec ──────────────────────
    if (name === 'background_exec') {
      const cmd = input.command as string;
      const bg = new BackgroundProcess(cmd, {
        cwd: (input.cwd as string) || absWorkDir,
      });
      bg.start();

      const pid = bg.childProcess?.pid || 0;
      const output = bg.getOutput();
      const clamped = truncateDestroShellOutput(
        `Background process started (PID: ${pid}).\nInitial output:\n${output.combined}`,
      );
      return { result: redactSecrets(clamped.text), isError: false };
    }

    // ── dispatch_pipeline ──────────────────
    if (name === 'dispatch_pipeline') {
      const dispatchResult = await executeDispatchPipeline(input);
      return { result: redactSecrets(dispatchResult.result), isError: dispatchResult.isError };
    }

    // ── record_hypothesis ──────────────────
    if (name === 'record_hypothesis') {
      const text = (input.text as string) || '';
      const status = (input.status as string) || 'open';
      const entry = {
        tool: 'hypothesis',
        args: text.slice(0, 500),
        outcome: status,
        ts: Date.now(),
      };
      return { result: redactSecrets(`Hypothesis recorded: [${status}] ${text}`), isError: false };
    }

    return {
      result: redactSecrets(`Unknown tool: ${name}`),
      isError: true,
    };
  } catch (err: unknown) {
    const msg = (err as Error).message || 'unknown error';
    return { result: redactSecrets(`Tool execution error: ${msg}`), isError: true };
  }
}

// ──────────────────────────────────────────────
// Termination check
// ──────────────────────────────────────────────

function isTerminationResponse(content: string, toolCalls: Array<unknown>): boolean {
  if (toolCalls.length > 0) return false;

  for (const pattern of TERMINATION_PATTERNS) {
    if (pattern.test(content)) return true;
  }

  return false;
}

// ──────────────────────────────────────────────
// Fallback verdict synthesis (P07)
// ──────────────────────────────────────────────

function synthesizeFallbackVerdict(
  actionsLedger: { tool: string; args: string; outcome: string; ts: number }[],
): string {
  const checks = actionsLedger.slice(-15).map(e => `- ${e.tool}: ${e.outcome}`).join('\n');
  return `VERDICT: INCONCLUSIVE\nEVIDENCE:\n${checks || '- (no actions recorded)'}\nRECOMMENDATION: ran out of budget before converging; re-run with a tighter scope or higher budget.`;
}

// ──────────────────────────────────────────────
// Success-verdict verification gate (§16.6)
// ──────────────────────────────────────────────
// Destro's characteristic failure is declaring a PASS after mutating files without
// re-driving the real thing — verifying the static surface (it parses, the symbol exists,
// a config sums correctly, a table was created) or, worse, hand-feeding synthetic inputs to
// make a check pass. The gate forces exactly one real-world-evidence challenge before any
// success verdict on a mutation session is accepted.

/** Does this concluding message CLAIM success (vs. an honest FAIL/UNVERIFIED/INCONCLUSIVE)? */
function claimsSuccessVerdict(content: string): boolean {
  if (/VERDICT:\s*(FAIL|UNVERIFIED|INCONCLUSIVE)/i.test(content)) return false;
  if (/VERDICT:\s*PASS/i.test(content)) return true;
  // No explicit verdict line — treat success-toned conclusions as a claim too.
  return /\b(resolved|fixed|done|complete[d]?|working now|success(?:ful)?|verified|it passes|passing)\b/i.test(content);
}

const SUCCESS_VERDICT_CHALLENGE =
  'STOP — do not conclude success yet. You changed files this session, so a PASS is only valid with '
  + 'END-TO-END proof on the REAL system:\n'
  + '- NOT from static checks alone (it parses / the symbol exists / a config sums to 1.0 / a table was created / a file is non-empty).\n'
  + '- NOT from test inputs you created, injected, mocked, or hand-fed to make a check pass.\n'
  + 'Re-drive the ACTUAL thing you were asked to deliver — the real endpoint, the real query, the real failing '
  + 'flow — against data that ALREADY EXISTS in the system, and show the observed output proving the goal is met '
  + '(a before/after difference is strongest). If you CANNOT produce that real-world evidence, emit '
  + '`VERDICT: UNVERIFIED` and list exactly what remains unproven. Fabricating or mocking evidence to reach PASS '
  + 'is a hard-rule violation, not a shortcut.\n'
  + 'THEN INTERROGATE YOUR OWN EVIDENCE like someone trying to prove you WRONG — a green number is not a PASS if the '
  + 'test is self-serving. Explicitly check and state: is this a test YOU wrote and a metric YOU chose? Does the '
  + 'control/baseline perform at chance (≈0.5 AUC / random) — if so your test is BROKEN, not passing, because a real '
  + 'baseline should do better than a coin flip. Do the ground-truth labels encode the very signal your change '
  + 'outputs (circular)? Would a skeptic accept this, or does it only pass because it was built to? If your evidence '
  + 'fails this scrutiny, it is NOT a PASS — say so (`VERDICT: UNVERIFIED`) and name the weakness. Do not rubber-stamp '
  + 'your own weak green.';

/** Does this concluding message CLAIM failure (a bare grade rather than a delivered product)? */
function claimsFailureVerdict(content: string): boolean {
  return /VERDICT:\s*(FAIL|UNVERIFIED|INCONCLUSIVE)/i.test(content);
}

// §16.7 — symmetric counterpart to SUCCESS_VERDICT_CHALLENGE. A mutating session may not
// conclude with a bare FAIL: Destro's deliverable is a working product, so on failure it must
// fix it, revert to its backup, or hand it back to the orchestrator — never just grade and quit.
const FAIL_VERDICT_CHALLENGE =
  'STOP — a FAIL / UNVERIFIED verdict is NOT a deliverable when YOU changed the target this session. '
  + 'Your job is to PRODUCE A WORKING PRODUCT, not to grade the failure. Before you may conclude you must do ONE of these:\n'
  + '1. FIX IT (only if it is a small RUNTIME/CONFIG repair) — read the ACTUAL error now (pull the fresh traceback / '
  + 'logs, re-drive the real failing flow), correct the fault, and prove it works end-to-end on real inputs. A bug '
  + 'YOU introduced (e.g. a NameError in code you just edited) is yours to fix — the traceback names the file and line.\n'
  + '2. REVERT — if you cannot fix it, restore the target to the working state you found it in by reverting to your '
  + './archive/<incident> backup, then verify the original flow works again. Leaving it worse than you found it is not allowed.\n'
  + '3. HAND IT BACK TO THE ORCHESTRATOR — dispatch_pipeline({kind:"orchestrator"|"worker"}) with a precise repair spec '
  + '(the file, the exact error/traceback, and what you already tried). This is REQUIRED — not optional — when the fix '
  + 'is real ENGINEERING (new or changed logic, model/algorithm/scoring changes, multi-file features) or the root cause '
  + 'is an ORCHESTRATION / pipeline defect. Building substantial software is the factory\'s job, not the repair lane\'s: '
  + 'do NOT hand-write large engineering yourself, and do NOT make off-task/scope-creep edits to unrelated code to force '
  + 'a pass. Ship it back.\n'
  + 'Do one of these NOW. Do not re-emit a bare FAIL — leaving the product broken and grading it is a non-deliverable.';

// ──────────────────────────────────────────────
// Self-correct loop
// ──────────────────────────────────────────────

async function attemptSelfCorrect(
  verification: VerifyResult,
  incidentId: string,
  workDir: string,
): Promise<boolean> {
  if (!verification.worse) return true; // better or same = keep going

  // Try to revert to git stash
  for (let i = 0; i < MAX_SELF_CORRECT_ATTEMPTS; i++) {
    try {
      const shellResult = await executeDestroShell(
        { command: `git stash list | grep "destro: pre-${incidentId}" | head -1`, timeout: 10 },
        workDir,
      );
      if (shellResult.is_error || !shellResult.result.trim()) return false;

      await executeDestroShell(
        { command: `git stash pop`, timeout: 10 },
        workDir,
      );

      // Re-verify after revert
      const recheck = await runCheck('exit 0', workDir);
      if (!recheck.worse) return true;
    } catch {
      // revert failed, try next attempt
    }
  }

  return false;
}

// ──────────────────────────────────────────────
// Main agent loop
// ──────────────────────────────────────────────

export async function destroAgentLoop(
  options: DestroAgentOptions,
): Promise<DestroAgentResult> {
  const {
    targetDir,
    service,
    failureSignature,
    userMessage,
    sessionId,
    config,
    mockLlm,
    onToolCall,
    onTurn,
  } = options;

  const absTargetDir = resolve(targetDir);
  const workDir = config.workDir || absTargetDir;
  const incidentId = sessionId || `destro-${Date.now()}`;
  const hooks = new DestroHooks();
  const actionsLedger: { tool: string; args: string; outcome: string; ts: number }[] = [];
  const schemaRecord = buildToolSchemaRecord();
  const allTools = getAllToolDefs();
  const settledAssertions = new Map<string, string>();

  // ── 1. Initialize session ──────────────────
  const session = createDestroSession(incidentId);

  // ── 2. Ingest project context ──────────────
  const contextFiles = await ingestProjectContext(absTargetDir);
  session.contextFiles = contextFiles;

  // ── 3. Consult incident memory ─────────────
  let incidentMemoryText = '';
  try {
    const pastIncidents = await queryIncidentMemory(
      service || 'unknown',
      failureSignature || userMessage,
    );
    if (pastIncidents && pastIncidents.length > 0) {
      incidentMemoryText = pastIncidents
        .map((entry: RemediationEntry, i: number) =>
          `**Past incident ${i + 1}**: ${entry.diagnosis}\nFix: ${entry.fix}\nOutcome: ${entry.outcome} (${new Date(entry.ts).toISOString()})`
        )
        .join('\n\n');
    }

    // R3 §2b: Also inject known dead ends for this service/signature
    const deadEnds = await queryFailedAttempts(
      service || 'unknown',
      failureSignature || userMessage,
    );
    if (deadEnds && deadEnds.length > 0) {
      const deadEndText = deadEnds
        .map((a: FailedAttempt, i: number) =>
          `**Dead end ${i + 1}**: ${a.attemptedFix}\nWhy failed: ${a.whyFailed} (${new Date(a.ts).toISOString()})`
        )
        .join('\n');
      incidentMemoryText += `\n\nKNOWN DEAD ENDS for this service/signature (do NOT retry these):\n${deadEndText}`;
    }
  } catch {
    // incident memory unavailable — continue without
  }

  // ── 4. Build system prompt ────────────────
  const systemPrompt = await buildSystemPrompt(incidentMemoryText, contextFiles);

  // ── 5. Add user message ───────────────────
  appendMessage(session, { role: 'user', content: userMessage });

  // ── 6. MAIN LOOP ──────────────────────────
  const maxTurns = config.maxTurns || 300;
  let finalStatus: DestroAgentResult['status'] = 'max_turns_exceeded';
  let finalSummary = '';
  let finalError: string | undefined;
  let consecutiveApiErrors = 0;
  let selfCorrectAttempts = 0;

  // Budget tracking
  const loopStart = Date.now();
  let cumulativeTokens = 0;
  let budgetExceeded = false;

  // R3 tracking state
  const failCounts = new Map<string, number>();
  const failedKeys = new Set<string>();
  let boundedExplorationMessageSent = false;
  let convergeTriggered = false;

  // §16.6 success-verdict verification gate state
  let mutatedThisSession = false;
  let successVerdictChallenged = false;
  let failVerdictChallenged = false;

  // Foreman liveness state — orchestrator tasks dispatched this session, so the
  // conclusion gate can refuse to grade a build that is still running.
  const dispatchedOrchestratorTasks = new Set<string>();
  let orchestratorGateNudges = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    // a. Check abort flag
    if (checkAbortFlag(session)) {
      finalStatus = 'aborted';
      finalSummary = 'Aborted by external signal.';
      if (onTurn) onTurn(turn, 'aborted');
      break;
    }

    // b. Drain steer messages, prepend to messages
    const steers = drainSteerMessages(session);
    for (const s of steers) {
      appendMessage(session, {
        role: 'user',
        content: `[STEER from ${s.from}]: ${s.message}`,
      });
    }

    // c. Autocompact session
    autocompactSession(session);

    // c2. Budget-edge convergence trigger (P06)
    if (!convergeTriggered && (
      turn >= Math.floor(maxTurns * 0.8) ||
      budgetExceeded ||
      failedKeys.size >= DESTRO_EXPLORE_LIMIT
    )) {
      convergeTriggered = true;
      appendMessage(session, {
        role: 'user',
        content: 'BUDGET LIMIT REACHED. Stop investigating now. Emit your FINAL structured verdict from current evidence in this exact shape then TERMINATE:\nVERDICT: PASS | FAIL | INCONCLUSIVE\nEVIDENCE: <per-check what you ran and got>\nRECOMMENDATION: <next step for the CTO>',
      });
    }

    // d. LLM turn
    if (onTurn) onTurn(turn, 'thinking');

    let llmResponse: LlmResponse;
    let emptyRetries = 0;

    while (true) {
      llmResponse = await callDestroLlm(
        config,
        systemPrompt,
        session.messages,
        allTools,
        mockLlm,
      );

      if (llmResponse.content || llmResponse.toolCalls.length > 0) break;

      emptyRetries++;
      if (emptyRetries > MAX_EMPTY_RESPONSE_RETRIES) {
        finalStatus = 'error';
        finalError = 'LLM returned empty responses after retries.';
        if (onTurn) onTurn(turn, 'empty-response-error');
        break;
      }

      appendMessage(session, {
        role: 'user',
        content: 'Please provide your analysis and next action.',
      });
    }

    if (finalStatus === 'error') break;

    // Budget tracking: accumulate tokens + wall time
    if (llmResponse.usage?.total_tokens) {
      cumulativeTokens += llmResponse.usage.total_tokens;
    }
    if (!budgetExceeded && (cumulativeTokens >= DESTRO_TOKEN_BUDGET || Date.now() - loopStart >= DESTRO_TIME_BUDGET_MS)) {
      budgetExceeded = true;
    }

    // f. Parse response — already done in callDestroLlm
    const { content, toolCalls } = llmResponse;

    // f2. FAIL FAST on non-retryable client errors. callDestroLlm surfaces API
    // failures as content ("API error (4xx): ..."); a 4xx (bad request/auth) will
    // never heal by retrying — without this check the loop grinds to maxTurns
    // burning a failed call per turn.
    if (/^API error \(4\d\d\)/.test(content) && toolCalls.length === 0) {
      consecutiveApiErrors++;
      if (consecutiveApiErrors >= 2) {
        finalStatus = 'error';
        finalError = `Non-retryable LLM API error: ${content.slice(0, 300)}`;
        if (onTurn) onTurn(turn, 'api-error');
        break;
      }
    } else {
      consecutiveApiErrors = 0;
    }

    // g. Validate tool calls
    let allValid = true;
    for (const tc of toolCalls) {
      const validation: ToolValidationResult = validateToolCall(
        tc.name,
        tc.input,
        schemaRecord,
      );

      if (!validation.valid && validation.correctivePrompt) {
        allValid = false;
        appendMessage(session, {
          role: 'user',
          content: `Tool call "${tc.name}" was invalid: ${validation.correctivePrompt}`,
        });
      }
    }

    if (!allValid) {
      if (turn >= maxTurns - 1) {
        finalStatus = 'error';
        finalError = 'Tool validation failed repeatedly.';
        break;
      }
      continue;
    }

    // h0. Append the assistant message BEFORE executing tools — OpenAI-protocol
    // providers require tool-role messages to FOLLOW an assistant message carrying
    // matching tool_calls; appending it after (old step k) orphaned the tool
    // results and 400'd every subsequent turn.
    const assistantTurnMsg: DestroMessage = { role: 'assistant', content };
    if (toolCalls.length > 0) {
      assistantTurnMsg.tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
    }
    appendMessage(session, assistantTurnMsg);

    // h. Execute tool calls
    let madeMutation = false;
    let madeProgress = false; // R3 §5: set true on successful mutation or verify-better

    for (const tc of toolCalls) {
      if (onToolCall) onToolCall(tc.name, tc.input);

      const isMutation = MUTATION_TOOLS.has(tc.name);

      // R3 §1: Repeat-failure breaker
      const repeatKey = tc.name + ':' + JSON.stringify(tc.input);
      const prevFails = failCounts.get(repeatKey) || 0;
      if (prevFails >= DESTRO_REPEAT_LIMIT) {
        appendToolResult(session, tc.id, tc.name,
          `REFUSED: this exact call failed ${DESTRO_REPEAT_LIMIT}x this session. Retrying identical calls is not an option — pivot to a different approach or escalate with findings.`,
          true);
        const refusedEntry = { tool: tc.name, args: JSON.stringify(tc.input).slice(0, 500), outcome: 'REFUSED (repeat-failure)', ts: Date.now() };
        actionsLedger.push(refusedEntry);
        session.actionsLedger.push(refusedEntry);
        failedKeys.add(repeatKey);
        continue;
      }

      // Read-only mode: mutations are hard-refused in code, not prompt-refused.
      if (isMutation && options.readOnly) {
        appendToolResult(session, tc.id, tc.name,
          `REFUSED: session is READ-ONLY (diagnose-only). Mutation tool "${tc.name}" is disabled. Report your diagnosis and recommended fix instead of applying it.`,
          true);
        const refusedEntry = { tool: tc.name, args: JSON.stringify(tc.input).slice(0, 500), outcome: 'REFUSED (read-only)', ts: Date.now() };
        actionsLedger.push(refusedEntry);
        session.actionsLedger.push(refusedEntry);
        continue;
      }

      // R3 §6: run_command risk gating
      if (tc.name === 'run_command') {
        const cmd = (tc.input.command as string) || '';

        // System-critical path protection (defense in depth — shell tool also blocks)
        const sysPath = commandTargetsSystemPath(cmd);
        if (sysPath) {
          appendToolResult(session, tc.id, tc.name,
            `BLOCKED: command targets system-critical path "${sysPath}". ` +
            `This is a HOST-WIDE configuration — modifying it affects ALL services on this server. ` +
            `Report this as a recommended change for the operator to apply manually.`,
            true);
          const blockedEntry = { tool: tc.name, args: JSON.stringify(tc.input).slice(0, 500), outcome: `BLOCKED (system-critical: ${sysPath})`, ts: Date.now() };
          actionsLedger.push(blockedEntry);
          session.actionsLedger.push(blockedEntry);
          failedKeys.add(repeatKey);
          continue;
        }

        const risk = classifyCommand(cmd);
        const isMutatingShell = MUTATING_SHELL_RE.test(cmd) || risk.level !== 'safe';

        if (isMutatingShell && options.readOnly) {
          appendToolResult(session, tc.id, tc.name,
            `REFUSED: session is READ-ONLY (diagnose-only). Shell command "${cmd.slice(0, 120)}" is classified as mutating (risk: ${risk.level}, ${risk.reason}). Report your diagnosis and recommended fix instead of applying it.`,
            true);
          const refusedEntry = { tool: tc.name, args: JSON.stringify(tc.input).slice(0, 500), outcome: 'REFUSED (mutating-shell, read-only)', ts: Date.now() };
          actionsLedger.push(refusedEntry);
          session.actionsLedger.push(refusedEntry);
          failedKeys.add(repeatKey);
          continue;
        }

        if (isMutatingShell && !options.readOnly) {
          // auto mode — allow but audit
          const auditEntry = { tool: tc.name, args: JSON.stringify(tc.input).slice(0, 500), outcome: 'AUDIT (mutating-shell)', ts: Date.now() };
          actionsLedger.push(auditEntry);
          session.actionsLedger.push(auditEntry);
          // §16.6/16.7: a mutating shell command (file rewrite via heredoc, docker compose up,
          // sed -i, etc.) IS a session mutation — arm the success/failure verdict gates so a
          // shell-only editing session can't slip past them (the original dead-end: run_command
          // edits never set madeMutation, so neither gate ever fired).
          mutatedThisSession = true;
        }
      }

      const execResult = await executeToolCall(
        tc.name,
        tc.input,
        workDir,
        absTargetDir,
        incidentId,
        hooks,
      );

      // Foreman liveness: remember any orchestrator task we dispatched, so the
      // conclusion gate below refuses to grade the build while it is still running.
      if (tc.name === 'dispatch_pipeline' && !execResult.isError) {
        try {
          const parsed = JSON.parse(execResult.result);
          if (parsed && parsed.lane === 'orchestrator' && parsed.taskId) {
            dispatchedOrchestratorTasks.add(String(parsed.taskId));
          }
        } catch { /* non-JSON dispatch result — nothing to track */ }
      }

      // P08: DEFINITIVE-RESULT settled assertion tracking
      if (isVerifyClassTool(tc.name, tc.input)) {
        const sk = settledKey(tc.name, tc.input);
        const priorSummary = settledAssertions.get(sk);
        if (!execResult.isError) {
          settledAssertions.set(sk, execResult.result.slice(0, 200));
        }
        if (priorSummary !== undefined) {
          execResult.result = `[ALREADY SETTLED: this exact check returned ${priorSummary} earlier — treat as settled; act on it, do not keep re-verifying.]\n` + execResult.result;
        }
      }

      if (isMutation) {
        madeMutation = true;
      }

      // R3 §1: track repeat failures
      if (execResult.isError) {
        failCounts.set(repeatKey, prevFails + 1);
        failedKeys.add(repeatKey);
      } else {
        failCounts.set(repeatKey, 0);
      }

      // R3 §3: Classified failures — append classification hint when isError
      let resultText = execResult.result;
      if (execResult.isError && resultText) {
        try {
          const classification = classifyDestroError(resultText);
          if (classification.action !== 'retry' && classification.action !== 'fail') {
            // Known pattern — append classification hint
            const hints: Record<string, string> = {
              'mkdir': 'hint: the target directory does not exist — create it first',
              'rehydrate': 'hint: authentication/authorization failed — check credentials or key rotation',
              'compact': 'hint: context overflow — compact the session or reduce context size',
              'memory_limit': 'hint: out of memory — reduce memory pressure or increase limits',
              'container_issue': `hint: container issue detected (${classification.containerSignature || 'unknown'}) — check container logs and state`,
              'retry_with_context': 'hint: TypeScript compilation error — review the error details and fix the code',
            };
            const hint = hints[classification.action] || '';
            if (hint) {
              resultText += `\n[CLASSIFIED: ${classification.action} — ${hint}]`;
            }
          }
        } catch {
          // classifier error — ignore, don't block the tool result
        }
      }

      // Append tool result to session
      appendToolResult(
        session,
        tc.id,
        tc.name,
        resultText,
        execResult.isError,
      );

      // Record in actions ledger
      const ledgerEntry = {
        tool: tc.name,
        args: JSON.stringify(tc.input).slice(0, 500),
        outcome: execResult.isError ? 'ERROR' : 'OK',
        ts: Date.now(),
      };
      actionsLedger.push(ledgerEntry);
      session.actionsLedger.push(ledgerEntry);
    }

    // R3 §5: Bounded-exploration valve — check after tool execution batch
    if (!boundedExplorationMessageSent && failedKeys.size >= DESTRO_EXPLORE_LIMIT && !madeProgress) {
      boundedExplorationMessageSent = true;
      appendMessage(session, {
        role: 'user',
        content: `HARNESS: ${DESTRO_EXPLORE_LIMIT} distinct approaches have failed with no progress. Stop exploring — escalate now with a summary of findings and your best hypothesis.`,
      });
    }
    if (failedKeys.size >= (DESTRO_EXPLORE_LIMIT + 3)) {
      // >= 8 distinct failures → force escalate
      finalStatus = 'escalated';
      finalSummary = synthesizeFallbackVerdict(actionsLedger);
      if (onTurn) onTurn(turn, 'escalated');
      break;
    }

    // i. Self-correct after mutation
    if (madeMutation) {
      mutatedThisSession = true; // §16.6: this session owns changes it must prove
      if (onTurn) onTurn(turn, 'verifying');

      // Run verification check
      const verifyCmd = 'npx tsc --noEmit';
      const verification = await runCheck(verifyCmd, absTargetDir);

      if (verification.worse) {
        const recovered = await attemptSelfCorrect(
          verification,
          incidentId,
          absTargetDir,
        );

        // R3 §2a: Record failed attempt when verify shows worse or revert fired
        try {
          const mutationSummary = actionsLedger
            .filter(e => MUTATION_TOOLS.has(e.tool) || e.tool === 'run_command')
            .slice(-3)
            .map(e => `${e.tool}: ${e.args.slice(0, 200)} → ${e.outcome}`)
            .join('; ');
          await recordFailedAttempt({
            service: service || 'unknown',
            failureSignature: failureSignature || userMessage,
            attemptedFix: mutationSummary || 'unknown mutation',
            whyFailed: `Verification worse: ${verification.summary}`,
            ts: Date.now(),
          });
        } catch {
          // best-effort recording
        }

        if (!recovered) {
          selfCorrectAttempts++;
          appendMessage(session, {
            role: 'user',
            content: `⚠️ Verification failed — the fix made things worse (${verification.summary}). Auto-revert was attempted. Please re-diagnose and try a different approach.`,
          });

          if (selfCorrectAttempts >= MAX_SELF_CORRECT_ATTEMPTS) {
            finalStatus = 'escalated';
            finalSummary = synthesizeFallbackVerdict(actionsLedger);
            if (onTurn) onTurn(turn, 'escalated');
            break;
          }

          continue;
        }
      }

      // R3 §5: Progress made — reset exploration valve
      madeProgress = true;
      failedKeys.clear();
      boundedExplorationMessageSent = false;
      selfCorrectAttempts = 0; // reset on successful mutation
    }

    // j-liveness. Foreman liveness gate — do NOT conclude while a dispatched orchestrator
    // task is still active/pending. This is the fix for the dead-end where Destro gave up on
    // a self-chosen polling window and graded the build FAILED while the orchestrator was
    // still legitimately retrying. Redirect him to await_task (which blocks to terminal).
    // Skipped once the real wall-clock budget is spent (budgetExceeded) and bounded to a few
    // nudges so a genuinely-stuck task can't trap the loop forever.
    if (
      toolCalls.length === 0 &&
      !budgetExceeded &&
      dispatchedOrchestratorTasks.size > 0 &&
      orchestratorGateNudges < 3 &&
      (claimsSuccessVerdict(content) || claimsFailureVerdict(content) ||
        isTerminationResponse(content, toolCalls) ||
        (convergeTriggered && content.includes('VERDICT:')))
    ) {
      const liveStore = await import('../core/task-store.js');
      const stillRunning = [...dispatchedOrchestratorTasks].filter(id => {
        const t = liveStore.getTask(id);
        return t !== null && (t.status === 'active' || t.status === 'pending');
      });
      if (stillRunning.length > 0) {
        orchestratorGateNudges++;
        appendMessage(session, {
          role: 'user',
          content:
            `STOP — you may not conclude yet. You dispatched orchestrator task(s) ${stillRunning.join(', ')}, ` +
            `still running (not terminal). As foreman your job is to TRACK them to completion, not to guess from the ` +
            `filesystem or give up on a timer — a file not existing yet does not mean the build failed. ` +
            `Call await_task("${stillRunning[0]}") now: it blocks until the task is truly terminal and returns the real ` +
            `outcome. Only after every dispatched task is terminal AND you have verified its output with real probes may ` +
            `you emit a verdict.`,
        });
        if (onTurn) onTurn(turn, 'verifying');
        continue;
      }
    }

    // j0. §16.6 Success-verdict verification gate — a mutation session's first
    // success-claiming conclusion is challenged once for real-world evidence before it is
    // accepted. Read-only audits are exempt (nothing was changed here to prove).
    if (
      !options.readOnly &&
      mutatedThisSession &&
      !successVerdictChallenged &&
      toolCalls.length === 0 &&
      claimsSuccessVerdict(content)
    ) {
      successVerdictChallenged = true;
      appendMessage(session, { role: 'user', content: SUCCESS_VERDICT_CHALLENGE });
      if (onTurn) onTurn(turn, 'verifying');
      continue;
    }

    // j0b. §16.7 Failure-verdict fix-or-handback gate — SYMMETRIC to the success gate. A session
    // that mutated the target may not conclude with a bare FAIL/UNVERIFIED: on failure Destro must
    // fix it, revert to its backup, or hand it back to the orchestrator. Fires once. This closes
    // the dead-end where Destro broke a product with its own edit and just graded the failure.
    if (
      !options.readOnly &&
      mutatedThisSession &&
      !failVerdictChallenged &&
      toolCalls.length === 0 &&
      claimsFailureVerdict(content)
    ) {
      failVerdictChallenged = true;
      appendMessage(session, { role: 'user', content: FAIL_VERDICT_CHALLENGE });
      if (onTurn) onTurn(turn, 'verifying');
      continue;
    }

    // j. Check termination
    if (isTerminationResponse(content, toolCalls)) {
      // A mutating session that still concludes on failure is an escalation, not a resolution —
      // don't record a product Destro left broken as "resolved".
      finalStatus = (mutatedThisSession && claimsFailureVerdict(content)) ? 'escalated' : 'resolved';
      finalSummary = content.slice(0, 2000);
      if (onTurn) onTurn(turn, finalStatus);
      break;
    }

    // j2. Converge-or-conclude verdict (P06) — exactly one turn after trigger
    if (convergeTriggered) {
      if (content.includes('VERDICT:')) {
        finalStatus = (mutatedThisSession && claimsFailureVerdict(content)) ? 'escalated' : 'resolved';
        finalSummary = content.slice(0, 2000);
      } else {
        finalStatus = 'escalated';
        finalSummary = synthesizeFallbackVerdict(actionsLedger);
      }
      if (onTurn) onTurn(turn, finalStatus);
      break;
    }

    // k. (assistant message already appended at h0, before tool execution)

    // Check if at max turns
    if (turn >= maxTurns - 1) {
      finalStatus = 'max_turns_exceeded';
      finalSummary = synthesizeFallbackVerdict(actionsLedger);
    }
  }

  // ── 6. Record remediation on success ───────
  if (finalStatus === 'resolved') {
    try {
      const entry: RemediationEntry = {
        diagnosis: failureSignature || userMessage,
        fix: finalSummary,
        outcome: 'success',
        ts: Date.now(),
      };
      await recordRemediation(
        service || 'unknown',
        failureSignature || userMessage,
        entry,
      );
    } catch {
      // best-effort recording
    }
  }

  session.status = finalStatus === 'resolved'
    ? 'closed'
    : finalStatus === 'escalated'
      ? 'escalated'
      : 'closed';

  return {
    status: finalStatus,
    summary: finalSummary,
    actionsLedger,
    session,
    error: finalError,
  };
}
