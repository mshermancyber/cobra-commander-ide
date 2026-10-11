import { processRegistry } from './process-registry.js';
import { workerStore } from './worker-store.js';

interface WorkerJob {
  pid: number;
  jobType: string;
  command: string;
  startedAt: number;
}

const workerJobs = new Map<string, WorkerJob[]>();

/**
 * Register a job associated with a worker. Links the process ID, job type,
 * and command for later cancellation or inspection.
 */
export function registerWorkerJob(
  workerId: string,
  pid: number,
  jobType: string,
  command: string,
): void {
  const job: WorkerJob = {
    pid,
    jobType,
    command,
    startedAt: Date.now(),
  };

  const existing = workerJobs.get(workerId);
  if (existing) {
    existing.push(job);
  } else {
    workerJobs.set(workerId, [job]);
  }

  // Also record in the worker store for persistence
  workerStore.append({
    workerId,
    timestamp: Date.now(),
    type: 'tool',
    data: { pid, jobType, command },
  });
}

/**
 * Cancel all jobs of a given type for a specific worker.
 * Kills the associated processes (SIGTERM, then SIGKILL after 2s).
 */
export function cancelJobType(workerId: string, jobType: string): void {
  const jobs = workerJobs.get(workerId);
  if (!jobs) return;

  const matching = jobs.filter((j) => j.jobType === jobType);
  for (const job of matching) {
    try {
      process.kill(job.pid, 'SIGTERM');
    } catch {
      // Process already gone
    }
  }

  // Force-kill any survivors after a grace period
  if (matching.length > 0) {
    setTimeout(() => {
      for (const job of matching) {
        try {
          process.kill(job.pid, 0); // Check if alive
          process.kill(job.pid, 'SIGKILL');
        } catch {
          // Already dead
        }
      }
    }, 2000);
  }

  // Remove killed jobs from the tracking map
  workerJobs.set(
    workerId,
    (workerJobs.get(workerId) || []).filter((j) => j.jobType !== jobType),
  );

  // Clean up process registry
  processRegistry.cleanupDead();
}

/**
 * Get all active jobs for a worker.
 */
export function getWorkerJobs(
  workerId: string,
): Array<{ pid: number; jobType: string; command: string; startedAt: number }> {
  return workerJobs.get(workerId) || [];
}
