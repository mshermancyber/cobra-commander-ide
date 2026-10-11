import { workerEvents, type WorkerEvent } from './event-bus.js';

export interface WorkerProjection {
  workerId: string;
  status: 'idle' | 'running' | 'retrying' | 'done' | 'failed';
  currentTool: string | null;
  turnsCompleted: number;
  lastActivity: number;
  totalTokensIn: number;
  totalTokensOut: number;
  errors: number;
}

class WorkerProjector {
  private projections = new Map<string, WorkerProjection>();

  constructor() {
    workerEvents.on((event) => this.handleEvent(event));
  }

  private ensure(workerId: string): WorkerProjection {
    if (!this.projections.has(workerId)) {
      this.projections.set(workerId, {
        workerId,
        status: 'idle',
        currentTool: null,
        turnsCompleted: 0,
        lastActivity: Date.now(),
        totalTokensIn: 0,
        totalTokensOut: 0,
        errors: 0,
      });
    }
    return this.projections.get(workerId)!;
  }

  private handleEvent(event: WorkerEvent): void {
    const p = this.ensure(event.workerId);
    p.lastActivity = event.timestamp;

    switch (event.type) {
      case 'task.started':
        p.status = 'running';
        p.currentTool = null;
        p.turnsCompleted = 0;
        p.totalTokensIn = 0;
        p.totalTokensOut = 0;
        p.errors = 0;
        break;
      case 'turn.completed':
        p.turnsCompleted++;
        p.totalTokensIn += event.tokensIn;
        p.totalTokensOut += event.tokensOut;
        break;
      case 'tool.called':
        p.currentTool = event.tool;
        break;
      case 'tool.completed':
        if (!event.isError) p.currentTool = null;
        if (event.isError) p.errors++;
        break;
      case 'retry.waiting':
        p.status = 'retrying';
        break;
      case 'doom.detected':
        p.errors++;
        break;
      case 'task.completed':
        p.status = event.status === 'done' ? 'done' : 'failed';
        p.currentTool = null;
        break;
    }
  }

  getProjection(workerId: string): WorkerProjection | undefined {
    return this.projections.get(workerId);
  }

  getAllProjections(): WorkerProjection[] {
    return [...this.projections.values()];
  }

  getByStatus(status: WorkerProjection['status']): WorkerProjection[] {
    return this.getAllProjections().filter(p => p.status === status);
  }

  getStaleWorkers(thresholdMs: number): WorkerProjection[] {
    const cutoff = Date.now() - thresholdMs;
    return this.getAllProjections().filter(
      p => (p.status === 'running' || p.status === 'retrying') && p.lastActivity < cutoff,
    );
  }
}

export const workerProjector = new WorkerProjector();
