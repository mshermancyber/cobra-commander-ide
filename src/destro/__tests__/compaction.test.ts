import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  collapseDestroSession,
  DESTRO_MAX_CONTEXT_CHARS,
} from '../destro-context.js';
import type { DestroMessage } from '../destro-context.js';

describe('collapseDestroSession', () => {
  it('stays under budget on a pathological single-line log', () => {
    // Create a 100,000 char single-line log
    const hugeLine = 'x'.repeat(100_000);

    const messages: DestroMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Do a thing.' },
      { role: 'assistant', content: hugeLine },
    ];

    const collapsed = collapseDestroSession(messages);

    // Compute total chars across all messages
    let totalChars = 0;
    for (const m of collapsed) {
      if (typeof m.content === 'string') {
        totalChars += m.content.length;
      }
    }

    assert.ok(
      totalChars <= DESTRO_MAX_CONTEXT_CHARS,
      `Total chars ${totalChars} should be ≤ ${DESTRO_MAX_CONTEXT_CHARS}`,
    );
  });

  it('clamps individual lines to ≤ 400 chars (byte-clamp)', () => {
    const hugeLine = 'y'.repeat(100_000);

    const messages: DestroMessage[] = [
      { role: 'assistant', content: hugeLine },
    ];

    const collapsed = collapseDestroSession(messages);
    assert.ok(collapsed.length > 0);

    for (const m of collapsed) {
      if (typeof m.content !== 'string') continue;
      const lines = m.content.split('\n');
      for (const line of lines) {
        assert.ok(
          line.length <= 400,
          `Line of length ${line.length} exceeds 400-char clamp`,
        );
      }
    }
  });

  it('preserves short messages untouched', () => {
    const messages: DestroMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];

    const collapsed = collapseDestroSession(messages);
    assert.equal(collapsed.length, 2);
    assert.equal(collapsed[0].content, 'hello');
    assert.equal(collapsed[1].content, 'world');
  });

  it('handles multi-line content with line clamping', () => {
    const longLine = 'a'.repeat(500);
    const shortLine = 'b'.repeat(100);
    const multiLine = [longLine, shortLine, longLine].join('\n');

    const messages: DestroMessage[] = [
      { role: 'assistant', content: multiLine },
    ];

    const collapsed = collapseDestroSession(messages);
    const lines = collapsed[0].content.split('\n');

    // Each line should be clamped to 400
    assert.equal(lines.length, 3);
    assert.equal(lines[0].length, 400);
    assert.equal(lines[1].length, 100); // short line preserved
    assert.equal(lines[2].length, 400);
  });

  it('trims oldest messages when total exceeds budget', () => {
    // Create many messages that collectively exceed the budget
    const filler = 'z'.repeat(10_000);
    const messages: DestroMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `msg-${i}: ${filler}` });
    }

    const collapsed = collapseDestroSession(messages);

    let totalChars = 0;
    for (const m of collapsed) {
      if (typeof m.content === 'string') {
        totalChars += m.content.length;
      }
    }

    assert.ok(
      totalChars <= DESTRO_MAX_CONTEXT_CHARS,
      `Total chars ${totalChars} should be ≤ ${DESTRO_MAX_CONTEXT_CHARS}`,
    );
  });

  it('returns empty array for empty input', () => {
    const result = collapseDestroSession([]);
    assert.equal(result.length, 0);
  });
});
