/**
 * Context Overflow Detection — Recognizes context-window overflow errors
 * across multiple LLM providers (Anthropic, OpenAI, the worker model) and generic
 * patterns. Used by context-compaction to auto-recover from overflow errors.
 */

const OVERFLOW_PATTERNS: RegExp[] = [
  // Anthropic
  /max.*tokens/i,
  /context.*length.*exceeded/i,
  /prompt.*too.*long/i,

  // OpenAI
  /maximum context length/i,
  /tokens.*exceeds.*limit/i,
  /context_length_exceeded/i,

  // the worker model
  /input.*too.*long/i,
  /context.*window/i,
  /token.*limit.*exceeded/i,

  // Generic
  /context.*overflow/i,
  /too many tokens/i,
  /input.*length.*exceeded/i,
  /max.*context/i,
  /request.*too.*large/i,
];

/**
 * Test whether an error message indicates a context-window overflow
 * from any supported provider.
 */
export function isContextOverflow(errorMessage: string): boolean {
  if (!errorMessage) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
}
