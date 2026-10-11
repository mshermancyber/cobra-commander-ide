// forked from tools/shell-tool.ts @ 2026-07-04 — DOWNSTREAM fork, do not backport to core

import { spawn } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';
import type { ToolDefinition } from '../core/types.js';
import { truncateDestroShellOutput } from './destro-tool-output.js';

let processRegistry: { registerProcess(pid: number, pid_: number, cmd: string): void; unregisterProcess(pid_: number): void } | null = null;
let registerWorkerJob: ((workerId: string, pid: number, jobType: string, cmd: string) => void) | null = null;

try {
  const pr = await import('../core/process-registry.js');
  // Bind: extracting instance methods unbound loses `this` and crashes inside the
  // registry ("Cannot read properties of undefined (reading 'push')").
  processRegistry = {
    registerProcess: pr.processRegistry.registerProcess.bind(pr.processRegistry),
    unregisterProcess: pr.processRegistry.unregisterProcess.bind(pr.processRegistry),
  };
} catch { /* Destro may run without process-registry */ }

try {
  const wj = await import('../core/worker-jobs.js');
  registerWorkerJob = wj.registerWorkerJob;
} catch { /* Destro may run without worker-jobs */ }

export const destroShellTool: ToolDefinition = {
  name: 'run_command',
  description: '[DESTRO — security-critical] Run a shell command in the project directory. Returns stdout+stderr. Timeout: 120s.',
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

export function setDestroActiveWorkerId(id: string | null): void {
  activeWorkerId = id;
}

export function setDestroShellAllowedDirs(dirs: string[]): void {
  shellAllowedDirs = dirs;
}

const FILE_READ_CMDS = /\b(cat|head|tail|less|more|bat|sed|awk)\b/;

function checkShellPathBounds(command: string, workDir: string): string | null {
  if (shellAllowedDirs.length === 0) return null;
  if (!FILE_READ_CMDS.test(command)) return null;

  const allDirs = [workDir, ...shellAllowedDirs];
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

// System-critical paths that Destro must NEVER write to via shell commands.
// These are HOST-WIDE configs — modifying them affects ALL services on the host,
// not just the project Destro is working on. Incident 2026-07-04: Destro added
// "userns-remap" to /etc/docker/daemon.json which would have broken all 16+
// container stacks on the next Docker restart.
const SYSTEM_CRITICAL_PATHS = [
  '/etc/docker/',
  '/etc/systemd/',
  '/etc/nginx/',
  '/etc/ssh/',
  '/etc/fstab',
  '/etc/passwd',
  '/etc/shadow',
  '/etc/group',
  '/etc/sudoers',
  '/etc/hosts',
  '/etc/resolv.conf',
  '/etc/environment',
  '/etc/profile',
  '/etc/security/',
  '/etc/pam.d/',
  '/etc/cron',
  '/etc/default/',
  '/etc/sysctl',
  '/etc/modprobe',
  '/etc/udev/',
  '/etc/iptables/',
  '/etc/nftables',
];

// Patterns that detect writes to system-critical paths via ANY mechanism:
// sudo tee, sudo cp, sudo mv, redirect, sed -i, etc.
const SYSTEM_WRITE_RE = new RegExp(
  '(?:' +
    'sudo\\s+(?:tee|cp|mv|install|ln)\\s+.*' +    // sudo tee/cp/mv/install/ln → path
    '|sudo\\s+.*\\s+>\\s*' +                       // sudo ... > path
    '|tee\\s+.*' +                                  // tee path (even without sudo)
    '|cp\\s+.*' +                                   // cp ... path
    '|mv\\s+.*' +                                   // mv ... path
    '|sed\\s+-i.*' +                                // sed -i on path
    '|install\\s+.*' +                              // install ... path
    '|>\\s*' +                                      // redirect > path
    '|>>\\s*' +                                     // append >> path
  ')' +
  '(?:\\/etc\\/)',                                   // targeting /etc/
);

export function commandTargetsSystemPath(command: string): string | null {
  for (const criticalPath of SYSTEM_CRITICAL_PATHS) {
    if (command.includes(criticalPath)) {
      if (SYSTEM_WRITE_RE.test(command) ||
          /\b(write_file|echo|printf)\b.*\/etc\//.test(command) ||
          /\bcat\s*>.*\/etc\//.test(command)) {
        return criticalPath;
      }
      // Also catch: dockerd config changes, systemctl daemon-reload after edits
      if (/daemon\.json/.test(command) && /\b(tee|cp|mv|write|echo|sed\s+-i)\b/.test(command)) {
        return criticalPath;
      }
    }
  }
  // Catch docker daemon config changes even without /etc/ in the command
  if (/daemon\.json/.test(command) && /\b(sudo|tee|cp|mv|sed\s+-i)\b/.test(command)) {
    return '/etc/docker/daemon.json';
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

export interface CommandRisk {
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
  { pattern: /\bsudo\b/, reason: 'elevated privilege execution' },
  { pattern: /\bsystemctl\s+(daemon-reload|enable|disable|mask)\b/, reason: 'systemd daemon-level change' },
  { pattern: /\bdocker\s+system\b/, reason: 'docker daemon-level operation' },
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

export function classifyCommand(command: string): CommandRisk {
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
export async function executeDestroShell(
  input: Record<string, unknown>, workDir: string,
): Promise<{ result: string; is_error: boolean }> {
  let command = input.command as string;
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

  // System-critical path protection (hard block — no override)
  // These are HOST-WIDE configs. Modifying them affects ALL services, not just
  // the project being worked on. Destro must NEVER write to these paths.
  const systemPath = commandTargetsSystemPath(command);
  if (systemPath) {
    return {
      result: `BLOCKED: command targets system-critical path "${systemPath}". ` +
        `This is a HOST-WIDE configuration — modifying it affects ALL services on this server, ` +
        `not just the project you are working on. ` +
        `Report this as a recommended change for the operator to apply manually. ` +
        `Do NOT attempt to work around this block.`,
      is_error: true,
    };
  }

  // Path boundary enforcement — block file-reading commands accessing paths outside workDir
  const pathViolation = checkShellPathBounds(command, workDir);
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
    const { exitCode, output } = await runWithRegistry(command, workDir, timeoutMs);
    if (exitCode === 0) {
      const truncated = truncateDestroShellOutput(output);
      return { result: truncated.text || '(no output)', is_error: false };
    }
    const truncated = truncateDestroShellOutput(output, 2000, 20000);
    return { result: `Exit code ${exitCode}\n${truncated.text}`, is_error: true };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { result: `Error: ${e.message ?? 'unknown'}`, is_error: true };
  }
}

function runWithRegistry(
  command: string, cwd: string, timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, TERM: 'dumb' },
      // stdin 'ignore' → interactive prompts (e.g. psql asking for a password)
      // get EOF and fail fast instead of hanging forever on an unwritten pipe.
      // detached → child is its own process-group leader so the timeout can
      // reap the WHOLE tree (docker exec → psql grandchildren won't orphan).
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    if (processRegistry) {
      processRegistry.registerProcess(process.pid, child.pid!, command);
    }
    if (activeWorkerId && registerWorkerJob) {
      const jobType = command.includes('tsc') ? 'tsc' : command.includes('dv') ? 'dv-scan' : 'shell';
      registerWorkerJob(activeWorkerId, child.pid!, jobType, command);
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

    // Kill the whole process GROUP (-pid) so grandchildren can't orphan past
    // the timeout; fall back to killing just the child if the group is gone.
    const killTree = (sig: NodeJS.Signals) => {
      try { process.kill(-child.pid!, sig); }
      catch { try { child.kill(sig); } catch {} }
    };
    const timer = setTimeout(() => {
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 2000);
    }, timeoutMs);

    // Use 'exit' not 'close' — 'close' waits for ALL stdio streams to end,
    // which hangs when a backgrounded child (e.g. ng serve &) inherits pipes.
    // 'exit' fires when the shell process itself exits.
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (processRegistry) {
        processRegistry.unregisterProcess(child.pid!);
      }
      // Give a brief moment for final buffered output to arrive
      setTimeout(() => {
        resolve({ exitCode: code ?? 1, output: Buffer.concat(chunks).toString('utf-8') });
      }, 200);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (processRegistry) {
        processRegistry.unregisterProcess(child.pid!);
      }
      reject(err);
    });
  });
}
