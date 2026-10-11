// Destro agent — context. Created 2026-07-04.

export const DESTRO_MAX_CONTEXT_CHARS = 80_000;

/** Maximum chars per individual line after byte-clamp. */
const DESTRO_LINE_CLAMP = 400;

export interface DestroMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

/**
 * Clamp a string to at most `maxLength` characters.
 */
export function capDestroContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength);
}

/**
 * Estimate total character count across all messages in a session.
 */
export function estimateDestroSessionChars(messages: DestroMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += m.content.length;
    }
  }
  return total;
}

/**
 * Collapse a Destro session's messages to stay under the character budget.
 *
 * 1. Each message's content is split into lines and each line is byte-clamped
 *    to ≤ DESTRO_LINE_CLAMP characters.
 * 2. If the total still exceeds `maxChars` (default DESTRO_MAX_CONTEXT_CHARS),
 *    the oldest messages are trimmed until the budget is met.
 */
export function collapseDestroSession(
  messages: DestroMessage[],
  maxChars: number = DESTRO_MAX_CONTEXT_CHARS,
): DestroMessage[] {
  // Step 1: clamp each line within every message
  const clamped = messages.map(m => {
    if (typeof m.content !== 'string') return m;
    const lines = m.content.split('\n');
    const clampedLines = lines.map(l => capDestroContent(l, DESTRO_LINE_CLAMP));
    return { ...m, content: clampedLines.join('\n') };
  });

  // Step 2: keep newest messages until adding another would exceed budget
  const kept: DestroMessage[] = [];
  let runningTotal = 0;

  for (let i = clamped.length - 1; i >= 0; i--) {
    const msg = clamped[i];
    const len = typeof msg.content === 'string' ? msg.content.length : 0;

    if (runningTotal + len > maxChars && kept.length > 0) break;

    kept.unshift(msg);
    runningTotal += len;
  }

  // If nothing could fit, keep just the last message trimmed to budget
  if (kept.length === 0 && clamped.length > 0) {
    const last = clamped[clamped.length - 1];
    if (typeof last.content === 'string') {
      kept.push({ ...last, content: capDestroContent(last.content, maxChars) });
    } else {
      kept.push(last);
    }
  }

  return kept;
}
