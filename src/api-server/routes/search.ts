import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';

const MAX_LIMIT = 100;

export function createSearchRoutes(workDir: string) {
  async function search(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }

    if (!body.query || typeof body.query !== 'string') { sendError(res, 400, 'Missing query field'); return; }
    const limit = Math.min(Number(body.limit) || 20, MAX_LIMIT);

    if (body.type === 'semantic') {
      // semantic-index archived — return empty until embeddings are wired in
      sendJson(res, 200, []);
    } else {
      // grep — use execFileSync with argument array to prevent shell injection
      try {
        const output = execFileSync('grep', [
          '-rn',
          '--include=*.ts',
          '--include=*.js',
          '--include=*.json',
          '-l',
          '-m', String(limit),
          body.query,
          '.',
        ], {
          cwd: workDir,
          encoding: 'utf-8',
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const files = output ? output.split('\n') : [];
        sendJson(res, 200, files.map(f => ({ file: f, query: body.query })));
      } catch (err: any) {
        // grep exits with code 1 when no matches found — that's not an error
        if (err?.status === 1) {
          sendJson(res, 200, []);
        } else {
          sendError(res, 500, `Search failed: ${err?.message || 'unknown error'}`);
        }
      }
    }
  }

  return { search };
}
