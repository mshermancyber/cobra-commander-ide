import { execFileSync } from 'node:child_process';
import type { ToolDefinition } from '../core/types.js';

function getSearxngUrl(): string | null {
  return process.env.SEARXNG_URL || null;
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web using SearXNG. Returns titles, URLs, and snippets for the top results.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
      max_results: {
        type: 'number',
        description: 'Max results to return (default: 5, max: 20)',
      },
      categories: {
        type: 'string',
        description: 'Search categories: general, images, news, science, files, it, social media (default: general)',
      },
    },
    required: ['query'],
  },
};

export function executeWebSearchTool(
  input: Record<string, unknown>,
): { result: string; is_error: boolean } {
  const query = input.query as string;
  const maxResults = Math.min((input.max_results as number) || 5, 20);
  const categories = (input.categories as string) || 'general';

  if (!query || query.trim().length === 0) {
    return { result: 'Error: query is required', is_error: true };
  }

  const searxngUrl = getSearxngUrl();
  if (!searxngUrl) {
    return { result: 'Error: SEARXNG_URL environment variable is not configured', is_error: true };
  }
  const searchUrl = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=${encodeURIComponent(categories)}`;

  try {
    const raw = execFileSync('curl', [
      '-sL',
      '--max-time', '10',
      '-H', 'Accept: application/json',
      searchUrl,
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });

    const data = JSON.parse(raw);
    const results = (data.results || []).slice(0, maxResults);

    if (results.length === 0) {
      return { result: `No results found for "${query}"`, is_error: false };
    }

    const formatted = results.map((r: any, i: number) => {
      const title = r.title || '(no title)';
      const url = r.url || '';
      const snippet = (r.content || '').slice(0, 200);
      return `${i + 1}. ${title}\n   ${url}\n   ${snippet}`;
    }).join('\n\n');

    return { result: `Search results for "${query}" (${results.length} results):\n\n${formatted}`, is_error: false };
  } catch (err) {
    return { result: `Search failed: ${(err as Error).message.split('\n')[0]}`, is_error: true };
  }
}
