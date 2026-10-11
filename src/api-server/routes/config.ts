import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';
import { loadConfig } from '../../core/config.js';

function sanitizeConfig(config: any): any {
  const copy = JSON.parse(JSON.stringify(config));
  const redact = (obj: any) => {
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase().includes('apikey') || key.toLowerCase().includes('api_key') || key === 'apiKey') {
        obj[key] = '***';
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        redact(obj[key]);
      }
    }
  };
  redact(copy);
  return copy;
}

export function createConfigRoutes(workDir: string) {
  async function getConfig(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = loadConfig({ workDir });
    sendJson(res, 200, sanitizeConfig(config));
  }

  async function updateConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const updates = JSON.parse(Buffer.concat(chunks).toString());

    const configPath = join(workDir, '.cobra-commander', 'config.json');
    let existing: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try { existing = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* ignore */ }
    }

    // Block writing API keys via this endpoint
    if (updates.apiKey || updates.worker?.apiKey) {
      sendError(res, 400, 'Cannot set API keys via this endpoint');
      return;
    }

    const merged = { ...existing, ...updates };
    writeFileSync(configPath, JSON.stringify(merged, null, 2));
    sendJson(res, 200, sanitizeConfig(merged));
  }

  async function listProfiles(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const { listProfiles: lp } = await import('../../core/config-profiles.js');
      const profiles = lp(workDir);
      sendJson(res, 200, profiles);
    } catch {
      sendJson(res, 200, []);
    }
  }

  return { getConfig, updateConfig, listProfiles };
}
