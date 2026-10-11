import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  isDirtyRepo,
  createCheckpoint,
  listCheckpoints,
  getChangeSummary,
  ensureGitRepo,
} from '../src/core/git-tracker.js';

describe('git-tracker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'git-tracker-test-'));
    // Initialize a git repo
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email test@test.com', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name Test', { cwd: tmpDir, stdio: 'pipe' });
    // Create initial commit
    writeFileSync(join(tmpDir, 'README.md'), '# Test');
    execSync('git add -A && git commit -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isDirtyRepo() should detect changes', () => {
    expect(isDirtyRepo(tmpDir)).toBe(false);
    writeFileSync(join(tmpDir, 'new-file.txt'), 'hello');
    expect(isDirtyRepo(tmpDir)).toBe(true);
  });

  it('isDirtyRepo() should return false for clean repo', () => {
    expect(isDirtyRepo(tmpDir)).toBe(false);
  });

  it('createCheckpoint() should create a checkpoint commit', () => {
    writeFileSync(join(tmpDir, 'checkpoint-test.txt'), 'data');
    const hash = createCheckpoint(tmpDir, 'test-checkpoint');
    expect(hash).toBeDefined();
    expect(typeof hash).toBe('string');
    expect(hash!.length).toBeGreaterThan(0);
  });

  it('listCheckpoints() should return checkpoint entries', () => {
    writeFileSync(join(tmpDir, 'data.txt'), 'some data');
    createCheckpoint(tmpDir, 'first-checkpoint');

    writeFileSync(join(tmpDir, 'data2.txt'), 'more data');
    createCheckpoint(tmpDir, 'second-checkpoint');

    const checkpoints = listCheckpoints(tmpDir);
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    const names = checkpoints.map(c => c.name);
    expect(names).toContain('first-checkpoint');
    expect(names).toContain('second-checkpoint');
  });

  it('getChangeSummary() should format changes', () => {
    // Create a tracked change (modify existing file)
    writeFileSync(join(tmpDir, 'README.md'), '# Modified');
    const summary = getChangeSummary(tmpDir);
    expect(summary).toBeTruthy();
    expect(summary).toContain('README.md');
  });

  it('ensureGitRepo() should not throw in a git directory', () => {
    expect(() => ensureGitRepo(tmpDir)).not.toThrow();
  });

  it('should handle non-git directories gracefully', () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-'));
    try {
      // isDirtyRepo should return false for non-git dirs
      expect(isDirtyRepo(nonGitDir)).toBe(false);
      // listCheckpoints should return empty
      expect(listCheckpoints(nonGitDir)).toEqual([]);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
