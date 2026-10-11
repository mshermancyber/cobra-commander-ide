export type WorkerEvent =
  | { type: 'task.started'; workerId: string; task: string; timestamp: number }
  | { type: 'tool.called'; workerId: string; tool: string; args: string; timestamp: number }
  | { type: 'tool.completed'; workerId: string; tool: string; duration: number; isError: boolean; timestamp: number }
  | { type: 'turn.completed'; workerId: string; turnNumber: number; tokensIn: number; tokensOut: number; timestamp: number }
  | { type: 'compaction.triggered'; workerId: string; freedChars: number; timestamp: number }
  | { type: 'doom.detected'; workerId: string; tool: string; count: number; timestamp: number }
  | { type: 'task.completed'; workerId: string; status: 'done' | 'failed'; result: string; timestamp: number }
  | { type: 'steering.injected'; workerId: string; message: string; timestamp: number }
  | { type: 'run.acquired'; workerId: string; taskKey: string; timestamp: number }
  | { type: 'run.released'; workerId: string; taskKey: string; timestamp: number }
  | { type: 'retry.waiting'; workerId: string; attempt: number; retryAfterMs: number; reason: string; timestamp: number }
  | { type: 'retry.exhausted'; workerId: string; attempts: number; lastError: string; timestamp: number }
  | { type: 'escalation.triggered'; workerId: string; reason: string; detail: string; timestamp: number }
  | { type: 'doom.cancelled'; workerId: string; tool: string; count: number; timestamp: number };

type EventHandler = (event: WorkerEvent) => void;

class EventBus {
  private handlers: EventHandler[] = [];
  private ring: WorkerEvent[] = [];
  private ringPos = 0;
  private ringSize = 0;
  private readonly maxRing = 1000;

  on(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  emit(event: WorkerEvent): void {
    if (this.ring.length < this.maxRing) {
      this.ring.push(event);
    } else {
      this.ring[this.ringPos] = event;
    }
    this.ringPos = (this.ringPos + 1) % this.maxRing;
    this.ringSize = Math.min(this.ringSize + 1, this.maxRing);

    for (const handler of this.handlers) {
      handler(event);
    }
  }

  history(workerId?: string, limit?: number): WorkerEvent[] {
    const count = Math.min(limit ?? this.ringSize, this.ringSize);
    const result: WorkerEvent[] = [];
    const total = Math.min(this.ringSize, this.maxRing);
    const start = this.ring.length < this.maxRing
      ? 0
      : this.ringPos;

    for (let i = 0; i < total; i++) {
      const idx = (start + i) % this.ring.length;
      const event = this.ring[idx];
      if (!workerId || event.workerId === workerId) {
        result.push(event);
      }
    }

    if (limit !== undefined && result.length > limit) {
      return result.slice(result.length - limit);
    }
    return result;
  }
}

export const workerEvents = new EventBus();
