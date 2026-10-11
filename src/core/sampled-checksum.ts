import { createHash } from 'node:crypto';

const LARGE_THRESHOLD = 500_000;
const DEFAULT_SAMPLE_SIZE = 4096;
const NUM_SAMPLES = 5;

export function sampledChecksum(content: string, sampleSize?: number): string {
  if (content.length < LARGE_THRESHOLD) {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  const chunkSize = sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const step = Math.floor(content.length / NUM_SAMPLES);
  const hashes: string[] = [];

  for (let i = 0; i < NUM_SAMPLES; i++) {
    const start = i * step;
    const chunk = content.slice(start, start + chunkSize);
    hashes.push(createHash('sha256').update(chunk).digest('hex'));
  }

  return createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 16);
}
