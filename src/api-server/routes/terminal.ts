import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';

const nodeBinDir = dirname(process.execPath);

const MAX_TIMEOUT = 120000;
const DEFAULT_TIMEOUT = 30000;

// Allowed commands and their argument validation
const ALLOWED_COMMANDS = new Set([
  'git', 'npm', 'npx', 'node', 'tsc', 'eslint', 'prettier',
  'cat', 'ls', 'find', 'grep', 'wc', 'head', 'tail', 'echo',
  'mkdir', 'cp', 'mv', 'rm', 'touch', 'chmod',
  'pwd', 'which', 'date', 'whoami',
]);

// npx must not fetch+run arbitrary packages; only these build/lint tools.
const NPX_ALLOWED_PACKAGES = new Set([
  'tsc', 'typescript', 'tsx', 'eslint', 'prettier', 'vite', 'vitest', 'jest',
  'esbuild', 'rollup', 'webpack', 'next', 'astro', 'tailwindcss', 'postcss', 'svelte-kit',
]);
// node must not evaluate inline code.
const NODE_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
// Commands whose path arguments must stay inside the project.
const PATH_COMMANDS = new Set(['cat', 'ls', 'find', 'grep', 'wc', 'head', 'tail', 'mkdir', 'cp', 'mv', 'rm', 'touch', 'chmod', 'node']);

/** True if arg is a path that escapes workDir (absolute-outside or ../ traversal). */
function argEscapesWorkDir(workDir: string, cwd: string, arg: string): boolean {
  if (arg.startsWith('-')) return false; // a flag, not a path
  if (!isAbsolute(arg) && !arg.includes('/') && !arg.includes('..')) return false; // bare word (pattern/name/mode)
  const abs = resolve(cwd, arg);
  const rel = relative(resolve(workDir), abs);
  return rel === '..' || rel.startsWith(`..${'/'}`) || isAbsolute(rel);
}

function validateCommand(command: string): { cmd: string; args: string[] } | null {
  // Split the command into parts respecting quotes
  const parts: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (const char of command) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === ' ') {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);

  if (parts.length === 0) return null;

  const cmd = parts[0];
  if (!ALLOWED_COMMANDS.has(cmd)) return null;

  const args = parts.slice(1);
  // Reject any args containing shell metacharacters
  for (const arg of args) {
    if (/[;&|`$(){}<>]/.test(arg)) return null;
  }

  return { cmd, args };
}

export function createTerminalRoutes(workDir: string) {
  async function exec(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 256 * 1024; // 256 KB is ample for a command payload
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) { sendError(res, 413, 'Request body too large'); return; }
      chunks.push(chunk as Buffer);
    }
    let body: { command?: string; cwd?: string; timeout?: number };
    try { body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { sendError(res, 400, 'Invalid JSON body'); return; }

    if (!body.command) { sendError(res, 400, 'Missing command field'); return; }

    const cwd = body.cwd ? resolve(workDir, body.cwd) : workDir;
    // Confine cwd to workDir (trailing-separator check avoids /data/foo matching /data/foo-secrets).
    const relCwd = relative(resolve(workDir), cwd);
    if (relCwd.startsWith('..') || isAbsolute(relCwd)) { sendError(res, 403, 'Path traversal blocked'); return; }

    const timeout = Math.min(body.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const start = Date.now();

    const validated = validateCommand(body.command);
    if (!validated) {
      sendError(res, 403, 'Command not allowed or contains unsafe characters');
      return;
    }

    // Harden the RCE-prone commands without breaking builds.
    if (validated.cmd === 'node') {
      if (validated.args.some(a => NODE_EVAL_FLAGS.has(a))) {
        sendError(res, 403, 'node inline eval (-e/-p) is not allowed'); return;
      }
    }
    if (validated.cmd === 'npx') {
      const pkg = validated.args.find(a => !a.startsWith('-'));
      const base = pkg ? pkg.replace(/@[^/]*$/, '').split('/').pop() || pkg : '';
      if (!base || !NPX_ALLOWED_PACKAGES.has(base)) {
        sendError(res, 403, `npx package "${pkg ?? ''}" is not allowed (build/lint tools only)`); return;
      }
    }
    if (PATH_COMMANDS.has(validated.cmd)) {
      const bad = validated.args.find(a => argEscapesWorkDir(workDir, cwd, a));
      if (bad) { sendError(res, 403, `path "${bad}" is outside the project`); return; }
    }

    try {
      const output = execFileSync(validated.cmd, validated.args, {
        cwd,
        encoding: 'utf-8',
        timeout,
        env: { ...process.env, PATH: `${nodeBinDir}:${process.env.PATH}` },
        maxBuffer: 1024 * 1024,
      });
      sendJson(res, 200, { output, exitCode: 0, duration: Date.now() - start });
    } catch (err: any) {
      sendJson(res, 200, {
        output: (err.stdout || '') + (err.stderr || ''),
        exitCode: err.status || 1,
        duration: Date.now() - start,
      });
    }
  }

  return { exec };
}
