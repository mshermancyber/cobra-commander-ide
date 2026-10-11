// Destro agent — session-store. Created 2026-07-04.

export const MAX_RESUMES = 3;

/** A session is considered stale after 60 seconds without a heartbeat. */
const DEFAULT_STALE_THRESHOLD_MS = 60_000;

export type DestroSessionStatus =
  | 'active'
  | 'stale'
  | 'closed'
  | 'failed'
  | 'escalated';

export interface DestroSession {
  id: string;
  status: DestroSessionStatus;
  resumeCount: number;
  lastHeartbeat: number;
  createdAt: number;
  ledger: unknown[];
}

const sessions = new Map<string, DestroSession>();

/**
 * Create a new session (inactive by default). Activate before use.
 */
export function createSession(id: string): DestroSession {
  const session: DestroSession = {
    id,
    status: 'stale',
    resumeCount: 0,
    lastHeartbeat: Date.now(),
    createdAt: Date.now(),
    ledger: [],
  };
  sessions.set(id, session);
  return session;
}

/**
 * Mark a session as active.
 */
export function activateSession(id: string): DestroSession {
  const s = sessions.get(id);
  if (!s) throw new Error(`Session ${id} not found`);
  s.status = 'active';
  s.lastHeartbeat = Date.now();
  return s;
}

/**
 * Record a heartbeat (and optionally append a ledger entry).
 */
export function heartbeatSession(id: string, ledgerEntry?: unknown): void {
  const s = sessions.get(id);
  if (!s) throw new Error(`Session ${id} not found`);
  s.lastHeartbeat = Date.now();
  if (ledgerEntry !== undefined) {
    s.ledger.push(ledgerEntry);
  }
}

/**
 * Close a session gracefully.
 */
export function closeSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s.status = 'closed';
}

/**
 * Retrieve a session by id.
 */
export function getSession(id: string): DestroSession | undefined {
  return sessions.get(id);
}

/**
 * Fail a session loudly — marks it as escalated (or failed if no
 * escalation path is available). Called when MAX_RESUMES is exceeded.
 */
export function failLoudSession(id: string): DestroSession {
  const s = sessions.get(id);
  if (!s) throw new Error(`Session ${id} not found`);
  s.status = s.resumeCount > MAX_RESUMES ? 'escalated' : 'failed';
  return s;
}

/**
 * Reconcile all sessions: detect stale sessions, requeue (increment
 * resumeCount) or failLoud if MAX_RESUMES is exceeded.
 *
 * @param staleThresholdMs — override the default staleness threshold
 * @returns counts of resumed and failed-loud sessions
 */
export function reconcileSessions(
  staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
): { resumed: number; failed: number } {
  const now = Date.now();
  let resumed = 0;
  let failed = 0;

  for (const [, s] of sessions) {
    if (s.status !== 'active') continue;
    if (now - s.lastHeartbeat < staleThresholdMs) continue;

    // Stale session detected
    s.resumeCount++;
    if (s.resumeCount > MAX_RESUMES) {
      failLoudSession(s.id);
      failed++;
    } else {
      s.status = 'stale';
      s.lastHeartbeat = now; // reset heartbeat so it can be picked up
      resumed++;
    }
  }

  return { resumed, failed };
}

/**
 * Clear the in-memory session store (for testing).
 */
export function clearSessions(): void {
  sessions.clear();
}
