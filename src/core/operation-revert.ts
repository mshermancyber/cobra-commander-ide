import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installRoot } from './env-file.js';

const STORE_DIR = `${installRoot()}/.worker-store`;

export interface FilePatch {
  path: string;
  before: string;
  after: string;
}

interface PatchEntry {
  workerId: string;
  operationIndex: number;
  timestamp: number;
  type: string;
  patches: FilePatch[];
}

function patchFilePath(workerId: string): string {
  return join(STORE_DIR, `${workerId}-patches.jsonl`);
}

export function recordOperation(
  workerId: string,
  operationIndex: number,
  patches: FilePatch[],
  type = 'edit',
): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
  const entry: PatchEntry = {
    workerId,
    operationIndex,
    timestamp: Date.now(),
    type,
    patches,
  };
  appendFileSync(patchFilePath(workerId), JSON.stringify(entry) + '\n');
}

export function revertOperation(
  workerId: string,
  operationIndex: number,
): { reverted: string[]; failed: string[] } {
  const entries = loadPatches(workerId);
  const target = entries.find(e => e.operationIndex === operationIndex);
  if (!target) {
    return { reverted: [], failed: [] };
  }

  const reverted: string[] = [];
  const failed: string[] = [];

  for (const patch of target.patches) {
    try {
      if (!existsSync(patch.path)) {
        failed.push(patch.path);
        continue;
      }
      const current = readFileSync(patch.path, 'utf-8');
      if (current === patch.after) {
        writeFileSync(patch.path, patch.before);
        reverted.push(patch.path);
      } else {
        failed.push(patch.path);
      }
    } catch {
      failed.push(patch.path);
    }
  }

  return { reverted, failed };
}

export function listOperations(
  workerId: string,
): Array<{ index: number; timestamp: number; files: string[]; type: string }> {
  const entries = loadPatches(workerId);
  return entries.map(e => ({
    index: e.operationIndex,
    timestamp: e.timestamp,
    files: e.patches.map(p => p.path),
    type: e.type,
  }));
}

function loadPatches(workerId: string): PatchEntry[] {
  const fp = patchFilePath(workerId);
  if (!existsSync(fp)) return [];
  return readFileSync(fp, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(Boolean) as PatchEntry[];
}
