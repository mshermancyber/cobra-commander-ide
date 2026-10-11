import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function createWorkerSnapshot(workerId: string, workDir: string): string {
  const snapshotId = randomUUID().slice(0, 8);
  const message = `cc-snapshot:${workerId}:${snapshotId}`;

  try {
    execSync('git rev-parse --git-dir', { cwd: workDir, stdio: 'pipe' });
  } catch {
    throw new Error(`Not a git repository: ${workDir}`);
  }

  try {
    execSync(`git stash push -m "${message}"`, { cwd: workDir, stdio: 'pipe' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create snapshot: ${msg}`);
  }

  return snapshotId;
}

export function rollbackWorkerSnapshot(snapshotId: string, workDir: string): void {
  const stashIndex = findStashIndex(snapshotId, workDir);
  if (stashIndex === -1) {
    throw new Error(`Snapshot not found: ${snapshotId}`);
  }

  execSync(`git stash pop stash@{${stashIndex}}`, { cwd: workDir, stdio: 'pipe' });
}

export function cleanupSnapshot(snapshotId: string, workDir?: string): void {
  const cwd = workDir ?? process.cwd();
  const stashIndex = findStashIndex(snapshotId, cwd);
  if (stashIndex === -1) return;

  execSync(`git stash drop stash@{${stashIndex}}`, { cwd, stdio: 'pipe' });
}

export function listSnapshots(workDir: string): Array<{ id: string; workerId: string; createdAt: string }> {
  try {
    execSync('git rev-parse --git-dir', { cwd: workDir, stdio: 'pipe' });
  } catch {
    return [];
  }

  let output: string;
  try {
    output = execSync('git stash list', { cwd: workDir, encoding: 'utf-8' });
  } catch {
    return [];
  }

  const results: Array<{ id: string; workerId: string; createdAt: string }> = [];
  const lines = output.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    const match = line.match(/cc-snapshot:([^:]+):([^:}\s]+)/);
    if (match) {
      results.push({
        id: match[2],
        workerId: match[1],
        createdAt: new Date().toISOString(),
      });
    }
  }

  return results;
}

function findStashIndex(snapshotId: string, workDir: string): number {
  let output: string;
  try {
    output = execSync('git stash list', { cwd: workDir, encoding: 'utf-8' });
  } catch {
    return -1;
  }

  const lines = output.trim().split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(snapshotId)) return i;
  }
  return -1;
}
