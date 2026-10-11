import { spawn } from 'node:child_process';
import type { AuthProvider, AuthResult } from './index.js';
import { loadRemoteConfig } from '../remote-config.js';

// ---------------------------------------------------------------------------
// PAM Auth Provider
// Authenticates against the local Linux PAM stack.
// Uses pamtester first, falls back to su -c true.
// ---------------------------------------------------------------------------

function spawnWithPassword(
  cmd: string,
  args: string[],
  password: string,
  timeoutMs: number,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: timeoutMs,
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', () => {
      resolve({ code: null, stderr });
    });

    child.on('close', (code) => {
      resolve({ code, stderr });
    });

    child.stdin?.write(password + '\n');
    child.stdin?.end();
  });
}

async function tryPamtester(
  service: string,
  username: string,
  password: string,
): Promise<boolean> {
  try {
    const { code } = await spawnWithPassword(
      'pamtester',
      [service, username, 'authenticate'],
      password,
      5000,
    );
    return code === 0;
  } catch {
    return false;
  }
}

async function trySu(username: string, password: string): Promise<boolean> {
  try {
    const { code } = await spawnWithPassword(
      'su',
      ['-c', 'true', username],
      password,
      5000,
    );
    return code === 0;
  } catch {
    return false;
  }
}

export class PamAuthProvider implements AuthProvider {
  readonly name = 'pam';
  private readonly service: string;

  constructor(service?: string) {
    this.service = service || loadRemoteConfig().pamService || 'login';
  }

  async authenticate(username: string, password: string): Promise<AuthResult> {
    // Basic sanitization
    if (!username || username.length > 64 || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(username)) {
      return { success: false, error: 'Invalid username format' };
    }

    if (!password || password.length === 0) {
      return { success: false, error: 'Empty password' };
    }

    // Try pamtester first
    const pamtesterOk = await tryPamtester(this.service, username, password);
    if (pamtesterOk) {
      return { success: true, user: username, metadata: { method: 'pamtester' } };
    }

    // Fall back to su
    const suOk = await trySu(username, password);
    if (suOk) {
      return { success: true, user: username, metadata: { method: 'su' } };
    }

    return { success: false, error: 'Authentication failed' };
  }

  async listUsers(): Promise<string[]> {
    // PAM doesn't provide user enumeration — this is intentional
    return [];
  }
}
