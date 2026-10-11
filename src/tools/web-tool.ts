import { execFileSync } from 'node:child_process';
import type { ToolDefinition } from '../core/types.js';
import { boundText } from '../core/bounded-fetch.js';

// Blocked IP ranges for SSRF prevention
const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/0\./,
  /^https?:\/\/169\.254\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/\[fd/i,
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\.0\.0\.1/i,
];

export const webTool: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch content from a URL. Returns the text content of the page. Use for reading documentation, API references, or any web content. Does not execute JavaScript.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      max_length: {
        type: 'number',
        description: 'Maximum characters to return (default: 10000)',
      },
    },
    required: ['url'],
  },
};

export function executeWebTool(
  input: Record<string, unknown>,
): { result: string; is_error: boolean } {
  const url = input.url as string;
  const maxLength = (input.max_length as number) || 10000;

  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return { result: 'Invalid URL. Must start with http:// or https://', is_error: true };
  }

  // SSRF prevention: block private/internal IPs
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(url)) {
      return { result: 'Blocked: URL points to a private or internal network address', is_error: true };
    }
  }

  try {
    const result = execFileSync('curl', [
      '-sL',
      '--max-time', '15',
      '--max-filesize', '5000000',
      '-H', 'User-Agent: cobra-commander/1.0',
      url,
    ], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 20000,
    });

    // Strip HTML tags for cleaner output
    let text = result
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    text = boundText(text, maxLength);

    return { result: text || '(empty response)', is_error: false };
  } catch (err) {
    return { result: `Failed to fetch URL: ${(err as Error).message.split('\n')[0]}`, is_error: true };
  }
}
