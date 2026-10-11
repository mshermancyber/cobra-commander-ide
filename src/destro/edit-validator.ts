// Self-check only — NEVER blocks the agent
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';

export interface ValidateResult {
  valid: boolean;
  diagnostics: string[];
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = spawn('which', [cmd], { stdio: 'pipe', timeout: 2000 });
    return new Promise<boolean>((resolve) => {
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  } catch {
    return Promise.resolve(false);
  }
}

function runWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'pipe', timeout: timeoutMs });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.on('error', (err) => resolve({ stdout, stderr, code: null, ...err }));
  });
}

function isDockerComposeFile(filePath: string): boolean {
  const name = basename(filePath);
  return /^(docker-compose.*\.yml|compose.*\.yml)$/i.test(name);
}

function isJsonFile(filePath: string): boolean {
  return filePath.endsWith('.json');
}

function isSystemdUnit(filePath: string): boolean {
  return filePath.endsWith('.service');
}

function isTypeScriptFile(filePath: string): boolean {
  return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
}

async function validateDockerCompose(filePath: string): Promise<string[]> {
  const diagnostics: string[] = [];
  try {
    const hasDocker = await commandExists('docker');
    if (!hasDocker) return diagnostics;

    const { stdout, stderr, code } = await runWithTimeout(
      'docker',
      ['compose', '-f', filePath, 'config', '-q'],
      10_000,
    );

    if (code !== 0) {
      diagnostics.push(`docker compose config: ${stderr || stdout || 'exit ' + code}`);
    }
  } catch {
    // Self-check only — NEVER blocks the agent
  }
  return diagnostics;
}

function validateJson(filePath: string): string[] {
  const diagnostics: string[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    JSON.parse(content);
  } catch (err) {
    diagnostics.push(`JSON parse: ${(err as Error).message}`);
  }
  return diagnostics;
}

async function validateSystemd(filePath: string): Promise<string[]> {
  const diagnostics: string[] = [];
  try {
    const hasSystemdAnalyze = await commandExists('systemd-analyze');
    if (!hasSystemdAnalyze) return diagnostics;

    const { stdout, stderr, code } = await runWithTimeout(
      'systemd-analyze',
      ['verify', '--user', filePath],
      10_000,
    );

    if (code !== 0) {
      const output = (stderr || stdout).trim();
      if (output) diagnostics.push(`systemd-analyze: ${output}`);
    }
  } catch {
    // Self-check only — NEVER blocks the agent
  }
  return diagnostics;
}

async function validateTypeScript(
  filePath: string,
  projectRoot?: string,
): Promise<string[]> {
  const diagnostics: string[] = [];
  if (!projectRoot) return diagnostics;

  try {
    const { stdout, stderr, code } = await runWithTimeout(
      'npx',
      ['tsc', '--noEmit', '--project', projectRoot],
      5000,
    );

    if (code !== 0) {
      const output = (stderr || stdout).trim();
      if (output) {
        // Only capture lines that reference this file
        const lines = output.split('\n').filter((l) => l.includes(filePath));
        if (lines.length > 0) {
          diagnostics.push(...lines.slice(0, 10)); // Cap at 10 diagnostics
        }
      }
    }
  } catch {
    // Self-check only — NEVER blocks the agent
  }
  return diagnostics;
}

/**
 * Self-check only — NEVER blocks the agent.
 *
 * Post-write validation by file type. Runs best-effort checks and returns
 * diagnostics as informational warnings. The caller always proceeds regardless
 * of the result.
 */
export async function validateEdit(
  filePath: string,
  projectRoot?: string,
): Promise<ValidateResult> {
  const diagnostics: string[] = [];

  try {
    if (isDockerComposeFile(filePath)) {
      diagnostics.push(...(await validateDockerCompose(filePath)));
    } else if (isJsonFile(filePath)) {
      diagnostics.push(...validateJson(filePath));
    } else if (isSystemdUnit(filePath)) {
      diagnostics.push(...(await validateSystemd(filePath)));
    } else if (isTypeScriptFile(filePath)) {
      diagnostics.push(...(await validateTypeScript(filePath, projectRoot)));
    }
    // Otherwise → no validation, empty diagnostics
  } catch {
    // Self-check only — NEVER blocks the agent
  }

  return { valid: true, diagnostics };
}
