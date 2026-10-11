import { listOrganizations, touchOrganization, type Organization } from '../models/org-finding.js';
import { ALL_COLLECTORS, type CollectorDef } from '../collectors/org-scanner.js';
import { triageOrgFinding } from '../ai/org-triage.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CollectorProgress {
  name: string;
  label: string;
  findings: number;
  orgsHit: number;
  triaged: number;
  errors: string[];
  durationMs: number;
  completedAt: number;
}

export interface SchedulerStatus {
  running: boolean;
  cycleIntervalMs: number;
  staggerIntervalMs: number;
  collectorCount: number;
  orgCount: number;
  currentCollectorIndex: number;
  currentCollectorName: string | null;
  currentOrgName: string | null;
  lastCollectorProgress: CollectorProgress | null;
  lastScanTime: number | null;
  nextScanTime: number | null;
  cycleStartTime: number | null;
  totalScansCompleted: number;
  totalFindingsCreated: number;
  totalTriaged: number;
  errors: string[];
}

// ─── Module State ──────────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;
let stopped = false;

const CYCLE_INTERVAL_MS = 3_600_000; // 1 hour

let orgs: Organization[] = [];
let currentCollectorIndex = 0;
let currentCollectorName: string | null = null;
let currentOrgName: string | null = null;
let staggerIntervalMs = 60_000; // default 1 min
let cycleStartTime: number | null = null;

let lastCollectorProgress: CollectorProgress | null = null;
let lastScanTime: number | null = null;
let nextScanTime: number | null = null;
let totalScansCompleted = 0;
let totalFindingsCreated = 0;
let totalTriaged = 0;
const recentErrors: string[] = [];

const MAX_ERRORS = 20;

// ─── Logging ───────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[scan-scheduler ${ts}] ${msg}`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString();
  console.error(`[scan-scheduler ${ts}] ERROR: ${msg}`);
  recentErrors.push(`${ts}: ${msg}`);
  if (recentErrors.length > MAX_ERRORS) {
    recentErrors.shift();
  }
}

// ─── Core Logic ────────────────────────────────────────────────────────────

/**
 * Run a single collector across ALL monitored orgs.
 *
 * For each org:
 *   1. Call collector.fn(org)
 *   2. Persist each finding via createOrgFinding (already done inside fn)
 *   3. Immediately triage each new finding via triageOrgFinding()
 *
 * Errors are caught per-org so one failure doesn't stop the collector.
 */
async function runCollectorAcrossAllOrgs(collector: CollectorDef): Promise<CollectorProgress> {
  const startedAt = Date.now();
  const errors: string[] = [];
  let totalFindings = 0;
  let orgsHit = 0;
  let triaged = 0;

  log(`Collector "${collector.name}" starting across ${orgs.length} orgs...`);

  for (let i = 0; i < orgs.length; i++) {
    if (stopped) break;

    const org = orgs[i];
    currentOrgName = org.name;

    try {
      const findings = await collector.fn(org);

      if (findings.length > 0) {
        orgsHit++;
        totalFindings += findings.length;

        // Immediately triage every new finding
        for (const finding of findings) {
          try {
            triageOrgFinding(finding);
            triaged++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Triage failed for finding ${finding.id}: ${msg}`);
          }
        }

        // Update org last-scanned timestamp
        touchOrganization(org.id);
      }

      // Small delay between orgs to be polite to the search engine
      if (i < orgs.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Collector "${collector.name}" failed for ${org.name}: ${msg}`);
    }
  }

  totalFindingsCreated += totalFindings;
  totalTriaged += triaged;
  totalScansCompleted++;
  lastScanTime = Date.now();

  const durationMs = Date.now() - startedAt;

  log(
    `Collector "${collector.name}" complete: ` +
    `${totalFindings} findings across ${orgsHit} orgs, ` +
    `${triaged} triaged in ${(durationMs / 1000).toFixed(1)}s` +
    (errors.length > 0 ? ` (${errors.length} errors)` : ''),
  );

  const progress: CollectorProgress = {
    name: collector.name,
    label: collector.label,
    findings: totalFindings,
    orgsHit,
    triaged,
    errors,
    durationMs,
    completedAt: Date.now(),
  };

  lastCollectorProgress = progress;

  if (errors.length > 0) {
    for (const err of errors) {
      logError(`[${collector.name}] ${err}`);
    }
  }

  return progress;
}

/**
 * Advance to the next collector and schedule it after the stagger delay.
 */
function scheduleNextCollector(): void {
  if (stopped) return;

  const collectors = ALL_COLLECTORS;
  if (collectors.length === 0) return;

  if (currentCollectorIndex >= collectors.length) {
    // All collectors done this cycle
    log('All collectors completed this cycle.');
    currentCollectorIndex = 0;
    currentCollectorName = null;
    currentOrgName = null;
    return;
  }

  const collector = collectors[currentCollectorIndex];
  currentCollectorName = collector.name;
  nextScanTime = Date.now() + staggerIntervalMs;

  setTimeout(async () => {
    if (stopped) return;
    await runCollectorAcrossAllOrgs(collector);
    currentCollectorIndex++;
    scheduleNextCollector();
  }, staggerIntervalMs);
}

/**
 * Start a new scan cycle. Called at the top of each hour.
 */
async function startCycle(): Promise<void> {
  if (stopped) return;

  // Reload orgs from store (they may have been added/removed)
  orgs = listOrganizations();

  if (orgs.length === 0) {
    log('No organizations registered. Skipping scan cycle.');
    return;
  }

  // Recalculate stagger interval based on collector count
  const collectorCount = ALL_COLLECTORS.length;
  staggerIntervalMs = Math.max(
    5_000, // minimum 5 seconds between collectors
    Math.floor(CYCLE_INTERVAL_MS / collectorCount),
  );

  cycleStartTime = Date.now();
  currentCollectorIndex = 0;

  log(
    `Starting scan cycle: ${orgs.length} orgs × ${collectorCount} collectors, ` +
    `stagger=${(staggerIntervalMs / 1000).toFixed(1)}s per collector, ` +
    `cycle=${(CYCLE_INTERVAL_MS / 60000).toFixed(0)}min`,
  );

  scheduleNextCollector();
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Start the automated scan scheduler.
 *
 * Runs a scan cycle immediately on startup, then repeats every hour.
 * Within each cycle, every collector runs across all orgs with a stagger
 * delay between collectors to avoid flooding the search engine.
 *
 * Each finding is triaged immediately after creation so that only triaged
 * findings appear in API responses.
 *
 * Returns a teardown function that stops the scheduler.
 */
export function startScanScheduler(): () => void {
  if (running) {
    log('Scheduler already running.');
    return () => {};
  }

  running = true;
  stopped = false;

  // Load orgs
  orgs = listOrganizations();
  log(`Loaded ${orgs.length} organizations, ${ALL_COLLECTORS.length} collectors.`);

  // Run first cycle immediately
  startCycle().catch(err => {
    logError(`Initial cycle failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Schedule hourly cycles
  intervalHandle = setInterval(() => {
    startCycle().catch(err => {
      logError(`Cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, CYCLE_INTERVAL_MS);

  log(`Scan scheduler started (interval: ${CYCLE_INTERVAL_MS / 60000}min).`);

  return () => {
    stopped = true;
    running = false;
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    log('Scan scheduler stopped.');
  };
}

/**
 * Return a snapshot of the scheduler's current state.
 * Useful for monitoring and debugging via the API.
 */
export function getScanSchedulerStatus(): SchedulerStatus {
  return {
    running,
    cycleIntervalMs: CYCLE_INTERVAL_MS,
    staggerIntervalMs,
    collectorCount: ALL_COLLECTORS.length,
    orgCount: orgs.length,
    currentCollectorIndex,
    currentCollectorName,
    currentOrgName,
    lastCollectorProgress,
    lastScanTime,
    nextScanTime,
    cycleStartTime,
    totalScansCompleted,
    totalFindingsCreated,
    totalTriaged,
    errors: [...recentErrors],
  };
}
