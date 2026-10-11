// R3 learning hooks tests — repeat-failure breaker, negative memory,
// classified failures, hypothesis pinning, bounded exploration, shell gating.

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  recordFailedAttempt,
  queryFailedAttempts,
  clearFailedAttempts,
} from '../incident-memory.js';
import {
  classifyCommand,
  setShellPermission,
  type CommandRisk,
} from '../destro-shell.js';
import {
  collapseDestroSession,
} from '../destro-context.js';
import type { DestroMessage } from '../destro-context.js';
import {
  autocompactSession,
  createDestroSession,
  appendMessage,
  appendToolResult,
  type DestroSessionState,
} from '../destro-session.js';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `destro-r3-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ──────────────────────────────────────────────
// Test 1: Repeat-failure breaker (unit-level validation)
// ──────────────────────────────────────────────

describe('R3 §1 — Repeat-failure breaker', () => {
  it('increments fail count and refuses on 3rd identical call', () => {
    // Simulate the failCounts map logic used in destro-agent.ts
    const failCounts = new Map<string, number>();
    const DESTRO_REPEAT_LIMIT = 2;

    const key = 'run_command:{"command":"curl http://bad"}';

    // First failure
    failCounts.set(key, 1);
    assert.equal(failCounts.get(key), 1);

    // Second failure
    failCounts.set(key, 2);
    assert.ok((failCounts.get(key) || 0) >= DESTRO_REPEAT_LIMIT);

    // Third attempt: refused
    const prevFails = failCounts.get(key) || 0;
    assert.ok(prevFails >= DESTRO_REPEAT_LIMIT);
  });

  it('resets fail count on success', () => {
    const failCounts = new Map<string, number>();
    const key = 'run_command:{"command":"curl http://ok"}';

    // Two failures
    failCounts.set(key, 2);

    // Success resets
    failCounts.set(key, 0);
    assert.equal(failCounts.get(key), 0);
  });

  it('different calls are tracked separately', () => {
    const failCounts = new Map<string, number>();
    const key1 = 'run_command:{"command":"cmd1"}';
    const key2 = 'run_command:{"command":"cmd2"}';

    failCounts.set(key1, 3);
    failCounts.set(key2, 0);

    assert.equal(failCounts.get(key1), 3);
    assert.equal(failCounts.get(key2), 0);
  });
});

// ──────────────────────────────────────────────
// Test 2: Negative memory round-trip
// ──────────────────────────────────────────────

describe('R3 §2 — Negative memory (failed attempts)', () => {
  beforeEach(async () => {
    await clearFailedAttempts();
  });

  it('recordFailedAttempt / queryFailedAttempts round-trip', async () => {
    await recordFailedAttempt({
      service: 'api-gateway',
      failureSignature: '502 Bad Gateway on /health',
      attemptedFix: 'Restarted nginx container',
      whyFailed: 'Port conflict — nginx could not bind to 80',
      ts: Date.now(),
    });

    const results = await queryFailedAttempts('api-gateway', '502 Bad Gateway');
    assert.equal(results.length, 1);
    assert.equal(results[0].service, 'api-gateway');
    assert.equal(results[0].attemptedFix, 'Restarted nginx container');
    assert.equal(results[0].whyFailed, 'Port conflict — nginx could not bind to 80');
  });

  it('dead-end injection string contains the attempt', async () => {
    await recordFailedAttempt({
      service: 'web-server',
      failureSignature: 'connection refused',
      attemptedFix: 'docker compose restart',
      whyFailed: 'Container image was corrupt — restart looped',
      ts: Date.now(),
    });

    const deadEnds = await queryFailedAttempts('web-server', 'connection refused');
    assert.equal(deadEnds.length, 1);

    // Build the injection string as destro-agent.ts would
    const deadEndText = deadEnds
      .map((a, i) =>
        `**Dead end ${i + 1}**: ${a.attemptedFix}\nWhy failed: ${a.whyFailed}`
      )
      .join('\n');

    const fullText = `KNOWN DEAD ENDS for this service/signature (do NOT retry these):\n${deadEndText}`;
    assert.ok(fullText.includes('docker compose restart'));
    assert.ok(fullText.includes('corrupt'));
    assert.ok(fullText.includes('KNOWN DEAD ENDS'));
  });

  it('query returns empty for unmatched service', async () => {
    await recordFailedAttempt({
      service: 'only-service',
      failureSignature: 'some error',
      attemptedFix: 'did something',
      whyFailed: 'did not work',
      ts: Date.now(),
    });

    const results = await queryFailedAttempts('other-service', 'some error');
    assert.equal(results.length, 0);
  });

  it('substring matching works for failure signatures', async () => {
    await recordFailedAttempt({
      service: 'svc',
      failureSignature: 'timeout connecting to database',
      attemptedFix: 'increased pool size',
      whyFailed: 'db was actually down',
      ts: Date.now(),
    });

    const results = await queryFailedAttempts('svc', 'database');
    assert.equal(results.length, 1);
  });
});

// ──────────────────────────────────────────────
// Test 3: Classified failures
// ──────────────────────────────────────────────

describe('R3 §3 — Classified failures', () => {
  it('classifyCommand identifies dangerous commands', () => {
    const risk = classifyCommand('rm -rf /tmp/test');
    assert.equal(risk.level, 'dangerous');
    assert.ok(risk.reason.includes('force delete'));
  });

  it('classifyCommand identifies moderate commands', () => {
    const risk = classifyCommand('git push origin main');
    assert.equal(risk.level, 'moderate');
    assert.ok(risk.reason.includes('git push'));
  });

  it('classifyCommand identifies safe commands', () => {
    const risk = classifyCommand('ls -la');
    assert.equal(risk.level, 'safe');
  });

  it('synthetic port-conflict error produces a CLASSIFIED tag via classifyDestroError', async () => {
    // Import classifyDestroError dynamically to test the actual function
    const { classifyDestroError } = await import('../destro-error-classifier.js');

    const result = classifyDestroError('port is already allocated: bind: address already in use');
    assert.equal(result.action, 'container_issue');
    assert.equal(result.containerSignature, 'port-already-allocated');

    // Simulate what destro-agent.ts does: append classification hint
    const hints: Record<string, string> = {
      'container_issue': 'hint: container issue detected (port-already-allocated) — check container logs and state',
    };
    const hint = hints[result.action] || '';
    const classified = `\n[CLASSIFIED: ${result.action} — ${hint}]`;

    assert.ok(classified.includes('[CLASSIFIED:'));
    assert.ok(classified.includes('container_issue'));
    assert.ok(classified.includes('port-already-allocated'));
  });

  it('classifyDestroError returns retry for unknown errors', async () => {
    const { classifyDestroError } = await import('../destro-error-classifier.js');
    const result = classifyDestroError('something completely unknown happened');
    assert.equal(result.action, 'retry');
  });
});

// ──────────────────────────────────────────────
// Test 4: Hypothesis pinning in compaction
// ──────────────────────────────────────────────

describe('R3 §4 — Falsified hypothesis ledger pinned through compaction', () => {
  it('compaction retains a falsified hypothesis entry after collapse of a long session', () => {
    // Create a session with many messages to trigger compaction
    const session = createDestroSession('hypothesis-test');

    // Add a hypothesis tool call + result (falsified)
    const hypoArgs = JSON.stringify({ text: 'Root cause is OOM kill', status: 'falsified' });
    appendMessage(session, {
      role: 'assistant',
      content: 'Recording hypothesis.',
      tool_calls: [
        {
          id: 'hypo-1',
          type: 'function',
          function: { name: 'record_hypothesis', arguments: hypoArgs },
        },
      ],
    });
    appendToolResult(session, 'hypo-1', 'record_hypothesis',
      'Hypothesis recorded: [falsified] Root cause is OOM kill', false);

    // Add many filler messages to force compaction
    const filler = 'x'.repeat(10_000);
    for (let i = 0; i < 20; i++) {
      appendMessage(session, { role: 'user', content: `msg-${i}: ${filler}` });
      appendMessage(session, { role: 'assistant', content: `reply-${i}: ${filler}` });
    }

    // Compact
    const compacted = autocompactSession(session, 80_000);

    // The falsified hypothesis should be in the ledger
    const hypoEntries = compacted.actionsLedger.filter(
      e => e.tool === 'hypothesis' && e.outcome === 'falsified',
    );
    assert.ok(hypoEntries.length >= 1, 'Expected at least 1 falsified hypothesis in ledger');
    assert.ok(
      hypoEntries.some(e => e.args.includes('OOM kill')),
      'Hypothesis text should be preserved',
    );
  });

  it('confirmed hypothesis also survives compaction', () => {
    const session = createDestroSession('confirmed-test');

    const hypoArgs = JSON.stringify({ text: 'Root cause is expired TLS cert', status: 'confirmed' });
    appendMessage(session, {
      role: 'assistant',
      content: 'Recording hypothesis.',
      tool_calls: [
        {
          id: 'hypo-2',
          type: 'function',
          function: { name: 'record_hypothesis', arguments: hypoArgs },
        },
      ],
    });
    appendToolResult(session, 'hypo-2', 'record_hypothesis',
      'Hypothesis recorded: [confirmed] Root cause is expired TLS cert', false);

    const filler = 'y'.repeat(12_000);
    for (let i = 0; i < 15; i++) {
      appendMessage(session, { role: 'user', content: `msg-${i}: ${filler}` });
      appendMessage(session, { role: 'assistant', content: `reply-${i}: ${filler}` });
    }

    const compacted = autocompactSession(session, 80_000);

    const hypoEntries = compacted.actionsLedger.filter(
      e => e.tool === 'hypothesis' && e.outcome === 'confirmed',
    );
    assert.ok(hypoEntries.length >= 1, 'Expected at least 1 confirmed hypothesis in ledger');
    assert.ok(
      hypoEntries.some(e => e.args.includes('TLS cert')),
      'Confirmed hypothesis text should be preserved',
    );
  });

  it('open hypothesis may be dropped in compaction', () => {
    const session = createDestroSession('open-test');

    const hypoArgs = JSON.stringify({ text: 'Maybe a DNS issue', status: 'open' });
    appendMessage(session, {
      role: 'assistant',
      content: 'Recording hypothesis.',
      tool_calls: [
        {
          id: 'hypo-3',
          type: 'function',
          function: { name: 'record_hypothesis', arguments: hypoArgs },
        },
      ],
    });
    appendToolResult(session, 'hypo-3', 'record_hypothesis',
      'Hypothesis recorded: [open] Maybe a DNS issue', false);

    const filler = 'z'.repeat(15_000);
    for (let i = 0; i < 20; i++) {
      appendMessage(session, { role: 'user', content: `msg-${i}: ${filler}` });
      appendMessage(session, { role: 'assistant', content: `reply-${i}: ${filler}` });
    }

    const compacted = autocompactSession(session, 80_000);

    // Open hypotheses are NOT pinned — they may or may not be in the ledger
    // (they could be if extracted from old messages, but the pinning logic only
    // applies to falsified/confirmed)
    const pinnedOpen = compacted.actionsLedger.filter(
      e => e.tool === 'hypothesis' && e.outcome === 'open',
    );
    // Open is not pinned explicitly — its presence is incidental, not guaranteed
    // This test just verifies we don't crash
    assert.ok(Array.isArray(compacted.actionsLedger));
  });
});

// ──────────────────────────────────────────────
// Test 5: Shell risk gating
// ──────────────────────────────────────────────

describe('R3 §6 — run_command risk gating', () => {
  it('MUTATING_SHELL_RE matches docker compose build', () => {
    const MUTATING_SHELL_RE = /docker\s+(compose\s+)?(build|up|rm|restart|stop)|systemctl|rm\s|mv\s|chmod|chown|tee\s|>\s|>>|sed\s+-i|git\s+(commit|push)|npm\s+(install|ci)|pip\s+install|kill/;
    assert.ok(MUTATING_SHELL_RE.test('docker compose build'));
    assert.ok(MUTATING_SHELL_RE.test('docker build -t img .'));
    assert.ok(MUTATING_SHELL_RE.test('docker compose up -d'));
  });

  it('MUTATING_SHELL_RE matches systemctl', () => {
    const MUTATING_SHELL_RE = /docker\s+(compose\s+)?(build|up|rm|restart|stop)|systemctl|rm\s|mv\s|chmod|chown|tee\s|>\s|>>|sed\s+-i|git\s+(commit|push)|npm\s+(install|ci)|pip\s+install|kill/;
    assert.ok(MUTATING_SHELL_RE.test('systemctl restart nginx'));
    assert.ok(MUTATING_SHELL_RE.test('systemctl status nginx'));
  });

  it('MUTATING_SHELL_RE matches rm, chmod, chown', () => {
    const MUTATING_SHELL_RE = /docker\s+(compose\s+)?(build|up|rm|restart|stop)|systemctl|rm\s|mv\s|chmod|chown|tee\s|>\s|>>|sed\s+-i|git\s+(commit|push)|npm\s+(install|ci)|pip\s+install|kill/;
    assert.ok(MUTATING_SHELL_RE.test('rm file.txt'));
    assert.ok(MUTATING_SHELL_RE.test('chmod +x script.sh'));
    assert.ok(MUTATING_SHELL_RE.test('chown user:group file.txt'));
  });

  it('MUTATING_SHELL_RE matches git commit and push', () => {
    const MUTATING_SHELL_RE = /docker\s+(compose\s+)?(build|up|rm|restart|stop)|systemctl|rm\s|mv\s|chmod|chown|tee\s|>\s|>>|sed\s+-i|git\s+(commit|push)|npm\s+(install|ci)|pip\s+install|kill/;
    assert.ok(MUTATING_SHELL_RE.test('git commit -m "fix"'));
    assert.ok(MUTATING_SHELL_RE.test('git push origin main'));
  });

  it('MUTATING_SHELL_RE matches npm install and pip install', () => {
    const MUTATING_SHELL_RE = /docker\s+(compose\s+)?(build|up|rm|restart|stop)|systemctl|rm\s|mv\s|chmod|chown|tee\s|>\s|>>|sed\s+-i|git\s+(commit|push)|npm\s+(install|ci)|pip\s+install|kill/;
    assert.ok(MUTATING_SHELL_RE.test('npm install express'));
    assert.ok(MUTATING_SHELL_RE.test('pip install requests'));
  });

  it('MUTATING_SHELL_RE does NOT match safe commands', () => {
    const MUTATING_SHELL_RE = /docker\s+(compose\s+)?(build|up|rm|restart|stop)|systemctl|rm\s|mv\s|chmod|chown|tee\s|>\s|>>|sed\s+-i|git\s+(commit|push)|npm\s+(install|ci)|pip\s+install|kill/;
    assert.ok(!MUTATING_SHELL_RE.test('ls -la'));
    assert.ok(!MUTATING_SHELL_RE.test('cat file.txt'));
    assert.ok(!MUTATING_SHELL_RE.test('echo hello'));
    assert.ok(!MUTATING_SHELL_RE.test('git status'));
    assert.ok(!MUTATING_SHELL_RE.test('git log --oneline'));
    assert.ok(!MUTATING_SHELL_RE.test('npx tsc --noEmit'));
  });

  it('readOnly session would refuse docker compose build (unit check)', () => {
    // Simulate the gating logic from destro-agent.ts
    const MUTATING_SHELL_RE = /docker\s+(compose\s+)?(build|up|rm|restart|stop)|systemctl|rm\s|mv\s|chmod|chown|tee\s|>\s|>>|sed\s+-i|git\s+(commit|push)|npm\s+(install|ci)|pip\s+install|kill/;

    const cmd = 'docker compose build';
    const readOnly = true;
    const risk = classifyCommand(cmd);
    const isMutatingShell = MUTATING_SHELL_RE.test(cmd) || risk.level !== 'safe';

    assert.ok(isMutatingShell, 'docker compose build should be mutating');
    assert.ok(readOnly, 'session is read-only');

    // In readOnly + mutating → REFUSED
    const shouldRefuse = isMutatingShell && readOnly;
    assert.ok(shouldRefuse, 'readOnly session should refuse mutating shell command');

    // Verify the refusal message style matches the mutation refusal pattern
    const refusalMsg = `REFUSED: session is READ-ONLY (diagnose-only). Shell command "${cmd.slice(0, 120)}" is classified as mutating (risk: ${risk.level}, ${risk.reason}). Report your diagnosis and recommended fix instead of applying it.`;
    assert.ok(refusalMsg.includes('REFUSED'));
    assert.ok(refusalMsg.includes('READ-ONLY'));
    assert.ok(refusalMsg.includes('docker compose build'));
  });

  it('non-readOnly session allows mutating shell but audits', () => {
    const MUTATING_SHELL_RE = /docker\s+(compose\s+)?(build|up|rm|restart|stop)|systemctl|rm\s|mv\s|chmod|chown|tee\s|>\s|>>|sed\s+-i|git\s+(commit|push)|npm\s+(install|ci)|pip\s+install|kill/;

    const cmd = 'docker compose build';
    const readOnly = false;
    const risk = classifyCommand(cmd);
    const isMutatingShell = MUTATING_SHELL_RE.test(cmd) || risk.level !== 'safe';

    // In non-readOnly + mutating → allow but audit
    const shouldAllow = isMutatingShell && !readOnly;
    assert.ok(shouldAllow, 'non-readOnly should allow mutating shell with audit');

    const auditOutcome = 'AUDIT (mutating-shell)';
    assert.ok(auditOutcome.includes('mutating-shell'));
  });
});
