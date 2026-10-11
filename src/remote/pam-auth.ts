import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// PAM authentication — verify local Linux user credentials
// ---------------------------------------------------------------------------
// Strategy: try pamtester first (most reliable), fall back to su -c true.
// Both require the calling process to have sufficient privileges (root or
// membership in shadow/wheel groups).
// ---------------------------------------------------------------------------

interface PamResult {
  success: boolean;
  method: 'pamtester' | 'su' | 'none';
  error?: string;
}

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

    // Write password + newline to stdin
    child.stdin?.write(password + '\n');
    child.stdin?.end();
  });
}

/**
 * Try password-based authentication via pamtester.
 * pamtester is a small helper that speaks PAM directly:
 *   echo "$PASS" | pamtester login <user> authenticate
 * Exit code 0 = success.
 */
async function tryPamtester(username: string, password: string): Promise<boolean> {
  try {
    const { code } = await spawnWithPassword(
      'pamtester',
      ['login', username, 'authenticate'],
      password,
      5000,
    );
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Fallback: use su -c true to verify the password.
 *   su -c true <username>  →  feed password via stdin
 * Exit code 0 = password accepted.
 */
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

/**
 * Authenticate a local Linux user via PAM.
 * Returns true if the password is valid for the given username.
 *
 * NEVER logs or stores the password. The password is only passed to the
 * child process stdin and is immediately garbage-collected.
 */
export async function authenticatePAM(
  username: string,
  password: string,
): Promise<PamResult> {
  // Basic sanitization — reject obviously invalid usernames
  if (!username || username.length > 64 || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(username)) {
    return { success: false, method: 'none', error: 'Invalid username format' };
  }

  if (!password || password.length === 0) {
    return { success: false, method: 'none', error: 'Empty password' };
  }

  // Try pamtester first
  const pamtesterOk = await tryPamtester(username, password);
  if (pamtesterOk) {
    return { success: true, method: 'pamtester' };
  }

  // Fall back to su
  const suOk = await trySu(username, password);
  if (suOk) {
    return { success: true, method: 'su' };
  }

  return { success: false, method: 'none', error: 'Authentication failed' };
}
