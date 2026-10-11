/**
 * Worker Steering — Allows the orchestrator to inject mid-task messages
 * into a running worker's conversation loop. Queued messages are consumed
 * once per turn and injected as system messages before the next LLM call.
 *
 * V3-005: Messages now carry priority and sequence numbers.
 *   - 'immediate' messages are delivered before 'queued' messages.
 *   - Within each priority tier, messages are ordered by sequence number.
 */

interface SteerMessage {
  text: string;
  seq: number;
  priority: 'immediate' | 'queued';
}

const steerMessages = new Map<string, SteerMessage[]>();
let globalSeq = 0;

/**
 * Queue a steering message for a worker. The message will be injected
 * as a system message at the start of the worker's next conversation turn.
 *
 * @param workerId - Target worker identifier
 * @param message - The steering message text
 * @param priority - Delivery priority: 'immediate' skips the queue, 'queued' is FIFO
 */
export function steerWorker(
  workerId: string,
  message: string,
  priority: 'immediate' | 'queued' = 'queued',
): void {
  const entry: SteerMessage = { text: message, seq: globalSeq++, priority };
  const existing = steerMessages.get(workerId);
  if (existing) {
    existing.push(entry);
  } else {
    steerMessages.set(workerId, [entry]);
  }
}

/**
 * Drain all queued steering messages for a worker and return them.
 * Messages are sorted: immediate first, then queued by sequence number.
 * After this call, the queue for this worker is empty.
 */
export function consumeSteerMessages(workerId: string): string[] {
  const messages = steerMessages.get(workerId);
  if (!messages || messages.length === 0) {
    return [];
  }
  steerMessages.delete(workerId);

  // Sort: immediate first (by seq), then queued (by seq)
  messages.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority === 'immediate' ? -1 : 1;
    }
    return a.seq - b.seq;
  });

  return messages.map((m) => m.text);
}
