import { workerEvents } from './event-bus.js';

interface ActiveRun {
  workerId: string;
  startedAt: number;
}

interface FollowUp {
  task: string;
  context: string;
}

class RunCoordinator {
  private active = new Map<string, ActiveRun>();
  private followUps = new Map<string, FollowUp[]>();

  acquireRun(taskKey: string, workerId: string): boolean {
    if (this.active.has(taskKey)) return false;
    this.active.set(taskKey, { workerId, startedAt: Date.now() });
    workerEvents.emit({
      type: 'run.acquired',
      workerId,
      taskKey,
      timestamp: Date.now(),
    });
    return true;
  }

  releaseRun(taskKey: string): void {
    const run = this.active.get(taskKey);
    if (!run) return;
    this.active.delete(taskKey);
    workerEvents.emit({
      type: 'run.released',
      workerId: run.workerId,
      taskKey,
      timestamp: Date.now(),
    });
  }

  queueFollowUp(taskKey: string, followUp: FollowUp): void {
    const queue = this.followUps.get(taskKey) || [];
    queue.push(followUp);
    this.followUps.set(taskKey, queue);
  }

  getQueuedFollowUps(taskKey: string): FollowUp[] {
    return this.followUps.get(taskKey) || [];
  }

  drainFollowUps(taskKey: string): FollowUp[] {
    const queue = this.followUps.get(taskKey) || [];
    this.followUps.delete(taskKey);
    return queue;
  }

  getActiveRuns(): Map<string, ActiveRun> {
    return new Map(this.active);
  }

  isRunning(taskKey: string): boolean {
    return this.active.has(taskKey);
  }

  getRunWorker(taskKey: string): string | undefined {
    return this.active.get(taskKey)?.workerId;
  }
}

export const runCoordinator = new RunCoordinator();
