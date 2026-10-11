import { randomBytes } from 'node:crypto';

let lastTs = 0;
let counter = 0;

export function monotonicId(): string {
  const now = Date.now();
  if (now === lastTs) {
    counter++;
  } else {
    lastTs = now;
    counter = 0;
  }

  const ts = now.toString(36).padStart(8, '0');
  const seq = counter.toString(36).padStart(4, '0');
  const rand = randomBytes(9).toString('base64url').slice(0, 14);

  return ts + seq + rand;
}
