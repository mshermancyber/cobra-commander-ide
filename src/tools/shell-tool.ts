import { spawn } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';
import type { ToolDefinition } from '../core/types.js';
import { truncateShellOutput } from '../core/tool-output-truncation.js';
import { processRegistry } from '../core/process-registry.js';
import { registerWorkerJob } from '../core/worker-jobs.js';

export const shellTool: ToolDefinition = {
  name: 'run_command',
  description: 'Run a shell command in the project directory. Returns stdout+stderr. Timeout: 120s.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: {
        type: 'number',
        description: 'Command timeout in seconds (default: 30, max: 300)',
      },
    },
    required: ['command'],
  },
};

let activeWorkerId: string | null = null;
let shellAllowedDirs: string[] = [];

export function setActiveWorkerId(id: string | null): void {
  activeWorkerId = id;
}

export function setShellAllowedDirs(dirs: string[]): void {
  shellAllowedDirs = dirs;
}

/** Per-call identity for concurrent workers; the module-level setters above are shared by every worker in the process. */
export interface ShellCallContext {
  workerId?: string;
  allowedDirs?: string[];
}

const FILE_READ_CMDS = /\b(cat|head|tail|less|more|bat|sed|awk)\b/;

function checkShellPathBounds(command: string, workDir: string, allowedDirs: string[]): string | null {
  if (allowedDirs.length === 0) return null;
  if (!FILE_READ_CMDS.test(command)) return null;

  const allDirs = [workDir, ...allowedDirs];
  const tokens = command.split(/[\s|;&&]+/);
  for (const token of tokens) {
    if (!token.startsWith('/')) continue;
    const cleaned = token.replace(/['"]/g, '');
    if (!isAbsolute(cleaned)) continue;
    const resolved = resolve(cleaned);
    const inBounds = allDirs.some(dir => {
      const rel = relative(dir, resolved);
      return !rel.startsWith('..') && !isAbsolute(rel);
    });
    if (!inBounds) {
      return `Path "${cleaned}" is outside the allowed directories`;
    }
  }
  return null;
}

const BLOCKED_PATTERNS = [
  /rm\s+-[^\s]*r[^\s]*f[^\s]*\s+\/(?!\w)/,  // rm -rf / (but not rm -rf ./something)
  /mkfs/,
  /dd\s+if=.*of=\/dev/,
  /:(\s*)\(\)\s*\{\s*:|:\s*&\s*\}/,          // fork bomb
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /curl\s.*\|\s*(ba)?sh/,                       // curl | sh
  /wget\s.*\|\s*(ba)?sh/,                       // wget | sh
  />(\s*)\/etc\//,                               // write to /etc
  />(\s*)\/usr\//,                               // write to /usr
  />(\s*)\/bin\//,                               // write to /bin
  />(\s*)\/sbin\//,                              // write to /sbin
];

// --- Permission system ---

export type ShellPermission = 'allow-all' | 'deny-dangerous' | 'ask-all';

let permissionMode: ShellPermission = 'deny-dangerous';

// Async approval handler: returns Promise<boolean> for approve/deny
let approvalHandler: ((command: string, risk: string, reason: string) => Promise<boolean>) | null = null;

// Per-session permission grants (regex patterns)
let permissionGrants: string[] = [];

// Auto-approve flags
let autoApproveRead = false;
let autoApproveWrite = false;
let autoApproveCommandPatterns: RegExp[] = [];

export function setShellPermission(mode: ShellPermission): void {
  permissionMode = mode;
}

export function getShellPermission(): ShellPermission {
  return permissionMode;
}

/**
 * Set the async approval handler for ask-all mode.
 * The handler receives (command, riskLevel, reason) and returns a Promise<boolean>.
 */
export function setApprovalHandler(handler: (command: string, risk: string, reason: string) => Promise<boolean>): void {
  approvalHandler = handler;
}

/**
 * Grant permission for commands matching a regex pattern.
 */
export function grantPermission(pattern: string): void {
  if (!permissionGrants.includes(pattern)) {
    permissionGrants.push(pattern);
  }
}

/**
 * Revoke a previously granted permission pattern.
 */
export function revokePermission(pattern: string): void {
  permissionGrants = permissionGrants.filter(p => p !== pattern);
}

/**
 * List current permission grants.
 */
export function listPermissions(): string[] {
  return [...permissionGrants];
}

/**
 * Set auto-approve for file read operations.
 */
export function setAutoApproveRead(enabled: boolean): void {
  autoApproveRead = enabled;
}

/**
 * Set auto-approve for file write operations.
 */
export function setAutoApproveWrite(enabled: boolean): void {
  autoApproveWrite = enabled;
}

/**
 * Add a command pattern that will be auto-approved.
 */
export function addAutoApproveCommandPattern(pattern: string): void {
  autoApproveCommandPatterns.push(new RegExp(pattern));
}

interface CommandRisk {
  level: 'safe' | 'moderate' | 'dangerous';
  reason: string;
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+-[^\s]*r[^\s]*f[^\s]*/, reason: 'recursive force delete' },
  { pattern: /mkfs/, reason: 'filesystem creation' },
  { pattern: /dd\s+if=.*of=/, reason: 'raw disk write' },
  { pattern: /chmod\s+777/, reason: 'world-writable permissions' },
  { pattern: /git\s+push\s+--force/, reason: 'force push to remote' },
  { pattern: /drop\s+table/i, reason: 'database table drop' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'system shutdown' },
  { pattern: /\bkill\s+-9\b/, reason: 'force kill process' },
  { pattern: /npm\s+publish/, reason: 'package publish' },
  { pattern: /curl\s+.*\|\s*(ba)?sh/, reason: 'remote script execution' },
  { pattern: /\beval\b/, reason: 'arbitrary code execution' },
  { pattern: />\s*\/dev\/(?!null)/, reason: 'write to device' },
];

const MODERATE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /git\s+push/, reason: 'git push' },
  { pattern: /npm\s+install\s+-g/, reason: 'global npm install' },
  { pattern: /docker\s+rm/, reason: 'docker container removal' },
  { pattern: /pip\s+install/, reason: 'pip install' },
  { pattern: /apt\s+install/, reason: 'apt install' },
  { pattern: /systemctl/, reason: 'system service management' },
  { pattern: /export\s+\w+=/, reason: 'environment variable modification' },
  { pattern: /chmod/, reason: 'file permission change' },
  { pattern: /chown/, reason: 'file ownership change' },
  { pattern: /rm\s+-[^\s]*f/, reason: 'force file deletion' },
  { pattern: /git\s+reset/, reason: 'git reset' },
  { pattern: /git\s+rebase/, reason: 'git rebase' },
  { pattern: /git\s+merge/, reason: 'git merge' },
  { pattern: /npm\s+publish/, reason: 'npm publish' },
];

function classifyCommand(command: string): CommandRisk {
  // Check dangerous patterns first
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'dangerous', reason };
    }
  }

  // Check moderate patterns
  for (const { pattern, reason } of MODERATE_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'moderate', reason };
    }
  }

  return { level: 'safe', reason: 'read-only or safe operation' };
}

/**
 * Check if a command matches any auto-approve pattern.
 */
function matchesAutoApprove(command: string): boolean {
  for (const pattern of autoApproveCommandPatterns) {
    if (pattern.test(command)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a command matches any granted permission pattern.
 */
function matchesGrant(command: string): boolean {
  for (const pattern of permissionGrants) {
    try {
      const re = new RegExp(pattern);
      if (re.test(command)) {
        return true;
      }
    } catch {
      // Invalid regex, skip
    }
  }
  return false;
}

/**
 * Execute a shell command. Returns a Promise when in ask-all mode (to allow async approval),
 * or a synchronous result otherwise.
 */
export async function executeShellTool(
  input: Record<string, unknown>, workDir: string, ctx?: ShellCallContext,
): Promise<{ result: string; is_error: boolean }> {
  let command = input.command as string;
  const allowedDirs = ctx?.allowedDirs ?? shellAllowedDirs;
  const jobWorkerId = ctx?.workerId ?? activeWorkerId;
  const timeoutMs = Math.min(((input.timeout as number) || 30) * 1000, 300_000);

  // OPT-008: Automatically add --incremental to npx tsc --noEmit for faster builds
  if (/\bnpx\s+tsc\s+--noEmit\b/.test(command) && !command.includes('--incremental')) {
    command = command.replace(/--noEmit/, '--noEmit --incremental');
  }

  // Always check blocked patterns first (hard block)
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { result: `Blocked: dangerous command pattern detected`, is_error: true };
    }
  }

  // Path boundary enforcement — block file-reading commands accessing paths outside workDir
  const pathViolation = checkShellPathBounds(command, workDir, allowedDirs);
  if (pathViolation) {
    return { result: `Blocked: ${pathViolation}`, is_error: true };
  }

  // Permission check
  const risk = classifyCommand(command);

  // Check auto-approve patterns first
  if (matchesAutoApprove(command) || matchesGrant(command)) {
    // Auto-approved
  } else if (autoApproveRead && risk.level === 'safe') {
    // Auto-approved read
  } else if (autoApproveWrite && (risk.level === 'moderate' || risk.level === 'safe')) {
    // Auto-approved write
  } else if (permissionMode === 'deny-dangerous' && risk.level === 'dangerous') {
    return {
      result: `Blocked by permission system: ${risk.reason}\nCommand: ${command}\nRisk level: ${risk.level}`,
      is_error: true,
    };
  } else if (permissionMode === 'ask-all' && (risk.level === 'moderate' || risk.level === 'dangerous')) {
    if (approvalHandler) {
      const approved = await approvalHandler(command, risk.level, risk.reason);
      if (!approved) {
        return {
          result: `Command rejected by user: ${command}\nRisk level: ${risk.level} (${risk.reason})`,
          is_error: true,
        };
      }
    } else if (risk.level === 'dangerous') {
      return {
        result: `Blocked by permission system: ${risk.reason}\nCommand: ${command}\nRisk level: ${risk.level}\nNo approval handler configured.`,
        is_error: true,
      };
    }
  }

  try {
    const { exitCode, output } = await runWithRegistry(command, workDir, timeoutMs, jobWorkerId);
    if (exitCode === 0) {
      const truncated = truncateShellOutput(output);
      return { result: truncated.text || '(no output)', is_error: false };
    }
    const truncated = truncateShellOutput(output, 2000, 20000);
    return { result: `Exit code ${exitCode}\n${truncated.text}`, is_error: true };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { result: `Error: ${e.message ?? 'unknown'}`, is_error: true };
  }
}

function runWithRegistry(
  command: string, cwd: string, timeoutMs: number, jobWorkerId: string | null,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    processRegistry.registerProcess(process.pid, child.pid!, command);
    if (jobWorkerId) {
      const jobType = command.includes('tsc') ? 'tsc' : command.includes('dv') ? 'dv-scan' : 'shell';
      registerWorkerJob(jobWorkerId, child.pid!, jobType, command);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const maxBuffer = 10 * 1024 * 1024;

    child.stdout?.on('data', (data: Buffer) => {
      if (totalBytes < maxBuffer) { chunks.push(data); totalBytes += data.length; }
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (totalBytes < maxBuffer) { chunks.push(data); totalBytes += data.length; }
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    }, timeoutMs);

    // Use 'exit' not 'close' — 'close' waits for ALL stdio streams to end,
    // which hangs when a backgrounded child (e.g. ng serve &) inherits pipes.
    // 'exit' fires when the shell process itself exits.
    child.on('exit', (code) => {
      clearTimeout(timer);
      processRegistry.unregisterProcess(child.pid!);
      // Give a brief moment for final buffered output to arrive
      setTimeout(() => {
        resolve({ exitCode: code ?? 1, output: Buffer.concat(chunks).toString('utf-8') });
      }, 200);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      processRegistry.unregisterProcess(child.pid!);
      reject(err);
    });
  });
}
