import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  getDestroRetryStrategy,
  buildDestroRetryPrompt,
} from '../destro-retry.js';

describe('getDestroRetryStrategy', () => {
  const error = 'TypeError: something went wrong';

  it('returns ErrorFocused strategy on attempt 0', () => {
    const strategy = getDestroRetryStrategy(0, error);
    assert.equal(strategy.name, 'ErrorFocused');
  });

  it('returns ErrorFocused strategy on attempt 1', () => {
    const strategy = getDestroRetryStrategy(1, error);
    assert.equal(strategy.name, 'ErrorFocused');
  });

  it('returns SimplifiedApproach strategy on attempt 2', () => {
    const strategy = getDestroRetryStrategy(2, error);
    assert.equal(strategy.name, 'SimplifiedApproach');
  });

  it('returns BackoffAndReask strategy on attempt 3', () => {
    const strategy = getDestroRetryStrategy(3, error);
    assert.equal(strategy.name, 'BackoffAndReask');
  });

  it('returns CleanSlate strategy on attempt 4+', () => {
    const s4 = getDestroRetryStrategy(4, error);
    assert.equal(s4.name, 'CleanSlate');

    const s7 = getDestroRetryStrategy(7, error);
    assert.equal(s7.name, 'CleanSlate');
  });

  it('ErrorFocused strategy includes error in modified context', () => {
    const strategy = getDestroRetryStrategy(0, error);
    const result = strategy.apply('do task', 'some context', error, 0);
    assert.ok(result.modifiedContext.includes(error));
  });

  it('BackoffAndReask strategy tells the LLM to rephrase', () => {
    const strategy = getDestroRetryStrategy(3, error);
    const result = strategy.apply('do task', 'some context', error, 3);
    assert.ok(
      result.modifiedTask.includes('rephrase') ||
      result.modifiedContext.includes('rephrase') ||
      result.modifiedTask.includes('different'),
      'BackoffAndReask should suggest a different approach',
    );
  });
});

describe('buildDestroRetryPrompt', () => {
  it('builds a retry prompt with task, context, and optional model', () => {
    const strategy = getDestroRetryStrategy(2, 'some error');
    const result = buildDestroRetryPrompt(strategy, 'task', 'ctx', 'err', 2);

    assert.ok(typeof result.task === 'string');
    assert.ok(typeof result.context === 'string');
  });
});
