import type { IncomingMessage, ServerResponse } from 'node:http';

export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message, status: statusCode });
}

export function wrapHandler(
  fn: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void {
  return (req, res, params) => {
    fn(req, res, params).catch((err: unknown) => {
      if (err instanceof ApiError) {
        sendError(res, err.statusCode, err.message);
      } else {
        // Log full error internally, send sanitized message to client
        console.error('[api error]', err instanceof Error ? err.stack || err.message : String(err));
        sendError(res, 500, 'Internal server error');
      }
    });
  };
}
