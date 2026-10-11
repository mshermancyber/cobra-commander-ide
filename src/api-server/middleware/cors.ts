import type { IncomingMessage, ServerResponse } from 'node:http';

const ALLOWED_ORIGINS = [
  /^http:\/\/localhost(?::\d+)?$/,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/,
];

export function corsMiddleware(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers['origin'];

  if (origin) {
    const allowed = ALLOWED_ORIGINS.some(pattern => pattern.test(origin));
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
  }

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
}
