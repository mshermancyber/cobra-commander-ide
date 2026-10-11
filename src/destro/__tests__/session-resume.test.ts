import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  createSession,
  activateSession,
  heartbeatSession,
  closeSession,
  reconcileSessions,
  getSession,
  failLoudSession,
  clearSessions,
  MAX_RESUMES,
} from '../destro-session-store.js';

describe('Destro session store', () => {
  beforeEach(() => {
    clearSessions();
  });

  describe('create / activate / heartbeat / close', () => {
    it('creates a session with initial state', () => {
      const s = createSession('test-1');
      assert.equal(s.id, 'test-1');
      assert.equal(s.resumeCount, 0);
      assert.ok(s.createdAt > 0);
      assert.ok(Array.isArray(s.ledger));
    });

    it('activates a session and sets status to active', () => {
      createSession('test-2');
      const s = activateSession('test-2');
      assert.equal(s.status, 'active');
    });

    it('heartbeat updates lastHeartbeat and appends ledger entries', () => {
      createSession('test-3');
      activateSession('test-3');

      const before = getSession('test-3')!.lastHeartbeat;

      // Small delay to ensure timestamp changes
      const start = Date.now();
      while (Date.now() === start) { /* busy-wait */ }

      heartbeatSession('test-3', { step: 'wrote file' });
      heartbeatSession('test-3', { step: 'ran tsc' });

      const s = getSession('test-3')!;
      assert.ok(s.lastHeartbeat > before, 'heartbeat should update timestamp');
      assert.equal(s.ledger.length, 2);
      assert.deepStrictEqual(s.ledger[0], { step: 'wrote file' });
      assert.deepStrictEqual(s.ledger[1], { step: 'ran tsc' });
    });

    it('closes a session gracefully', () => {
      createSession('test-4');
      activateSession('test-4');
      closeSession('test-4');
      assert.equal(getSession('test-4')!.status, 'closed');
    });
  });

  describe('reconcileSessions', () => {
    it('detects stale sessions and requeues them', () => {
      createSession('stale-1');
      activateSession('stale-1');
      heartbeatSession('stale-1', { step: 'did work' });

      // Simulate kill by making the heartbeat look ancient
      const s = getSession('stale-1')!;
      s.lastHeartbeat = 0; // Jan 1 1970 — definitely stale

      const result = reconcileSessions();
      assert.equal(result.resumed, 1);
      assert.equal(result.failed, 0);

      const updated = getSession('stale-1')!;
      assert.equal(updated.resumeCount, 1);
      assert.equal(updated.status, 'stale');
    });

    it('increments resume count correctly across multiple reconciles', () => {
      createSession('stale-2');
      activateSession('stale-2');

      const s = getSession('stale-2')!;

      // First reconcile
      s.lastHeartbeat = 0;
      let result = reconcileSessions();
      assert.equal(result.resumed, 1);
      assert.equal(getSession('stale-2')!.resumeCount, 1);

      // Re-activate and simulate another kill
      activateSession('stale-2');
      const s2 = getSession('stale-2')!;
      s2.lastHeartbeat = 0;
      result = reconcileSessions();
      assert.equal(result.resumed, 1);
      assert.equal(getSession('stale-2')!.resumeCount, 2);
    });

    it('skips sessions that are not stale', () => {
      createSession('fresh-1');
      activateSession('fresh-1');
      // Heartbeat was just now — definitely not stale

      const result = reconcileSessions();
      assert.equal(result.resumed, 0);
      assert.equal(result.failed, 0);
      assert.equal(getSession('fresh-1')!.status, 'active');
    });

    it('skips non-active sessions', () => {
      createSession('closed-1');
      // Never activated — status is 'stale' from createSession

      const result = reconcileSessions();
      assert.equal(result.resumed, 0);
      assert.equal(result.failed, 0);
    });
  });

  describe('failLoudSession', () => {
    it('marks session as escalated when resumeCount exceeds MAX_RESUMES', () => {
      createSession('doomed-1');
      activateSession('doomed-1');

      const s = getSession('doomed-1')!;
      s.resumeCount = MAX_RESUMES + 1;

      const failed = failLoudSession('doomed-1');
      assert.equal(failed.status, 'escalated');
    });

    it('marks session as failed when resumeCount is at or below MAX_RESUMES', () => {
      createSession('doomed-2');
      activateSession('doomed-2');

      const s = getSession('doomed-2')!;
      s.resumeCount = MAX_RESUMES;

      const failed = failLoudSession('doomed-2');
      assert.equal(failed.status, 'failed');
    });

    it('reconcileSessions fails-loud when MAX_RESUMES is exceeded', () => {
      createSession('doomed-3');
      activateSession('doomed-3');

      const s = getSession('doomed-3')!;
      s.resumeCount = MAX_RESUMES; // one more reconcile will exceed
      s.lastHeartbeat = 0;

      const result = reconcileSessions();
      assert.equal(result.resumed, 0);
      assert.equal(result.failed, 1);
      assert.equal(getSession('doomed-3')!.status, 'escalated');
    });
  });
});
