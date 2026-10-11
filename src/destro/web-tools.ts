// Destro agent — web tools. Created 2026-07-04.

import type { ToolDefinition } from '../core/types.js';

// ──────────────────────────────────────────────
// Search Configuration
//
// Web search goes through a SearXNG instance you provide — there is no default
// and no third-party fallback, so nothing is queried until you opt in. Set one
// or more comma-separated base URLs; they are tried in order.
//
//   SEARXNG_URLS=http://search.internal:8080,http://search-2.internal:8080
// ──────────────────────────────────────────────

function searxngUrls(): string[] {
  const raw = process.env.SEARXNG_URLS || process.env.SEARXNG_URL || '';
  return raw.split(',').map(u => u.trim().replace(/\/+$/, '')).filter(Boolean);
}

const MAX_SNIPPET_CHARS = 300;

// ──────────────────────────────────────────────
// Tool Definitions
// ──────────────────────────────────────────────

export const searchWebTool: ToolDefinition = {
  name: 'search_web',
  description:
    'Search the web using SearXNG. Returns titles, URLs, and snippets for the top results.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
      maxResults: {
        type: 'number',
        description: 'Max results to return (default: 5)',
      },
    },
    required: ['query'],
  },
};

export const fetchUrlTool: ToolDefinition = {
  name: 'fetch_url',
  description:
    'Fetch a URL and return the response body preview. Use for reading docs, APIs, or any web content.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      maxBytes: {
        type: 'number',
        description: 'Maximum characters to return (default: 50000)',
      },
    },
    required: ['url'],
  },
};

// ──────────────────────────────────────────────
// All Tools Registry
// ──────────────────────────────────────────────

const ALL_WEB_TOOLS: ToolDefinition[] = [searchWebTool, fetchUrlTool];

export function getAllWebTools(): ToolDefinition[] {
  return ALL_WEB_TOOLS;
}

// ──────────────────────────────────────────────
// Result Types
// ──────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchWebResult {
  ok: boolean;
  results: SearchResult[];
  error?: string;
}

export interface FetchUrlResult {
  ok: boolean;
  status?: number;
  bodyPreview?: string;
  contentType?: string;
  error?: string;
}

type WebToolResult = SearchWebResult | FetchUrlResult;

// ──────────────────────────────────────────────
// SearXNG Query
// ──────────────────────────────────────────────

async function querySearxng(query: string): Promise<SearchResult[]> {
  const instances = searxngUrls();
  if (instances.length === 0) {
    throw new Error('Web search is not configured. Set SEARXNG_URLS to one or more SearXNG base URLs.');
  }

  for (const baseUrl of instances) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);

      if (!resp.ok) continue;

      const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
      const rawResults = data.results || [];

      return rawResults.map((r) => ({
        title: r.title || '(no title)',
        url: r.url || '',
        snippet: (r.content || '').slice(0, MAX_SNIPPET_CHARS),
      }));
    } catch {
      // Try next SearXNG instance
      continue;
    }
  }

  throw new Error('All configured SearXNG instances were unreachable');
}

// ──────────────────────────────────────────────
// Executor
// ──────────────────────────────────────────────

export async function executeWebTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<WebToolResult> {
  switch (toolName) {
    // ── search_web ───────────────────────────
    case 'search_web': {
      const query = input.query as string;
      const maxResults = (input.maxResults as number) || 5;

      if (!query || query.trim().length === 0) {
        return { ok: false, results: [], error: 'query is required' };
      }

      try {
        const allResults = await querySearxng(query);
        const capped = allResults.slice(0, maxResults);
        return { ok: true, results: capped };
      } catch (err: unknown) {
        return {
          ok: false,
          results: [],
          error: `Search failed: ${(err as Error).message}`,
        };
      }
    }

    // ── fetch_url ────────────────────────────
    case 'fetch_url': {
      const url = input.url as string;
      const maxBytes = (input.maxBytes as number) || 50_000;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);

        const contentType = resp.headers.get('content-type') || undefined;
        const bodyText = await resp.text();
        const bodyPreview = bodyText.slice(0, maxBytes);

        return {
          ok: resp.ok,
          status: resp.status,
          bodyPreview,
          contentType,
        };
      } catch (err: unknown) {
        return {
          ok: false,
          error: `Fetch failed: ${(err as Error).message}`,
        };
      }
    }

    default:
      return { ok: false, results: [], error: `Unknown web tool: ${toolName}` };
  }
}
