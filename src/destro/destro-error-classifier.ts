// forked from core/error-classifier.ts @ 2026-07-04 — DOWNSTREAM fork, do not backport to core

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Inlined from core/context-overflow.ts — Destro must be self-contained
const OVERFLOW_PATTERNS: RegExp[] = [
  /max.*tokens/i,
  /context.*length.*exceeded/i,
  /prompt.*too.*long/i,
  /maximum context length/i,
  /tokens.*exceeds.*limit/i,
  /context_length_exceeded/i,
  /input.*too.*long/i,
  /context.*window/i,
  /token.*limit.*exceeded/i,
  /context.*overflow/i,
  /too many tokens/i,
  /input.*length.*exceeded/i,
  /max.*context/i,
  /request.*too.*large/i,
];

function isContextOverflow(errorMessage: string): boolean {
  if (!errorMessage) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

export interface ErrorClassification {
  action: 'mkdir' | 'rehydrate' | 'compact' | 'memory_limit' | 'retry_with_context' | 'retry' | 'fail' | 'container_issue';
  path?: string;
  context?: string;
  containerSignature?: string;
}

const ENOENT_RE = /ENOENT[:\s].*?['"]?(\/[^\s'"]+)['"]?/i;
const ENOENT_MKDIR_RE = /ENOENT.*mkdir\s+'?(\/[^\s']+)/i;
const AUTH_PATTERNS = [/401/i, /403/i, /unauthorized/i, /forbidden/i, /api.key.*invalid/i, /key.*expired/i, /authentication.*failed/i];
const CONTAINER_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'image-pull-backoff', re: /ImagePullBackOff|image pull backoff|ErrImagePull/i },
  { name: 'port-already-allocated', re: /port is already allocated|bind.*address already in use|port.*already.* allocated/i },
  { name: 'unhealthy-healthcheck', re: /unhealthy|health check failed|failing healthcheck/i },
  { name: 'exited-1', re: /exited.*\(1\)|exit code 1|Exited \(1\)/i },
];
const OOM_PATTERNS = [/exit code 137/i, /killed/i, /heap out of memory/i, /out of memory/i, /OOM/i, /ENOMEM/i];
const TSC_RE = /TS\d{4,5}:/;

export function classifyDestroError(error: Error | string, attempt = 1, maxRetries = 2): ErrorClassification {
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

  for (const pattern of CONTAINER_PATTERNS) {
    if (pattern.re.test(msg)) {
      return { action: 'container_issue', context: msg, containerSignature: pattern.name };
    }
  }

  if (OOM_PATTERNS.some(p => p.test(msg))) {
    return { action: 'memory_limit', context: msg };
  }

  if (TSC_RE.test(msg)) {
    return { action: 'retry_with_context', context: msg };
  }

  return attempt < maxRetries ? { action: 'retry', context: msg } : { action: 'fail', context: msg };
}

export async function destroAutoFix(classification: ErrorClassification): Promise<boolean> {
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
      // Destro does not depend on core/config — rehydration is a Destro-level concern.
      // The caller should handle key hydration through Destro's own config provider.
      return false;

    case 'retry':
    case 'retry_with_context':
      return true;

    case 'container_issue':
    case 'compact':
    case 'memory_limit':
    case 'fail':
      return false;
  }
}
