// Destro agent — learned remediations JSON store. Created 2026-07-04.
// Lazy-loads a JSON file of past incident fixes, queryable by service + failure signature.
// Write-through on record: every recordRemediation() call flushes to disk.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** A single recorded remediation attempt for a given failure signature. */
export interface RemediationEntry {
  /** Human-readable diagnosis of the failure. */
  diagnosis: string;
  /** What was done to fix it. */
  fix: string;
  /** Did this remediation actually work? */
  outcome: 'success' | 'failure';
  /** Unix timestamp (milliseconds) of when this was recorded. */
  ts: number;
}

/** A recorded dead-end: a fix approach that was tried and failed. */
export interface FailedAttempt {
  /** Service name (e.g. "nginx", "api-gateway"). */
  service: string;
  /** Normalized failure signature this attempt was targeting. */
  failureSignature: string;
  /** What was attempted as a fix. */
  attemptedFix: string;
  /** Why it failed (verification verdict, revert reason, etc.). */
  whyFailed: string;
  /** Unix timestamp (milliseconds). */
  ts: number;
}

/**
 * The on-disk shape of learned_remediations.json.
 * Keys are `"service::signature"` — the normalized form of a service name and
 * failure signature joined by `::`.
 */
type RemediationStore = Record<string, RemediationEntry[]>;

/**
 * The on-disk shape of failed_attempts.json.
 * Flat array of failed attempts, newest-first.
 */
type FailedAttemptsStore = FailedAttempt[];

// ──────────────────────────────────────────────
// Data Directory
// ──────────────────────────────────────────────

function getDataDir(): string {
  if (process.env.CC_HOME) {
    return join(process.env.CC_HOME, 'data');
  }
  return join(import.meta.dirname, 'data');
}

function getStorePath(): string {
  return join(getDataDir(), 'learned_remediations.json');
}

function getFailedAttemptsPath(): string {
  return join(getDataDir(), 'failed_attempts.json');
}

// ──────────────────────────────────────────────
// In-Memory Store (Lazy-Loaded)
// ──────────────────────────────────────────────

let store: RemediationStore | null = null;
let loaded = false;

/**
 * Load the remediation store from disk. Safe to call multiple times —
 * only loads once (lazy-load on first access).
 */
async function ensureLoaded(): Promise<void> {
  if (loaded) return;

  const storePath = getStorePath();

  try {
    const raw = await fs.readFile(storePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      store = parsed as RemediationStore;
    } else {
      store = {};
    }
  } catch {
    // File doesn't exist yet or is unreadable — start fresh
    store = {};
  }

  loaded = true;
}

/**
 * Write the current in-memory store to disk.
 * Creates the data directory if it doesn't exist.
 */
async function persist(): Promise<void> {
  const storePath = getStorePath();
  const dataDir = getDataDir();

  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // Best-effort — if we can't persist, we still serve from memory
  }
}

// ──────────────────────────────────────────────
// Failed Attempts Store (Lazy-Loaded)
// ──────────────────────────────────────────────

let failedStore: FailedAttemptsStore | null = null;
let failedLoaded = false;

async function ensureFailedLoaded(): Promise<void> {
  if (failedLoaded) return;

  const storePath = getFailedAttemptsPath();

  try {
    const raw = await fs.readFile(storePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      failedStore = parsed as FailedAttemptsStore;
    } else {
      failedStore = [];
    }
  } catch {
    failedStore = [];
  }

  failedLoaded = true;
}

async function persistFailed(): Promise<void> {
  const storePath = getFailedAttemptsPath();
  const dataDir = getDataDir();

  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(failedStore, null, 2), 'utf-8');
  } catch {
    // Best-effort
  }
}

// ──────────────────────────────────────────────
// Signature Normalization
// ──────────────────────────────────────────────

/**
 * Normalize a failure signature for consistent lookup.
 *
 * - Lowercases
 * - Collapses whitespace (multiple spaces → single space)
 * - Trims leading/trailing whitespace
 * - Truncates to 200 characters
 */
export function normalizeSignature(sig: string): string {
  return sig
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Query the incident memory for known remediations matching a service and
 * failure signature.
 *
 * Performs a **substring match** against stored keys — the normalized
 * `service::signature` only needs to appear *within* a stored key.
 * Results are sorted by recency (newest first).
 *
 * @param service          - Service name (e.g. "nginx", "api-gateway")
 * @param failureSignature - Failure description or error message
 * @returns Matching RemediationEntry array, sorted newest-first
 */
export async function queryIncidentMemory(
  service: string,
  failureSignature: string,
): Promise<RemediationEntry[]> {
  await ensureLoaded();

  if (!store) return [];

  const normalized = normalizeSignature(`${service}::${failureSignature}`);
  const results: RemediationEntry[] = [];

  for (const [key, entries] of Object.entries(store)) {
    // Substring match: normalized query appears anywhere in the key
    if (key.includes(normalized)) {
      results.push(...entries);
    }
    // Also try reverse: stored key appears in the normalized query
    else if (normalized.includes(key)) {
      results.push(...entries);
    }
  }

  // Sort by recency (newest first)
  results.sort((a, b) => b.ts - a.ts);

  return results;
}

/**
 * Record a remediation attempt in the incident memory.
 *
 * Appends the entry to the in-memory store and writes through to disk
 * immediately. The store key is `normalizeSignature(service)::normalizeSignature(failureSignature)`.
 *
 * @param service          - Service name
 * @param failureSignature - Failure description or error message
 * @param entry            - The remediation entry to record
 */
export async function recordRemediation(
  service: string,
  failureSignature: string,
  entry: RemediationEntry,
): Promise<void> {
  await ensureLoaded();

  if (!store) store = {};

  const key = `${normalizeSignature(service)}::${normalizeSignature(failureSignature)}`;

  if (!store[key]) {
    store[key] = [];
  }

  store[key].push(entry);

  // Write-through to disk
  await persist();
}

/**
 * Get all known failure signatures for a given service.
 *
 * @param service - Service name
 * @returns Array of signature strings (the part after "service::")
 */
export async function listServiceSignatures(
  service: string,
): Promise<string[]> {
  await ensureLoaded();

  if (!store) return [];

  const normalizedService = normalizeSignature(service);
  const signatures: string[] = [];

  for (const key of Object.keys(store)) {
    const [svc, ...rest] = key.split('::');
    if (svc === normalizedService) {
      signatures.push(rest.join('::'));
    }
  }

  return signatures;
}

/**
 * Clear all incident memory (in-memory and on-disk).
 * Useful for testing or resetting.
 */
export async function clearIncidentMemory(): Promise<void> {
  store = {};

  try {
    await fs.unlink(getStorePath());
  } catch {
    // File may not exist — fine
  }
}

/**
 * Force a reload from disk on the next access.
 */
export function invalidateCache(): void {
  loaded = false;
  store = null;
}

// ──────────────────────────────────────────────
// Failed Attempts API
// ──────────────────────────────────────────────

/**
 * Record a failed fix attempt so future sessions can avoid retrying dead ends.
 *
 * @param attempt - The failed attempt to record
 */
export async function recordFailedAttempt(
  attempt: FailedAttempt,
): Promise<void> {
  await ensureFailedLoaded();

  if (!failedStore) failedStore = [];

  failedStore.push(attempt);

  // Keep most recent 200 entries
  if (failedStore.length > 200) {
    failedStore = failedStore.slice(-200);
  }

  await persistFailed();
}

/**
 * Query failed attempts matching a service and failure signature.
 * Uses normalized substring matching (same as queryIncidentMemory).
 *
 * @param service          - Service name
 * @param failureSignature - Failure description or error message
 * @returns Matching FailedAttempt array, sorted newest-first
 */
export async function queryFailedAttempts(
  service: string,
  failureSignature: string,
): Promise<FailedAttempt[]> {
  await ensureFailedLoaded();

  if (!failedStore || failedStore.length === 0) return [];

  const normalizedSvc = normalizeSignature(service);
  const normalizedSig = normalizeSignature(failureSignature);

  const results = failedStore.filter(a => {
    const svcMatch =
      normalizeSignature(a.service).includes(normalizedSvc) ||
      normalizedSvc.includes(normalizeSignature(a.service));
    const sigMatch =
      normalizeSignature(a.failureSignature).includes(normalizedSig) ||
      normalizedSig.includes(normalizeSignature(a.failureSignature));
    return svcMatch && sigMatch;
  });

  results.sort((a, b) => b.ts - a.ts);

  return results;
}

/**
 * Clear all failed attempts (in-memory and on-disk).
 * Useful for testing.
 */
export async function clearFailedAttempts(): Promise<void> {
  failedStore = [];

  try {
    await fs.unlink(getFailedAttemptsPath());
  } catch {
    // File may not exist — fine
  }
}

/**
 * Force a reload of failed attempts on the next access.
 */
export function invalidateFailedCache(): void {
  failedLoaded = false;
  failedStore = null;
}
