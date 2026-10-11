import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from './file-lock.js';

const SHADOW_DIR = '.worker-store/shadow.git';
const STORE_DIR = '.worker-store';

/**
 * Run git gc on the shadow repo. Uses --auto so it only does work when
 * there are enough loose objects to justify it (Git's own heuristic).
 * This prevents unbounded growth of the shadow repo over many snapshots.
 */
function gcShadowRepo(): void {
  if (!existsSync(join(SHADOW_DIR, 'HEAD'))) return;
  execSync(`git --git-dir=${SHADOW_DIR} gc --auto --quiet`, {
    stdio: 'pipe',
  });
}

/**
 * Initialize the shadow git repo if it doesn't exist yet.
 * The repo lives at .worker-store/shadow.git and tracks the work tree root.
 */
function ensureShadowRepo(): void {
  if (existsSync(join(SHADOW_DIR, 'HEAD'))) return;
  execSync(`mkdir -p "${STORE_DIR}" && git init --bare "${SHADOW_DIR}"`, {
    stdio: 'pipe',
  });
}

/**
 * Create a snapshot of the current work tree in the shadow repo.
 * Returns the commit hash of the new snapshot.
 */
export async function createShadowSnapshot(workerId: string): Promise<string> {
  ensureShadowRepo();
  return withFileLock(join(STORE_DIR, 'shadow'), async () => {
    const gitDir = `--git-dir=${SHADOW_DIR}`;
    const workTree = '--work-tree=.';

    execSync(`git ${gitDir} ${workTree} add -A`, { stdio: 'pipe' });

    // Allow empty commits so we always have a snapshot even if nothing changed
    const commitMsg = `snapshot:${workerId}:${Date.now()}`;
    const hash = execSync(
      `git ${gitDir} ${workTree} commit --allow-empty -m "${commitMsg}"`,
      { encoding: 'utf-8', stdio: 'pipe' },
    ).trim();

    // Run GC after snapshot to prevent unbounded loose object growth
    gcShadowRepo();

    // Extract the commit hash from output like "[master abc123f] msg"
    const match = hash.match(/.*?\]\s+(\S+)/);
    if (match) return match[1];

    // Fallback: ask git for the latest commit
    return execSync(`git ${gitDir} log -1 --format=%H`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  });
}

/**
 * Rollback the work tree to a specific shadow snapshot commit.
 * This checks out all files from that commit into the work tree.
 */
export async function rollbackShadowSnapshot(
  workerId: string,
  hash: string,
): Promise<void> {
  ensureShadowRepo();
  return withFileLock(join(STORE_DIR, 'shadow'), async () => {
    const gitDir = `--git-dir=${SHADOW_DIR}`;
    const workTree = '--work-tree=.';

    execSync(`git ${gitDir} ${workTree} checkout ${hash} -- .`, {
      stdio: 'pipe',
    });
  });
}

/**
 * List all shadow snapshots (commits), newest first.
 * Returns an array of { hash, message, date } objects.
 */
export async function listShadowSnapshots(
  workerId: string,
): Promise<Array<{ hash: string; message: string; date: string }>> {
  ensureShadowRepo();
  const gitDir = `--git-dir=${SHADOW_DIR}`;

  try {
    const output = execSync(
      `git ${gitDir} log --format="%H|%s|%ai"`,
      { encoding: 'utf-8', stdio: 'pipe' },
    ).trim();

    if (!output) return [];

    return output.split('\n').map((line) => {
      const [hash, message, date] = line.split('|');
      return { hash, message, date };
    });
  } catch {
    return [];
  }
}
