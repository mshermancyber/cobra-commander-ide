// forked from core/circuit-breaker.ts @ 2026-07-04 — DOWNSTREAM fork, do not backport to core

/**
 * Circuit breaker states:
 *   closed   — Normal operation; requests flow through.
 *   open     — Paused; all dispatch is blocked.
 *   half-open — Testing one request to see if the system has recovered.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

type StateChangeCallback = (from: CircuitState, to: CircuitState) => void;

/**
 * Circuit breaker for Destro — agent loop calls recordFailure / recordSuccess
 * directly (no event bus dependency).
 *
 * After 3 *consecutive* failures (without an intervening success), the
 * breaker opens and pauses all dispatch for 5 minutes. After that interval
 * it transitions to half-open — a single request is allowed through as a
 * probe. If that request succeeds the breaker resets to closed; if it fails
 * the breaker re-opens for another 5-minute cooldown.
 */
export class DestroCircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly threshold = 3;
  private readonly cooldownMs = 5 * 60 * 1000; // 5 minutes
  private changeListeners: StateChangeCallback[] = [];

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Whether the breaker is currently open (dispatch should be paused). */
  isOpen(): boolean {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.transition('half-open');
        this.probeInFlight = true;
        return false; // admit exactly one probe
      }
      return true;
    }
    if (this.state === 'half-open') {
      // Only the first probe is admitted; block the rest until it resolves,
      // otherwise parallel dispatch floods a still-broken API.
      if (this.probeInFlight) return true;
      this.probeInFlight = true;
      return false;
    }
    return false;
  }

  /** Record a failure (e.g., exhausted retry). May open the breaker. */
  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.state === 'half-open') {
      // Probe failed — re-open.
      this.transition('open');
      return;
    }
    if (this.consecutiveFailures >= this.threshold) {
      this.transition('open');
    }
  }

  /** Record a success. Resets the breaker to closed. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state !== 'closed') {
      this.transition('closed');
    }
  }

  /** Register a callback invoked on every state change. */
  onStateChange(cb: StateChangeCallback): () => void {
    this.changeListeners.push(cb);
    return () => {
      const idx = this.changeListeners.indexOf(cb);
      if (idx !== -1) this.changeListeners.splice(idx, 1);
    };
  }

  /** Current state. */
  get currentState(): CircuitState {
    return this.state;
  }

  /** Number of consecutive failures since last success. */
  get failures(): number {
    return this.consecutiveFailures;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private transition(to: CircuitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    if (to === 'open') {
      this.openedAt = Date.now();
    }
    if (to === 'open' || to === 'closed') {
      this.probeInFlight = false; // ready for the next probe / normal flow
    }
    for (const cb of this.changeListeners) {
      try { cb(from, to); } catch { /* best-effort */ }
    }
  }
}

/** Singleton Destro circuit breaker instance. */
export const destroCircuitBreaker = new DestroCircuitBreaker();
