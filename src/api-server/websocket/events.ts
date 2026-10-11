import { EventEmitter } from 'node:events';

export const serverEvents = new EventEmitter();

export function broadcast(event: Record<string, unknown>): void {
  serverEvents.emit('broadcast', JSON.stringify(event));
}
