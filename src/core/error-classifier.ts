import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isContextOverflow } from './context-overflow.js';

export interface ErrorClassification {
  action: 'mkdir' | 'rehydrate' | 'compact' | 'memory_limit' | 'retry_with_context' | 'retry' | 'fail';
  path?: string;
  context?: string;
}

const ENOENT_RE = /ENOENT[:\s].*?['"]?(\/[^\s'"]+)['"]?/i;
const ENOENT_MKDIR_RE = /ENOENT.*mkdir\s+'?(\/[^\s']+)/i;
const AUTH_PATTERNS = [/401/i, /403/i, /unauthorized/i, /forbidden/i, /api.key.*invalid/i, /key.*expired/i, /authentication.*failed/i];
const OOM_PATTERNS = [/exit code 137/i, /killed/i, /heap out of memory/i, /out of memory/i, /OOM/i, /ENOMEM/i];
const TSC_RE = /TS\d{4,5}:/;

export function classifyError(error: Error | string, attempt = 1, maxRetries = 2): ErrorClassification {
  const msg = error instanceof Error ? error.message : error;

  const mkdirMatch = msg.match(ENOENT_MKDIR_RE) || msg.match(ENOENT_RE);
  if (mkdirMatch) {
    const raw = mkdirMatch[1];
    const target = raw.endsWith('.lock') || raw.includes('.') ? dirname(raw) : raw;
    return { action: 'mkdir', path: target };
  }

  if (AUTH_PATTERNS.some(p => p.test(msg))) {
    return { action: 'rehydrate' };
  }

  if (isContextOverflow(msg)) {
    return { action: 'compact', context: msg };
  }

  if (OOM_PATTERNS.some(p => p.test(msg))) {
    return { action: 'memory_limit', context: msg };
  }

  if (TSC_RE.test(msg)) {
    return { action: 'retry_with_context', context: msg };
  }

  return attempt < maxRetries ? { action: 'retry', context: msg } : { action: 'fail', context: msg };
}

export async function autoFix(classification: ErrorClassification): Promise<boolean> {
  switch (classification.action) {
    case 'mkdir':
      if (!classification.path) return false;
      try {
        mkdirSync(classification.path, { recursive: true });
        return true;
      } catch {
        return false;
      }

    case 'rehydrate':
      try {
        const { hydrateWorkerKey, loadConfig } = await import('./config.js');
        await hydrateWorkerKey(loadConfig({ workDir: process.cwd() }));
        return true;
      } catch {
        return false;
      }

    case 'retry':
    case 'retry_with_context':
      return true;

    case 'compact':
    case 'memory_limit':
    case 'fail':
      return false;
  }
}
