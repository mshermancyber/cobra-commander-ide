import { execSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function ensureGitRepo(workDir: string): void {
  try {
    execSync('git rev-parse --git-dir', { cwd: workDir, stdio: 'pipe' });
  } catch {
    execSync('git init && git add -A && git commit -m "initial" --allow-empty', {
      cwd: workDir, stdio: 'pipe',
    });
  }
}

export function snapshot(workDir: string): string | null {
  ensureGitRepo(workDir);
  try {
    return execSync('git rev-parse HEAD', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

export function diffSince(workDir: string, ref: string | null): string | null {
  if (!ref) return null;
  try {
    // Include both tracked changes and new untracked files
    const tracked = execFileSync('git', ['diff', ref, '--', '.'], {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 5 * 1024 * 1024,
    }).toString().trim();

    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();

    const parts: string[] = [];
    if (tracked) parts.push(tracked);
    if (untracked) parts.push('## New untracked files:\n' + untracked);

    const result = parts.join('\n\n');
    if (result.length > 30_000) {
      return result.slice(0, 15_000) + '\n\n... [diff truncated] ...\n\n' + result.slice(-15_000);
    }
    return result || null;
  } catch {
    return null;
  }
}

export function getChangedFiles(workDir: string, ref: string | null): string[] {
  if (!ref) return [];
  try {
    const output = execFileSync('git', ['diff', '--name-only', ref, '--', '.'], {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).toString().trim();
    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    const files = [...output.split('\n'), ...untracked.split('\n')].filter(Boolean);
    return [...new Set(files)];
  } catch {
    return [];
  }
}

export function autoCommit(workDir: string, message: string): string | null {
  try {
    execSync('git add -A', { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', message], {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    });
    return execSync('git rev-parse HEAD', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

export function rollbackTo(workDir: string, ref: string): { restored: boolean; filesReverted: string[] } {
  try {
    // Get list of files that will be reverted before doing it
    const filesBefore = execFileSync('git', ['diff', '--name-only', ref, '--', '.'], {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).toString().trim().split('\n').filter(Boolean);

    // Restore all files to the state at that ref
    execFileSync('git', ['checkout', ref, '--', '.'], {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    });

    // Remove any new untracked files the worker created
    execSync('git clean -fd', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    });

    return { restored: true, filesReverted: filesBefore };
  } catch {
    return { restored: false, filesReverted: [] };
  }
}

export function createCheckpoint(workDir: string, name: string): string | null {
  try {
    // Stage all changes
    execSync('git add -A', { cwd: workDir, stdio: 'pipe' });
    // Create a commit as checkpoint
    execFileSync('git', ['commit', '--allow-empty', '-m', `checkpoint: ${name}`], {
      cwd: workDir, stdio: 'pipe',
    });
    return execSync('git rev-parse HEAD', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

export function listCheckpoints(workDir: string): Array<{ name: string; hash: string; date: string }> {
  try {
    const log = execSync('git log --oneline --grep="checkpoint:" --format="%h|%s|%ci" -20', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    if (!log) return [];
    return log.split('\n').map(line => {
      const [hash, subject, date] = line.split('|');
      const name = (subject || '').replace('checkpoint: ', '');
      return { name, hash, date: date || '' };
    }).filter(c => c.name);
  } catch {
    return [];
  }
}

export function restoreCheckpoint(workDir: string, hashOrName: string): boolean {
  try {
    // Validate input: only allow git object references (alphanumeric, dots, dashes, underscores, slashes)
    if (!/^[a-zA-Z0-9.\-_/]+$/.test(hashOrName)) {
      return false;
    }

    // Try as hash first
    try {
      execFileSync('git', ['rev-parse', '--verify', hashOrName], { cwd: workDir, stdio: 'pipe' });
      execFileSync('git', ['checkout', hashOrName, '--', '.'], { cwd: workDir, stdio: 'pipe' });
      return true;
    } catch { /* not a valid ref */ }

    // Try as checkpoint name
    const checkpoints = listCheckpoints(workDir);
    const found = checkpoints.find(c => c.name === hashOrName);
    if (found) {
      execFileSync('git', ['checkout', found.hash, '--', '.'], { cwd: workDir, stdio: 'pipe' });
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function getRecentSnapshots(workDir: string, count: number): Array<{ref: string; message: string; date: string}> {
  // Validate count is a safe positive integer to prevent command injection
  const safeCount = Math.min(Math.max(1, Math.floor(Number(count)) || 1), 1000);
  try {
    const output = execFileSync('git', ['log', '--oneline', `-${safeCount}`, '--format=%H|%s|%ai'], {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).toString().trim();

    if (!output) return [];

    return output.split('\n').map(line => {
      const parts = line.split('|');
      return {
        ref: parts[0] || '',
        message: parts[1] || '',
        date: parts[2] || '',
      };
    });
  } catch {
    return [];
  }
}

// --- Feature 2: Git Integration Depth ---

/**
 * Check if the working directory has uncommitted changes.
 */
export function isDirtyRepo(workDir: string): boolean {
  try {
    const output = execSync('git status --porcelain', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Create a feature branch from the current state.
 * The branch name is derived from the task description (slugified, max 50 chars).
 * Returns the branch name, or null if creation failed.
 */
export function createFeatureBranch(workDir: string, taskDescription: string): string | null {
  try {
    // Slugify the task description to create a branch name
    const slug = taskDescription
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);

    const branchName = `feat/${slug || 'task'}-${Date.now().toString(36)}`;

    // Check if we're already on a feature branch (not main/master)
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();

    if (currentBranch !== 'main' && currentBranch !== 'master') {
      // Already on a feature branch — stash changes and create new branch from current
      execSync('git stash', { cwd: workDir, stdio: 'pipe' });
      execFileSync('git', ['checkout', '-b', branchName], {
        cwd: workDir, stdio: 'pipe',
      });
      execSync('git stash pop', { cwd: workDir, stdio: 'pipe' });
    } else {
      // On main/master — create feature branch
      execFileSync('git', ['checkout', '-b', branchName], {
        cwd: workDir, stdio: 'pipe',
      });
    }

    return branchName;
  } catch {
    return null;
  }
}

/**
 * Get a human-readable summary of changes since a git ref.
 * Returns files changed, lines added/removed, and key patterns.
 */
export function getChangeSummary(workDir: string, ref?: string): string {
  try {
    const parts: string[] = [];

    // Get shortstat — use execFileSync to avoid shell injection
    let shortstat = '';
    if (ref) {
      // Validate ref to prevent injection: only allow git object references
      if (/^[a-zA-Z0-9.\-_/]+$/.test(ref)) {
        try {
          shortstat = execFileSync('git', ['diff', '--shortstat', ref, '--', '.'], {
            cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
          }).trim();
        } catch { /* ignore */ }
      }
    } else {
      try {
        const diff1 = execFileSync('git', ['diff', '--shortstat'], {
          cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
        }).trim();
        const diff2 = execFileSync('git', ['diff', '--cached', '--shortstat'], {
          cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
        }).trim();
        shortstat = [diff1, diff2].filter(Boolean).join(', ');
      } catch { /* ignore */ }
    }

    if (shortstat) {
      parts.push(`Changes: ${shortstat.replace(/\n/g, ', ')}`);
    }

    // Get file names — use execFileSync to avoid shell injection
    let files: string[] = [];
    if (ref) {
      if (/^[a-zA-Z0-9.\-_/]+$/.test(ref)) {
        try {
          const output = execFileSync('git', ['diff', '--name-only', ref, '--', '.'], {
            cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
          }).toString().trim();
          files = output.split('\n').filter(Boolean);
        } catch { /* ignore */ }
      }
    } else {
      try {
        const diff1 = execFileSync('git', ['diff', '--name-only'], {
          cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
        }).trim();
        const diff2 = execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
        }).trim();
        files = [...diff1.split('\n'), ...diff2.split('\n')].filter(Boolean);
      } catch { /* ignore */ }
    }

    files = [...new Set(files)];

    if (files.length > 0) {
      parts.push(`Files (${files.length}): ${files.join(', ')}`);
    }

    // Detect key patterns from file names
    const newFiles = files.filter(f => {
      try {
        // Use execFileSync with arguments array to avoid shell injection
        const diffArgs = ref
          ? ['diff', '--diff-filter=A', '--name-only', ref, '--', '.']
          : ['diff', '--diff-filter=A', '--name-only', 'HEAD', '--', '.'];
        const diffOutput = execFileSync('git', diffArgs, {
          cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
        }).toString();
        return diffOutput.split('\n').some(line => line.trim() === f);
      } catch { return false; }
    });

    if (newFiles.length > 0) {
      parts.push(`New files: ${newFiles.join(', ')}`);
    }

    return parts.join('\n');
  } catch {
    return 'Could not generate change summary.';
  }
}

// ──────────────────────────────────────────────
// GAP-106: Automatic branch per task
// ──────────────────────────────────────────────

export interface BranchConfig {
  prefix: string;
  maxLength: number;
  includeTimestamp: boolean;
  baseBranch: string;
  autoStash: boolean;
}

export interface TaskBranch {
  name: string;
  taskName: string;
  baseBranch: string;
  createdAt: number;
  commitCount: number;
}

const DEFAULT_BRANCH_CONFIG: BranchConfig = {
  prefix: 'task',
  maxLength: 80,
  includeTimestamp: true,
  baseBranch: 'main',
  autoStash: true,
};

/**
 * GAP-106: Create a feature branch for a task.
 * Branch name is derived from the task name (slugified).
 */
export function createTaskBranch(
  workDir: string,
  taskName: string,
  config?: Partial<BranchConfig>,
): TaskBranch | null {
  const cfg = { ...DEFAULT_BRANCH_CONFIG, ...config };

  try {
    // Slugify the task name
    const slug = taskName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);

    const suffix = cfg.includeTimestamp ? `-${Date.now().toString(36)}` : '';
    const branchName = `${cfg.prefix}/${slug || 'task'}${suffix}`.slice(0, cfg.maxLength);

    // Check current branch
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();

    // Auto-stash if enabled
    if (cfg.autoStash) {
      try {
        execSync('git stash push -m "cobra: auto-stash before task branch"', {
          cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { /* no changes to stash */ }
    }

    // If not on base branch and not already on a feature branch
    if (currentBranch !== cfg.baseBranch &&
        currentBranch !== 'main' && currentBranch !== 'master') {
      // Create from current state
      execFileSync('git', ['checkout', '-b', branchName], {
        cwd: workDir, stdio: 'pipe',
      });
    } else {
      // Create from base branch
      execFileSync('git', ['checkout', '-b', branchName], {
        cwd: workDir, stdio: 'pipe',
      });
    }

    // Pop stash if applicable
    if (cfg.autoStash) {
      try {
        execSync('git stash pop', {
          cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { /* no stash */ }
    }

    return {
      name: branchName,
      taskName,
      baseBranch: cfg.baseBranch,
      createdAt: Date.now(),
      commitCount: 0,
    };
  } catch {
    return null;
  }
}

// --- GAP-106: Automatic branch per task ---

/**
 * Task branch management state.
 */
interface TaskBranchState {
  currentBranch: string | null;
  baseBranch: string;
  taskBranches: Map<string, string>; // taskId → branchName
}

let taskBranchState: TaskBranchState = {
  currentBranch: null,
  baseBranch: 'main',
  taskBranches: new Map(),
};

/**
 * Automatically create a feature branch for a given task before starting work.
 * The branch name is derived from the task description.
 * If already on a task branch for this task, returns the existing branch name.
 * If no git repo exists, returns null gracefully.
 *
 * @param workDir - Working directory
 * @param taskDescription - Task description used to derive branch name
 * @param taskId - Optional unique task ID for tracking
 * @returns Branch name or null if creation failed
 */
export function autoBranchForTask(
  workDir: string,
  taskDescription: string,
  taskId?: string,
): string | null {
  try {
    // Check if git repo exists
    execSync('git rev-parse --git-dir', { cwd: workDir, stdio: 'pipe' });
  } catch {
    return null; // No git repo, skip branching
  }

  // If taskId provided and we already have a branch for it, return it
  if (taskId && taskBranchState.taskBranches.has(taskId)) {
    return taskBranchState.taskBranches.get(taskId)!;
  }

  // Determine base branch
  try {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();

    // If we're on main/master, use it as base
    if (currentBranch === 'main' || currentBranch === 'master') {
      taskBranchState.baseBranch = currentBranch;
    } else if (currentBranch.startsWith('feat/') || currentBranch.startsWith('task/')) {
      // Already on a feature branch — use current as base for branching
      taskBranchState.baseBranch = currentBranch;
    } else {
      taskBranchState.baseBranch = 'main';
    }
  } catch {
    taskBranchState.baseBranch = 'main';
  }

  // Slugify the task description to create a branch name
  const slug = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  const timestamp = Date.now().toString(36);
  const taskSuffix = taskId ? `-${taskId.slice(0, 8)}` : '';
  const branchName = `task/${slug || 'implementation'}${taskSuffix}-${timestamp}`;

  try {
    // Check if branch already exists
    try {
      execFileSync('git', ['rev-parse', '--verify', branchName], {
        cwd: workDir, stdio: 'pipe',
      });
      // Branch exists, just switch to it
      execFileSync('git', ['checkout', branchName], {
        cwd: workDir, stdio: 'pipe',
      });
    } catch {
      // Branch doesn't exist, create it
      // Stash any uncommitted changes first
      try {
        execSync('git stash push -m "cobra: auto-stash before task branch"', {
          cwd: workDir, stdio: 'pipe',
        });
      } catch { /* no changes to stash */ }

      // Create and switch to new branch
      execFileSync('git', ['checkout', '-b', branchName], {
        cwd: workDir, stdio: 'pipe',
      });

      // Pop stash if we stashed
      try {
        execSync('git stash pop', { cwd: workDir, stdio: 'pipe' });
      } catch { /* nothing to pop */ }
    }

    taskBranchState.currentBranch = branchName;
    if (taskId) {
      taskBranchState.taskBranches.set(taskId, branchName);
    }

    return branchName;
  } catch {
    return null;
  }
}

/**
 * Get the current task branch name.
 */
export function getCurrentTaskBranch(): string | null {
  return taskBranchState.currentBranch;
}

/**
 * Get the branch name for a specific task.
 */
export function getTaskBranch(taskId: string): string | null {
  return taskBranchState.taskBranches.get(taskId) || null;
}

/**
 * Return to the base branch after completing a task.
 * Optionally merges the task branch back.
 */
export function completeTaskBranch(
  workDir: string,
  taskId?: string,
  mergeBack: boolean = false,
): boolean {
  try {
    const branchToMerge = taskId
      ? taskBranchState.taskBranches.get(taskId)
      : taskBranchState.currentBranch;

    const baseBranch = taskBranchState.baseBranch;

    // Switch to base branch
    execFileSync('git', ['checkout', baseBranch], {
      cwd: workDir, stdio: 'pipe',
    });

    if (mergeBack && branchToMerge) {
      try {
        execFileSync('git', ['merge', '--no-ff', branchToMerge, '-m', `Merge task branch ${branchToMerge}`], {
          cwd: workDir, stdio: 'pipe',
        });
      } catch {
        // Merge conflict — abort
        try {
          execFileSync('git', ['merge', '--abort'], { cwd: workDir, stdio: 'pipe' });
        } catch { /* ignore */ }
        return false;
      }
    }

    // Clean up tracking
    if (taskId) {
      taskBranchState.taskBranches.delete(taskId);
    }
    taskBranchState.currentBranch = baseBranch;

    return true;
  } catch {
    return false;
  }
}

/**
 * List all active task branches.
 */
export function listTaskBranches(): Array<{ taskId: string; branchName: string }> {
  return [...taskBranchState.taskBranches.entries()].map(([taskId, branchName]) => ({
    taskId,
    branchName,
  }));
}

/**
 * Reset the task branch state (for testing or session reset).
 */
export function resetTaskBranchState(): void {
  taskBranchState = {
    currentBranch: null,
    baseBranch: 'main',
    taskBranches: new Map(),
  };
}

/**
 * Get the current Git branch name.
 * Returns null if not in a git repo or cannot determine.
 */
export function getCurrentBranch(workDir: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}
