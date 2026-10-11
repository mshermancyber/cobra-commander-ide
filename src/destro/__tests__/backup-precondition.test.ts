import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { backupBeforeMutation } from '../destro-hooks.js';

describe('backup precondition', () => {
  it('successful backup preserves file content and matches archive path structure', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'destro-backup-test-'));
    try {
      // Create a test file with known content
      const testContent = 'hello destro world\nline 2\n';
      const subDir = join(workDir, 'src', 'config');
      mkdirSync(subDir, { recursive: true });
      const srcFile = join(subDir, 'settings.json');
      writeFileSync(srcFile, testContent, 'utf-8');

      const incidentId = 'test-incident-001';
      const targets = ['src/config/settings.json'];
      const result = await backupBeforeMutation(workDir, incidentId, targets);

      // Verify one backup path returned
      assert.equal(result.length, 1);

      const backupPath = result[0];

      // Verify path matches expected structure: archive/<incidentId>-<timestamp>/<relative-path>
      const archivePattern = new RegExp(
        `archive${sep}${incidentId}-\\d+${sep}src${sep}config${sep}settings\\.json$`,
      );
      assert.ok(
        archivePattern.test(backupPath),
        `Backup path "${backupPath}" did not match expected archive/<incidentId>-<timestamp>/<relative-path> pattern`,
      );

      // Verify backup file exists and content matches original
      const backedUpContent = readFileSync(backupPath, 'utf-8');
      assert.equal(backedUpContent, testContent, 'Backup content should match original');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('refuses targets outside workDir with a clear error', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'destro-backup-test-'));
    try {
      const incidentId = 'test-outside-001';
      const outsideTarget = '../etc/passwd';

      await assert.rejects(
        backupBeforeMutation(workDir, incidentId, [outsideTarget]),
        {
          name: 'Error',
          message: /outside workDir.*REFUSED/,
        },
        'Should reject targets that escape workDir',
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('backup to non-writable archive dir is handled with a descriptive error', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'destro-backup-test-'));
    try {
      // Create the archive dir and make it non-writable
      const archiveDir = join(workDir, 'archive');
      mkdirSync(archiveDir, { recursive: true });
      chmodSync(archiveDir, 0o444); // read-only

      // Create a valid target file
      const srcFile = join(workDir, 'data.txt');
      writeFileSync(srcFile, 'test data', 'utf-8');

      const incidentId = 'test-readonly-001';

      await assert.rejects(
        backupBeforeMutation(workDir, incidentId, ['data.txt']),
        {
          name: 'Error',
          message: /backup failed.*REFUSING mutation/,
        },
        'Should report a descriptive error when archive dir is not writable',
      );
    } finally {
      // Restore write permission so cleanup works
      const archiveDir = join(workDir, 'archive');
      try { chmodSync(archiveDir, 0o755); } catch { /* best-effort */ }
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
