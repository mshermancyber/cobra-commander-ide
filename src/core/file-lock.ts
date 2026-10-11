import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_RETRIES = 50;
const RETRY_DELAY_MS = 100;
const STALE_LOCK_MS = 120_000; // reclaim a lock whose holder is dead or older than this

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A lock is stale if its owner process is gone or it has been held too long. */
function isStaleLock(lockDir: string): boolean {
  try {
    const [pidStr, tsStr] = readFileSync(join(lockDir, 'owner'), 'utf-8').split('\n');
    const pid = Number(pidStr);
    const ts = Number(tsStr);
    if (Number.isFinite(ts) && ts > 0 && Date.now() - ts > STALE_LOCK_MS) return true;
    if (Number.isFinite(pid) && pid > 0 && !isPidAlive(pid)) return true;
    return false;
  } catch {
    return true; // unreadable/missing owner file → assume stale and reclaim
  }
}

function acquireLock(lockDir: string): boolean {
  try {
    mkdirSync(lockDir, { recursive: false });
    const ownerFile = join(lockDir, 'owner');
    writeFileSync(ownerFile, `${process.pid}\n${Date.now()}`);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
      // Reclaim a crashed/stale holder instead of deadlocking forever.
      if (isStaleLock(lockDir)) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
          mkdirSync(lockDir, { recursive: false });
          writeFileSync(join(lockDir, 'owner'), `${process.pid}\n${Date.now()}`);
          return true;
        } catch { return false; } // another process won the reclaim race
      }
      return false;
    }
    throw err;
  }
}

function releaseLock(lockDir: string): void {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = `${path}.lock`;
  // The lock dir sits beside the target, so a first write into a new directory needs its parent to exist.
  mkdirSync(dirname(lockDir), { recursive: true });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (acquireLock(lockDir)) {
      try {
        return await fn();
      } finally {
        releaseLock(lockDir);
      }
    }
    await sleep(RETRY_DELAY_MS);
  }

  throw new Error(`Failed to acquire file lock for ${path} after ${MAX_RETRIES * RETRY_DELAY_MS}ms`);
}
