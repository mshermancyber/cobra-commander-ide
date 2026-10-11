/**
 * Context Compaction — Prune old tool outputs to free space when a worker
 * approaches its context limit. Prevents hitting context-window ceilings
 * that would otherwise truncate the most recent (and most important) turns.
 *
 * Token estimates use the chars/4 heuristic (rough, but fast and zero-cost).
 */

import { isContextOverflow } from './context-overflow.js';
import { buildCompactionPrompt } from './compaction-template.js';

export interface CompactableMessage {
  role: string;
  content?: string | null;
  [key: string]: unknown;
}

export interface CompactResult {
  messages: CompactableMessage[];
  compacted: boolean;
  freedChars: number;
}

const DEFAULT_MAX_TOKENS = 60_000;
const USAGE_RATIO = 0.8;
const CHARS_PER_TOKEN = 4;

const PROTECTED_TURNS = 3;
const PROTECTED_MESSAGES = PROTECTED_TURNS * 2; // assistant + tool per turn

const TOOL_CONTENT_MAX = 2000;
const TOOL_CONTENT_PREVIEW = 200;

const CODE_BLOCK_MAX = 1000;
const CODE_BLOCK_PREVIEW = 200;

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Estimate total token count from messages (chars / 4 heuristic).
 * Returns true when estimated tokens exceed `usageRatio` of `maxTokens`.
 */
export function shouldCompact(
  messages: CompactableMessage[],
  maxTokens: number = DEFAULT_MAX_TOKENS,
): boolean {
  const totalChars = messages.reduce((sum, m) => {
    const c = typeof m.content === 'string' ? m.content : '';
    return sum + c.length;
  }, 0);
  const estimatedTokens = totalChars / CHARS_PER_TOKEN;
  return estimatedTokens > maxTokens * USAGE_RATIO;
}

/**
 * Walk backwards through messages and compact older tool outputs
 * and large code blocks in assistant messages.
 *
 * The most recent `PROTECTED_MESSAGES` messages are left untouched.
 * All other messages are candidates for compaction.
 */
export function compactMessages(
  messages: CompactableMessage[],
): CompactableMessage[] {
  if (messages.length <= PROTECTED_MESSAGES) {
    // Always a new array: callers clear their array in place and re-push the result,
    // so returning the same reference emptied the conversation (workers lost their task).
    return [...messages];
  }

  const protectIndex = messages.length - PROTECTED_MESSAGES;
  const compacted = messages.map((msg, idx) => {
    if (idx >= protectIndex) return msg; // keep recent messages intact

    if (msg.role === 'tool' || msg.role === 'user') {
      return compactToolContent(msg);
    }

    if (msg.role === 'assistant') {
      return compactCodeBlocks(msg);
    }

    return msg;
  });

  return compacted;
}

/**
 * Full compaction flow: check if compaction is needed, apply it,
 * and return the result with stats.
 */
export function compactConversation(
  messages: CompactableMessage[],
  maxTokens: number = DEFAULT_MAX_TOKENS,
): CompactResult {
  if (!shouldCompact(messages, maxTokens)) {
    return { messages, compacted: false, freedChars: 0 };
  }

  // Count chars before
  const before = totalChars(messages);

  const compacted = compactMessages(messages);

  // Count chars after
  const after = totalChars(compacted);

  return {
    messages: compacted,
    compacted: true,
    freedChars: Math.max(0, before - after),
  };
}

export interface CompactWithSummaryResult {
  messages: Array<{ role: string; content: string }>;
  compacted: boolean;
  summary?: string;
}

const TAIL_MESSAGES_COUNT = 6;

/**
 * LLM-based compaction: summarizes older messages using a provided summarize
 * callback, preserving only the most recent messages verbatim.
 *
 * @param messages      The full conversation history.
 * @param summarize     A callback that takes a prompt string and returns a summary.
 * @param maxTokens     Token limit for triggering compaction.
 * @returns Compacted messages with a summary prefix, or unchanged if below threshold.
 */
export async function compactWithSummary(
  messages: Array<{ role: string; content: string }>,
  summarize: (prompt: string) => Promise<string>,
  maxTokens?: number,
): Promise<CompactWithSummaryResult> {
  if (!shouldCompact(messages, maxTokens)) {
    return { messages, compacted: false };
  }

  // Split into head (to summarize) and tail (to preserve)
  const splitIndex = Math.max(0, messages.length - TAIL_MESSAGES_COUNT);
  const head = messages.slice(0, splitIndex);
  const tail = messages.slice(splitIndex);

  // If head is empty, nothing to summarize
  if (head.length === 0) {
    return { messages, compacted: false };
  }

  const prompt = buildCompactionPrompt(head);
  const summary = await summarize(prompt);

  const compactedMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: `Previous context summary:\n${summary}` },
    ...tail,
  ];

  return { messages: compactedMessages, compacted: true, summary };
}

/**
 * Handle a potential context-overflow error by compacting messages if the
 * error matches known overflow patterns. Returns recovered: true if
 * compaction was applied, false if the error is unrelated.
 */
export function handleOverflowError(
  error: Error | string,
  messages: Array<{ role: string; content: string }>,
): { messages: Array<{ role: string; content: string }>; recovered: boolean } {
  const errorMessage = typeof error === 'string' ? error : error.message;
  if (!isContextOverflow(errorMessage)) {
    return { messages, recovered: false };
  }
  const compacted = compactMessages(messages);
  return { messages: compacted as Array<{ role: string; content: string }>, recovered: true };
}

const DEFAULT_TAIL_BUDGET_TOKENS = 8000;
const MIN_FREE_TOKENS = 5000;

interface TokenBudgetMessage {
  role: string;
  content: string;
  isError?: boolean;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export async function compactByTokenBudget(
  messages: TokenBudgetMessage[],
  summarize: (prompt: string) => Promise<string>,
  tailBudgetTokens: number = DEFAULT_TAIL_BUDGET_TOKENS,
): Promise<CompactWithSummaryResult> {
  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(m.content || ''),
    0,
  );

  if (totalTokens < tailBudgetTokens + MIN_FREE_TOKENS) {
    return { messages, compacted: false };
  }

  // Walk backwards to find tail split point based on token budget
  let tailTokens = 0;
  let splitIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i].content || '');
    if (tailTokens + msgTokens > tailBudgetTokens) break;
    tailTokens += msgTokens;
    splitIndex = i;
  }

  // Pull error messages into tail even if they're above the budget split
  while (splitIndex > 0 && messages[splitIndex - 1].isError) {
    splitIndex--;
  }

  if (splitIndex <= 0) {
    return { messages, compacted: false };
  }

  const head = messages.slice(0, splitIndex);
  const tail = messages.slice(splitIndex);

  const headTokens = head.reduce(
    (sum, m) => sum + estimateTokens(m.content || ''),
    0,
  );
  if (headTokens < MIN_FREE_TOKENS) {
    return { messages, compacted: false };
  }

  const prompt = buildCompactionPrompt(head);
  const summary = await summarize(prompt);

  const compactedMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: `Previous context summary:\n${summary}` },
    ...tail,
  ];

  return { messages: compactedMessages, compacted: true, summary };
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

function totalChars(messages: CompactableMessage[]): number {
  return messages.reduce((sum, m) => {
    return sum + (typeof m.content === 'string' ? m.content.length : 0);
  }, 0);
}

function compactToolContent(msg: CompactableMessage): CompactableMessage {
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (!content || content.length <= TOOL_CONTENT_MAX) return msg;

  // Detect tool-like prefixes common in the codebase
  const isToolResult =
    msg.role === 'tool' ||
    content.startsWith('[ok]') ||
    content.startsWith('[tool]');

  if (!isToolResult && msg.role !== 'tool') return msg;

  const preview = content.slice(0, TOOL_CONTENT_PREVIEW);
  const compactedContent = `${preview}\n...[compacted — was ${content.length} chars]`;

  return { ...msg, content: compactedContent };
}

/**
 * Find triple-backtick code blocks in assistant messages and truncate
 * any block whose body exceeds CODE_BLOCK_MAX characters.
 */
function compactCodeBlocks(msg: CompactableMessage): CompactableMessage {
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (!content) return msg;

  // Match fenced code blocks: ```lang\n...\n```
  const fenceRegex = /```(\w*\n?[\s\S]*?)```/g;

  let match: RegExpExecArray | null;
  let modified = false;
  let result = content;

  // Collect all matches first so replacements don't shift indices
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  while ((match = fenceRegex.exec(content)) !== null) {
    const fullMatch = match[0]; // the entire ```…``` block including fences
    const bodyStart = match[0].indexOf('\n') + 1;
    const bodyEnd = fullMatch.length - 3; // before closing ```
    const body = fullMatch.slice(bodyStart, bodyEnd);
    const langLine = fullMatch.slice(3, bodyStart); // e.g. "typescript\n"

    if (body.length > CODE_BLOCK_MAX) {
      const shortBody = body.slice(0, CODE_BLOCK_PREVIEW);
      const compactedBlock = `\`\`\`${langLine}${shortBody}\n...[code block compacted]\n\`\`\``;
      replacements.push({
        start: match.index,
        end: match.index + fullMatch.length,
        replacement: compactedBlock,
      });
    }
  }

  if (replacements.length === 0) return msg;

  // Apply replacements in reverse order to preserve indices
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }

  return { ...msg, content: result };
}
