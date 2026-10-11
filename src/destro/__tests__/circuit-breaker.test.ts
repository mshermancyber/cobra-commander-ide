import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { DestroCircuitBreaker } from '../destro-circuit-breaker.js';

describe('DestroCircuitBreaker', () => {
  it('starts closed', () => {
    const cb = new DestroCircuitBreaker();
    assert.equal(cb.currentState, 'closed');
    assert.equal(cb.failures, 0);
  });

  it('opens after 3 consecutive failures', () => {
    const cb = new DestroCircuitBreaker();

    cb.recordFailure();
    assert.equal(cb.currentState, 'closed');
    assert.equal(cb.failures, 1);

    cb.recordFailure();
    assert.equal(cb.currentState, 'closed');
    assert.equal(cb.failures, 2);

    cb.recordFailure();
    assert.equal(cb.currentState, 'open');
    assert.equal(cb.failures, 3);
    assert.ok(cb.isOpen());
  });

  it('success resets to closed', () => {
    const cb = new DestroCircuitBreaker();

    // Open it first
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.currentState, 'open');

    // Success resets it
    cb.recordSuccess();
    assert.equal(cb.currentState, 'closed');
    assert.equal(cb.failures, 0);
    assert.ok(!cb.isOpen());
  });

  it('does not open on non-consecutive failures', () => {
    const cb = new DestroCircuitBreaker();

    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess(); // resets
    cb.recordFailure();
    cb.recordFailure();

    assert.equal(cb.currentState, 'closed');
    assert.equal(cb.failures, 2);
  });

  it('transitions to half-open after cooldown', () => {
    const cb = new DestroCircuitBreaker();

    // Open it
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.currentState, 'open');
    assert.ok(cb.isOpen());

    // Mock Date.now to simulate cooldown elapsed (5 min + 1ms)
    const originalNow = Date.now.bind(Date);
    const futureTime = Date.now() + 5 * 60 * 1000 + 1;
    Date.now = () => futureTime;

    try {
      // isOpen() should detect cooldown expired and transition to half-open,
      // returning false to admit the probe
      assert.ok(!cb.isOpen());
      assert.equal(cb.currentState, 'half-open');
    } finally {
      Date.now = originalNow;
    }
  });

  it('re-opens when half-open probe fails', () => {
    const cb = new DestroCircuitBreaker();

    // Open it
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.currentState, 'open');

    // Mock Date.now past cooldown
    const originalNow = Date.now.bind(Date);
    const futureTime = Date.now() + 5 * 60 * 1000 + 1;
    Date.now = () => futureTime;

    try {
      // Admit probe → half-open
      cb.isOpen();
      assert.equal(cb.currentState, 'half-open');

      // Probe fails → re-open
      cb.recordFailure();
      assert.equal(cb.currentState, 'open');
    } finally {
      Date.now = originalNow;
    }
  });

  it('resets to closed when half-open probe succeeds', () => {
    const cb = new DestroCircuitBreaker();

    // Open it
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    // Mock Date.now past cooldown
    const originalNow = Date.now.bind(Date);
    const futureTime = Date.now() + 5 * 60 * 1000 + 1;
    Date.now = () => futureTime;

    try {
      // Admit probe → half-open
      cb.isOpen();
      assert.equal(cb.currentState, 'half-open');

      // Probe succeeds → closed
      cb.recordSuccess();
      assert.equal(cb.currentState, 'closed');
      assert.equal(cb.failures, 0);
    } finally {
      Date.now = originalNow;
    }
  });

  it('fires state change callbacks', () => {
    const cb = new DestroCircuitBreaker();
    const transitions: Array<{ from: string; to: string }> = [];

    cb.onStateChange((from, to) => {
      transitions.push({ from, to });
    });

    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].from, 'closed');
    assert.equal(transitions[0].to, 'open');
  });

  it('unsubscribe stops callbacks', () => {
    const cb = new DestroCircuitBreaker();
    let calls = 0;

    const unsub = cb.onStateChange(() => { calls++; });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(calls, 1);

    unsub();
    cb.recordSuccess();
    assert.equal(calls, 1); // callback not fired after unsubscribe
  });
});
