// Destro agent — durable session. Created 2026-07-04.

import {
  DestroMessage,
  collapseDestroSession,
  DESTRO_MAX_CONTEXT_CHARS,
  capDestroContent,
  estimateDestroSessionChars,
} from './destro-context.js';

const KEEP_LAST_TURNS = 6;

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface ActionLedgerEntry {
  tool: string;
  args: string;
  outcome: string;
  ts: number;
}

export interface SteerMessage {
  from: string;
  message: string;
  ts: number;
}

export interface DestroSessionState {
  id: string;
  messages: DestroMessage[];
  incidentSummary: string;
  actionsLedger: ActionLedgerEntry[];
  contextFiles: string[];
  createdAt: number;
  lastActiveAt: number;
  status: 'active' | 'paused' | 'closed' | 'escalated';
  abortFlag: boolean;
  steerQueue: SteerMessage[];
}

// ──────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────

export function createDestroSession(id: string): DestroSessionState {
  const now = Date.now();
  return {
    id,
    messages: [],
    incidentSummary: '',
    actionsLedger: [],
    contextFiles: [],
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    abortFlag: false,
    steerQueue: [],
  };
}

// ──────────────────────────────────────────────
// Message helpers
// ──────────────────────────────────────────────

export function appendMessage(session: DestroSessionState, message: DestroMessage): void {
  session.messages.push(message);
  session.lastActiveAt = Date.now();
}

export function appendToolResult(
  session: DestroSessionState,
  toolUseId: string,
  name: string,
  result: string,
  isError: boolean,
): void {
  const msg: DestroMessage = {
    role: 'tool',
    content: result,
    tool_use_id: toolUseId,
    name,
    is_error: isError,
  };
  session.messages.push(msg);
  session.lastActiveAt = Date.now();
}

// ──────────────────────────────────────────────
// Abort flag
// ──────────────────────────────────────────────

export function setAbortFlag(session: DestroSessionState): void {
  session.abortFlag = true;
}

export function checkAbortFlag(session: DestroSessionState): boolean {
  return session.abortFlag;
}

// ──────────────────────────────────────────────
// Steer queue
// ──────────────────────────────────────────────

export function appendSteerMessage(
  session: DestroSessionState,
  from: string,
  message: string,
): void {
  session.steerQueue.push({ from, message, ts: Date.now() });
}

export function drainSteerMessages(session: DestroSessionState): SteerMessage[] {
  const drained = session.steerQueue.slice();
  session.steerQueue.length = 0;
  return drained;
}

// ──────────────────────────────────────────────
// Token estimate
// ──────────────────────────────────────────────

export function estimateSessionTokens(session: DestroSessionState): number {
  const msgChars = estimateDestroSessionChars(session.messages);
  const summaryChars = session.incidentSummary.length;
  const ledgerChars = JSON.stringify(session.actionsLedger).length;
  return Math.ceil((msgChars + summaryChars + ledgerChars) / 4);
}

// ──────────────────────────────────────────────
// Autocompact
// ──────────────────────────────────────────────

function isToolMessage(m: DestroMessage): boolean {
  return m.role === 'tool' || m.role === 'tool_result' || !!m.tool_use_id;
}

function isAssistantWithTools(m: DestroMessage): boolean {
  if (m.role !== 'assistant') return false;
  return !!(m as any).tool_calls || !!(m as any).tool_use || isToolMessage(m);
}

function extractActionLedger(messages: DestroMessage[]): ActionLedgerEntry[] {
  const ledger: ActionLedgerEntry[] = [];
  const toolResults = new Map<string, { result: string; isError: boolean }>();

  // Collect tool results first
  for (const m of messages) {
    if (isToolMessage(m) && (m as any).tool_use_id) {
      const id = (m as any).tool_use_id as string;
      toolResults.set(id, {
        result: capDestroContent(typeof m.content === 'string' ? m.content : '', 200),
        isError: !!(m as any).is_error,
      });
    }
  }

  // Extract tool calls from assistant messages
  for (const m of messages) {
    if (m.role !== 'assistant') continue;

    const toolCalls = (m as any).tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: string } }> | undefined;
    if (toolCalls && Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const id = tc.id || '';
        const name = tc.function?.name || 'unknown';
        const args = capDestroContent(tc.function?.arguments || '', 500);
        const tr = toolResults.get(id);
        ledger.push({
          tool: name,
          args,
          outcome: tr ? (tr.isError ? 'ERROR' : 'OK') : 'UNKNOWN',
          ts: Date.now(),
        });
      }
    }
  }

  return ledger;
}

function extractIncidentSummary(messages: DestroMessage[]): string {
  // First user message is the incident trigger
  const firstUser = messages.find(m => m.role === 'user');
  const trigger = firstUser && typeof firstUser.content === 'string'
    ? capDestroContent(firstUser.content, 2000)
    : '';

  // Key findings: scan for error/exception/failure patterns in assistant/tool messages
  const errorPatterns: string[] = [];
  for (const m of messages) {
    if (typeof m.content !== 'string') continue;
    const lower = m.content.toLowerCase();
    if (
      lower.includes('error') ||
      lower.includes('exception') ||
      lower.includes('failed') ||
      lower.includes('failure') ||
      lower.includes('cannot') ||
      lower.includes('unable to') ||
      lower.includes('timeout') ||
      lower.includes('refused') ||
      lower.includes('not found')
    ) {
      const snippet = capDestroContent(m.content, 300);
      if (!errorPatterns.includes(snippet)) {
        errorPatterns.push(snippet);
      }
    }
  }

  const findings = errorPatterns.slice(0, 5)
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n');

  let summary = '';
  if (trigger) summary += `## Incident\n${trigger}\n`;
  if (findings) summary += `\n## Key Findings\n${findings}\n`;

  return summary.trim();
}

/**
 * Autocompact a session to stay under the character budget.
 *
 * 1. First tries collapseDestroSession on messages.
 * 2. If still over budget, compresses old turns into incidentSummary + actionsLedger,
 *    keeping the last KEEP_LAST_TURNS messages intact.
 * 3. R3 §4: Pinned hypotheses (falsified/confirmed) are extracted from ALL messages
 *    before compaction and preserved in the ledger regardless of age.
 *
 * Returns a new session object — does not mutate the input.
 */
export function autocompactSession(
  session: DestroSessionState,
  maxChars: number = DESTRO_MAX_CONTEXT_CHARS,
): DestroSessionState {
  // R3 §4: Extract pinned hypotheses from ALL messages before collapse
  const pinnedHypotheses = extractPinnedHypotheses(session.messages);

  const collapsed = collapseDestroSession(session.messages, maxChars);
  const charCount = estimateDestroSessionChars(collapsed);

  if (charCount <= maxChars) {
    // Merge pinned hypotheses into ledger even when no compression needed
    const mergedLedger = mergePinnedHypotheses(session.actionsLedger, pinnedHypotheses);
    return { ...session, messages: collapsed, actionsLedger: mergedLedger };
  }

  // Still over budget — compress old turns into summary + ledger
  const keepCount = Math.min(KEEP_LAST_TURNS, collapsed.length);
  const recent = collapsed.slice(-keepCount);
  const old = collapsed.slice(0, -keepCount);

  if (old.length === 0) {
    // Can't compress further — just keep recent messages trimmed
    const mergedLedger = mergePinnedHypotheses(session.actionsLedger, pinnedHypotheses);
    return { ...session, messages: recent, actionsLedger: mergedLedger };
  }

  const incidentSummary = extractIncidentSummary(old);
  const actionsLedger = mergePinnedHypotheses(
    [
      ...session.actionsLedger,
      ...extractActionLedger(old),
    ],
    pinnedHypotheses,
  );

  return {
    ...session,
    messages: recent,
    incidentSummary: incidentSummary || session.incidentSummary,
    actionsLedger,
  };
}

/**
 * R3 §4: Extract hypothesis entries (falsified/confirmed) from messages.
 * These must survive compaction no matter how old.
 */
function extractPinnedHypotheses(messages: DestroMessage[]): ActionLedgerEntry[] {
  const hypotheses: ActionLedgerEntry[] = [];

  for (const m of messages) {
    if (m.role !== 'assistant') continue;

    const toolCalls = (m as any).tool_calls as Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }> | undefined;

    if (!toolCalls || !Array.isArray(toolCalls)) continue;

    for (const tc of toolCalls) {
      if (tc.function?.name !== 'record_hypothesis') continue;

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}') as Record<string, unknown>;
      } catch { continue; }

      const status = (args.status as string) || 'open';
      if (status !== 'falsified' && status !== 'confirmed') continue;

      hypotheses.push({
        tool: 'hypothesis',
        args: capDestroContent((args.text as string) || '', 500),
        outcome: status,
        ts: Date.now(),
      });
    }
  }

  return hypotheses;
}

/**
 * R3 §4: Merge pinned hypotheses into the ledger, deduplicating by args text.
 * Pinned hypotheses are always retained even if the original message was trimmed.
 */
function mergePinnedHypotheses(
  ledger: ActionLedgerEntry[],
  hypotheses: ActionLedgerEntry[],
): ActionLedgerEntry[] {
  if (hypotheses.length === 0) return ledger;

  const existingTexts = new Set(ledger.filter(e => e.tool === 'hypothesis').map(e => e.args));
  const toAdd = hypotheses.filter(h => !existingTexts.has(h.args));

  return [...ledger, ...toAdd];
}

// ──────────────────────────────────────────────
// Context builder
// ──────────────────────────────────────────────

function formatLedgerTable(ledger: ActionLedgerEntry[]): string {
  if (ledger.length === 0) return '';
  let table = '| # | Tool | Args | Outcome |\n| --- | --- | --- | --- |\n';
  for (let i = 0; i < ledger.length; i++) {
    const e = ledger[i];
    table += `| ${i + 1} | ${e.tool} | ${e.args.slice(0, 100)} | ${e.outcome} |\n`;
  }
  return table;
}

function formatMessages(messages: DestroMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const role = m.role.toUpperCase();
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    parts.push(`[${role}]\n${content}`);
  }
  return parts.join('\n\n');
}

/**
 * Compose the full context string for the next LLM turn.
 * Includes incident summary, actions ledger, drained steer messages,
 * and the collapsed messages.
 */
export function buildSessionContext(session: DestroSessionState): string {
  const sections: string[] = [];

  // 1. Incident summary
  if (session.incidentSummary) {
    sections.push(`## Incident Summary\n${session.incidentSummary}`);
  }

  // 2. Actions ledger
  if (session.actionsLedger.length > 0) {
    sections.push(`## Actions Ledger\n${formatLedgerTable(session.actionsLedger)}`);
  }

  // 3. Context files
  if (session.contextFiles.length > 0) {
    sections.push(`## Project Context Files\n${session.contextFiles.map(f => `- ${f}`).join('\n')}`);
  }

  // 4. Drain steer messages
  const steers = drainSteerMessages(session);
  if (steers.length > 0) {
    const steerText = steers
      .map(s => `[${s.from} @ ${new Date(s.ts).toISOString()}] ${s.message}`)
      .join('\n');
    sections.push(`## ⚠️ Interrupt Messages\n${steerText}`);
  }

  // 5. Session messages
  if (session.messages.length > 0) {
    sections.push(`## Conversation\n${formatMessages(session.messages)}`);
  }

  return sections.join('\n\n');
}
