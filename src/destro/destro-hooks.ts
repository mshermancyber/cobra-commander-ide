import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, dirname } from 'node:path';

const execAsync = promisify(exec);

// ──────────────────────────────────────────────
// (a) Backup precondition
// ──────────────────────────────────────────────

/**
 * Copy target file(s) to an archive directory before mutation.
 * Preserves relative paths under the archive root.
 * If the backup fails, the caller MUST refuse the mutation.
 *
 * @returns Array of backup destination paths.
 */
export async function backupBeforeMutation(
  workDir: string,
  incidentId: string,
  targets: string[],
): Promise<string[]> {
  const timestamp = Date.now();
  const archiveRoot = join(workDir, 'archive', `${incidentId}-${timestamp}`);

  const results: string[] = [];

  for (const target of targets) {
    const src = join(workDir, target);
    const rel = relative(workDir, src);
    // Guard: refuse targets outside workDir
    if (rel.startsWith('..')) {
      throw new Error(`backupBeforeMutation: target "${target}" is outside workDir — REFUSED`);
    }
    const dest = join(archiveRoot, rel);

    try {
      await fs.mkdir(dirname(dest), { recursive: true });
      await fs.cp(src, dest, { recursive: true });
      results.push(dest);
    } catch (err) {
      throw new Error(
        `backupBeforeMutation: backup failed for "${target}" — REFUSING mutation: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  return results;
}

// ──────────────────────────────────────────────
// (b) Git-aware checkpoint
// ──────────────────────────────────────────────

async function inGitRepo(workDir: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --show-toplevel', { cwd: workDir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort git checkpoint around a Destro mutation.
 *
 * Pre-mutation:  git add -A && git stash push -m "destro: pre-<incidentId>"
 * Post-mutation: git add <targets> && git commit -m "destro: <incidentId> <summary>"
 *
 * Never throws — git unavailability is silently tolerated.
 */
export async function gitCheckpoint(
  workDir: string,
  incidentId: string,
  summary: string,
  targets: string[],
): Promise<void> {
  if (!(await inGitRepo(workDir))) return;

  // Pre-mutation stash (best-effort)
  try {
    await execAsync('git add -A', { cwd: workDir });
    await execAsync(`git stash push -m "destro: pre-${incidentId}"`, { cwd: workDir });
  } catch { /* best-effort */ }

  // Post-mutation commit (best-effort)
  try {
    const targetArgs = targets.map(t => `"${t}"`).join(' ');
    await execAsync(`git add ${targetArgs}`, { cwd: workDir });
    await execAsync(
      `git commit -m "destro: ${incidentId} ${summary}"`,
      { cwd: workDir },
    );
  } catch { /* best-effort */ }
}

// ──────────────────────────────────────────────
// (c) Secret redaction
// ──────────────────────────────────────────────

// Value matcher shared by the env patterns: an optionally single/double-quoted
// value. `'...'`, `"..."`, or a bare non-whitespace run. Capturing the quote so
// the whole assigned value (quotes included) is replaced — earlier patterns
// only matched UNQUOTED values, so shell forms like PGPASSWORD='<hex>' and
// `docker exec -e VAR="<secret>"` leaked the secret verbatim.
const _VAL = `(?:'[^']*'|"[^"]*"|\\S+)`;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Any env/CLI key whose NAME implies a secret (password/passwd/pwd/secret/
  // token/apikey/access_key/private_key/credential), anywhere in the key, so
  // PGPASSWORD, DB_PASSWORD, MYSQL_PWD, X_API_KEY, etc. all match. Handles an
  // optional leading `-e ` (docker env flag) and quoted or unquoted values.
  [new RegExp(
    `(^|\\s)(-e\\s+|--env\\s+)?([A-Za-z_][A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|apikey|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_]*)\\s*=\\s*${_VAL}`,
    'gi'),
    '$1$2$3=[REDACTED]'],
  // bearer <token>
  [/(^|\s)bearer\s+\S+/gi, '$1bearer [REDACTED]'],
  // Long hex strings (>=33 hex chars) assigned to ANY identifier, quoted or not.
  [new RegExp(`(^|\\s)(-e\\s+|--env\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(['"]?)([0-9a-fA-F]{33,})\\4`, 'g'),
    '$1$2$3=$4[REDACTED_HEX]$4'],
  // Long base64 strings (>=41 base64 chars) assigned to ANY identifier, quoted or not.
  [new RegExp(`(^|\\s)(-e\\s+|--env\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(['"]?)([A-Za-z0-9+/=]{41,})\\4`, 'g'),
    '$1$2$3=$4[REDACTED_B64]$4'],
];

/**
 * Redact secrets from a text string before display/logging.
 * Covers key=, password=, token=, bearer, long hex, and long base64 patterns.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ──────────────────────────────────────────────
// (d) Audit append
// ──────────────────────────────────────────────

export interface AuditEntry {
  tool: string;
  argsSummary: string;
  backupPath?: string;
  outcome: string;
}

/**
 * Append a JSON-line audit entry to the incident's audit log.
 */
export async function appendAuditEntry(
  workDir: string,
  incidentId: string,
  entry: AuditEntry,
): Promise<void> {
  const archiveDir = join(workDir, 'archive', incidentId);
  await fs.mkdir(archiveDir, { recursive: true });

  const auditPath = join(archiveDir, 'audit.jsonl');
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
  await fs.appendFile(auditPath, line, 'utf-8');
}

// ──────────────────────────────────────────────
// DestroHooks — unified safety wrapper
// ──────────────────────────────────────────────

/**
 * Safety floor for Destro file mutations.
 *
 * Usage:
 *   const hooks = new DestroHooks();
 *   await hooks.preMutation(workDir, incidentId, targets);
 *   // ... perform the mutation ...
 *   await hooks.postMutation(workDir, incidentId, summary, targets);
 *   const safe  = hooks.redactForDisplay(rawText);
 */
export class DestroHooks {
  /**
   * Pre-mutation safety: backup targets + git stash (best-effort).
   * Throws if backup fails — the caller MUST abort the mutation.
   */
  async preMutation(
    workDir: string,
    incidentId: string,
    targets: string[],
  ): Promise<string[]> {
    const backups = await backupBeforeMutation(workDir, incidentId, targets);

    // Git pre-mutation stash (best-effort, don't throw)
    if (await inGitRepo(workDir)) {
      try {
        await execAsync('git add -A', { cwd: workDir });
        await execAsync(`git stash push -m "destro: pre-${incidentId}"`, { cwd: workDir });
      } catch { /* best-effort */ }
    }

    return backups;
  }

  /**
   * Post-mutation safety: git commit (best-effort) + audit entry.
   */
  async postMutation(
    workDir: string,
    incidentId: string,
    summary: string,
    targets: string[],
  ): Promise<void> {
    // Git post-mutation commit (best-effort)
    if (await inGitRepo(workDir)) {
      try {
        const targetArgs = targets.map(t => `"${t}"`).join(' ');
        await execAsync(`git add ${targetArgs}`, { cwd: workDir });
        await execAsync(
          `git commit -m "destro: ${incidentId} ${summary}"`,
          { cwd: workDir },
        );
      } catch { /* best-effort */ }
    }

    // Audit
    await appendAuditEntry(workDir, incidentId, {
      tool: 'DestroHooks',
      argsSummary: `postMutation: ${targets.join(', ')}`,
      outcome: summary,
    });
  }

  /**
   * Redact secrets for display in logs or user-facing output.
   */
  redactForDisplay(text: string): string {
    return redactSecrets(text);
  }
}
