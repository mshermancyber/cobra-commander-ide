import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB

function getUploadDir(workDir: string): string {
  const dir = join(workDir, 'uploads');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function parseMultipart(buf: Buffer, boundary: string): { filename: string; data: Buffer } | null {
  const boundaryBuf = Buffer.from('--' + boundary);
  const start = buf.indexOf(boundaryBuf);
  if (start === -1) return null;

  const headerEnd = buf.indexOf('\r\n\r\n', start);
  if (headerEnd === -1) return null;

  const headers = buf.slice(start + boundaryBuf.length, headerEnd).toString('utf-8');
  const filenameMatch = headers.match(/filename="([^"]+)"/);
  if (!filenameMatch) return null;

  const dataStart = headerEnd + 4;
  const endBoundary = buf.indexOf(boundaryBuf, dataStart);
  if (endBoundary === -1) return null;

  // -2 for the \r\n before the boundary
  const data = buf.slice(dataStart, endBoundary - 2);
  return { filename: filenameMatch[1], data };
}

export function createUploadRoutes(workDir: string) {
  async function uploadFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      sendError(res, 400, 'Missing multipart boundary');
      return;
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;

    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_UPLOAD_SIZE) {
          reject(new Error('File too large (max 10MB)'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', resolve);
      req.on('error', reject);
    });

    const body = Buffer.concat(chunks);
    const parsed = parseMultipart(body, boundaryMatch[1]);
    if (!parsed) {
      sendError(res, 400, 'Could not parse file from multipart body. Use field name "file".');
      return;
    }

    const sanitized = parsed.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const date = new Date().toISOString().slice(0, 10);
    const destName = `${date}-${sanitized}`;
    const uploadDir = getUploadDir(workDir);
    const destPath = join(uploadDir, destName);

    writeFileSync(destPath, parsed.data);

    sendJson(res, 200, {
      path: destPath,
      filename: parsed.filename,
      size: parsed.data.length,
    });
  }

  return { uploadFile };
}
