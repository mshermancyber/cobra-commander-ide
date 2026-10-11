import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';
import {
  InlineCompletionProvider,
  handleCompletionRequest,
} from '../../core/inline-completion.js';
import type { CompletionEndpointRequest } from '../../core/inline-completion.js';

let provider: InlineCompletionProvider | null = null;

export function getCompletionProvider(): InlineCompletionProvider | null {
  return provider;
}

export function initCompletionProvider(apiKey: string, baseUrl?: string): InlineCompletionProvider {
  provider = new InlineCompletionProvider({
    baseUrl: baseUrl || 'https://api.openai.com/v1',
    apiKey,
    model: 'gpt-5.1-codex',
  });
  return provider;
}

export function createCompletionRoutes(workDir: string) {
  async function getCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!provider) {
      sendError(res, 503, 'Completion provider not initialized');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: CompletionEndpointRequest;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      sendError(res, 400, 'Invalid JSON');
      return;
    }

    if (!body.filePath) { sendError(res, 400, 'Missing filePath'); return; }
    if (body.line === undefined) { sendError(res, 400, 'Missing line'); return; }
    if (body.column === undefined) { sendError(res, 400, 'Missing column'); return; }

    try {
      const result = await handleCompletionRequest(provider, body);
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[completions] error:', err instanceof Error ? err.stack || err.message : String(err));
      sendError(res, 500, 'Completion failed');
    }
  }

  return { getCompletions };
}
