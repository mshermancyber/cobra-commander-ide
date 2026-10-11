import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';
import type { Config } from '../../core/config.js';

export function createModelRoutes(config: Config, workDir: string) {
  async function listModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const models = config.workerPool.map(w => ({
      name: w.name,
      tier: w.tier,
      model: w.provider.model,
      baseUrl: w.provider.baseUrl,
      hasKey: !!w.provider.apiKey,
    }));
    sendJson(res, 200, {
      activeModel: config.worker.model,
      workerPool: models,
    });
  }

  async function setActiveModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }

    if (!body.model || typeof body.model !== 'string') { sendError(res, 400, 'Missing model field'); return; }

    // Validate model exists in worker pool
    const poolEntry = config.workerPool.find(w => w.name === body.model);
    if (!poolEntry) {
      sendError(res, 400, `Unknown model "${body.model}". Available: ${config.workerPool.map(w => w.name).join(', ')}`);
      return;
    }

    config.worker.model = body.model;

    // Persist to config.json
    try {
      const configPath = join(workDir, '.cobra-commander', 'config.json');
      let existing: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        existing = JSON.parse(readFileSync(configPath, 'utf-8'));
      }
      existing.worker = { ...(existing.worker as Record<string, unknown> || {}), model: body.model };
      writeFileSync(configPath, JSON.stringify(existing, null, 2));
    } catch { /* non-critical: model change will still take effect for this session */ }

    sendJson(res, 200, { activeModel: config.worker.model });
  }

  return { listModels, setActiveModel };
}
