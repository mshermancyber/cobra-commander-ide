import { execSync } from 'node:child_process';

export function createWorkerWorktree(workerId: string, workDir: string): string {
  const worktreePath = `/tmp/cc-worktree-${workerId}`;
  const branchName = `cc-worker-${workerId}`;

  try {
    execSync('git rev-parse --git-dir', { cwd: workDir, stdio: 'pipe' });
  } catch {
    throw new Error(`Not a git repository: ${workDir}`);
  }

  try {
    execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
      cwd: workDir,
      stdio: 'pipe',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create worktree: ${msg}`);
  }

  return worktreePath;
}

export function mergeWorktree(worktreePath: string, targetBranch?: string): void {
  const mainDir = execSync('git rev-parse --git-common-dir', {
    cwd: worktreePath,
    encoding: 'utf-8',
  }).trim();

  const workDir = mainDir.endsWith('/.git') ? mainDir.slice(0, -5) : mainDir;

  const branchOutput = execSync('git branch --show-current', {
    cwd: worktreePath,
    encoding: 'utf-8',
  }).trim();

  // Commit the worker's working-tree changes in the worktree. Without this the
  // branch has no commits and `git merge` is a no-op that silently discards
  // everything the worker did.
  execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' });
  let hasStaged = false;
  try {
    execSync('git diff --cached --quiet', { cwd: worktreePath, stdio: 'pipe' });
  } catch {
    hasStaged = true; // non-zero exit means there are staged changes
  }
  if (hasStaged) {
    execSync('git commit -m "cc: worker changes" --no-verify', { cwd: worktreePath, stdio: 'pipe' });
  }

  // Merge into the repo's actual current branch, not a hard-coded 'main'.
  const target = targetBranch
    ?? (execSync('git branch --show-current', { cwd: workDir, encoding: 'utf-8' }).trim() || 'main');

  execSync(`git checkout "${target}"`, { cwd: workDir, stdio: 'pipe' });
  execSync(`git merge --no-ff "${branchOutput}"`, { cwd: workDir, stdio: 'pipe' });
}

export function cleanupWorktree(worktreePath: string): void {
  let branchName: string;
  try {
    branchName = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim();
  } catch {
    branchName = '';
  }

  const mainDir = execSync('git rev-parse --git-common-dir', {
    cwd: worktreePath,
    encoding: 'utf-8',
  }).trim();

  const workDir = mainDir.endsWith('/.git') ? mainDir.slice(0, -5) : mainDir;

  execSync(`git worktree remove "${worktreePath}"`, { cwd: workDir, stdio: 'pipe' });

  if (branchName) {
    try {
      execSync(`git branch -d "${branchName}"`, { cwd: workDir, stdio: 'pipe' });
    } catch {
      // Branch may not exist or may not be fully merged — ignore
    }
  }
}

export function listWorktrees(workDir: string): Array<{ path: string; branch: string; workerId?: string }> {
  try {
    execSync('git rev-parse --git-dir', { cwd: workDir, stdio: 'pipe' });
  } catch {
    return [];
  }

  let output: string;
  try {
    output = execSync('git worktree list --porcelain', { cwd: workDir, encoding: 'utf-8' });
  } catch {
    return [];
  }

  const results: Array<{ path: string; branch: string; workerId?: string }> = [];
  const entries = output.split('\n\n').filter(Boolean);

  for (const entry of entries) {
    const lines = entry.trim().split('\n');
    let path = '';
    let branch = '';

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).replace('refs/heads/', '');
      }
    }

    if (path) {
      const workerMatch = branch.match(/^cc-worker-(.+)$/);
      results.push({
        path,
        branch,
        ...(workerMatch ? { workerId: workerMatch[1] } : {}),
      });
    }
  }

  return results;
}
