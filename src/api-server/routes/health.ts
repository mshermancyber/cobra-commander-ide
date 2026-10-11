import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware/error-handler.js';
import { installRoot } from '../../core/env-file.js';

const startTime = Date.now();

let serverWorkDir = '';

/** Record the workspace root so clients don't have to guess or hardcode it. */
export function setHealthWorkDir(workDir: string): void {
  serverWorkDir = workDir;
}

export async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  let version = '0.1.0';
  try {
    const pkg = JSON.parse(readFileSync(join(installRoot(), 'package.json'), 'utf-8'));
    version = pkg.version || version;
  } catch { /* ignore */ }

  sendJson(res, 200, {
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version,
    workDir: serverWorkDir || process.cwd(),
    timestamp: new Date().toISOString(),
  });
}
