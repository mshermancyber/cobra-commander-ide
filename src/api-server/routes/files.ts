import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cobra-commander', 'containers']);
const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_WRITE_BODY = 8 * 1024 * 1024; // 8MB request cap
const ALLOWED_ROOTS = ['/data'];

// Secrets that must never be read or written through the file API, even within
// an allowed root — prevents cross-project credential theft/overwrite.
const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/,
  /\.(pem|key|p12|pfx|crt)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
  /(^|\/)\.cobra-commander(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)credentials?$/i,
  /\.secret$/i,
];

function isSecretPath(p: string): boolean {
  return SECRET_PATTERNS.some(re => re.test(p));
}

/** True when `full` resolves inside `base` (trailing-separator safe). */
function withinDir(base: string, full: string): boolean {
  const rel = relative(resolve(base), resolve(full));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safePath(workDir: string, reqPath: string): string | null {
  const full = resolve(workDir, reqPath);
  if (withinDir(workDir, full)) return full;
  for (const root of ALLOWED_ROOTS) {
    if (withinDir(root, full)) return full;
  }
  return null;
}

/** Writes are confined to the active project directory only. */
function safeWritePath(workDir: string, reqPath: string): string | null {
  const full = reqPath.startsWith('/') ? resolve(reqPath) : resolve(workDir, reqPath);
  return withinDir(workDir, full) ? full : null;
}

function isAllowedAbsPath(p: string): boolean {
  const resolved = resolve(p);
  try {
    const realPath = realpathSync(resolved);
    return ALLOWED_ROOTS.some(root => realPath.startsWith(root + '/') || realPath === root);
  } catch {
    return false;
  }
}

interface TreeNode {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  children?: TreeNode[];
}

function buildTree(dir: string, depth: number = 0, maxDepth: number = 6): TreeNode[] {
  if (depth > maxDepth) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          return { name: e.name, type: 'dir' as const, children: buildTree(full, depth + 1, maxDepth) };
        }
        const st = statSync(full);
        return { name: e.name, type: 'file' as const, size: st.size };
      });
  } catch { return []; }
}

export function createFileRoutes(workDir: string) {
  async function getFileTree(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const reqPath = url.searchParams.get('path');
    const depthParam = parseInt(url.searchParams.get('depth') || '6', 10);
    const maxDepth = Math.min(Math.max(depthParam, 1), 6);

    let targetDir = workDir;
    if (reqPath) {
      const resolved = resolve(reqPath);
      if (isAllowedAbsPath(resolved) && existsSync(resolved)) {
        targetDir = resolved;
      } else {
        const relative = safePath(workDir, reqPath);
        if (relative && existsSync(relative)) {
          targetDir = relative;
        }
      }
    }

    sendJson(res, 200, buildTree(targetDir, 0, maxDepth));
  }

  async function readFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const reqPath = url.searchParams.get('path');
    if (!reqPath) { sendError(res, 400, 'Missing path parameter'); return; }

    let full: string | null = null;
    if (reqPath.startsWith('/') && isAllowedAbsPath(reqPath)) {
      full = resolve(reqPath);
    } else {
      full = safePath(workDir, reqPath);
    }

    if (!full) { sendError(res, 403, 'Path traversal blocked'); return; }
    if (isSecretPath(full)) { sendError(res, 403, 'Reading this file is not permitted'); return; }
    if (!existsSync(full)) { sendError(res, 404, 'File not found'); return; }
    const stat = statSync(full);
    if (stat.size > MAX_FILE_SIZE) { sendError(res, 413, 'File too large'); return; }
    const content = readFileSync(full, 'utf-8');
    sendJson(res, 200, { path: reqPath, content, size: stat.size });
  }

  async function writeFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const reqPath = url.searchParams.get('path');
    if (!reqPath) { sendError(res, 400, 'Missing path parameter'); return; }

    // Writes are confined to the active project — no cross-project overwrites.
    const full = safeWritePath(workDir, reqPath);
    if (!full) { sendError(res, 403, 'Writes are restricted to the project directory'); return; }
    if (isSecretPath(full)) { sendError(res, 403, 'Writing this file is not permitted'); return; }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_WRITE_BODY) { sendError(res, 413, 'Request body too large'); return; }
      chunks.push(chunk as Buffer);
    }
    let body: { content?: unknown };
    try { body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { sendError(res, 400, 'Invalid JSON body'); return; }
    if (typeof body.content !== 'string') { sendError(res, 400, 'Missing content field'); return; }

    const dir = dirname(full);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(full, body.content);
    sendJson(res, 200, { path: reqPath, written: body.content.length });
  }

  return { getFileTree, readFile, writeFile };
}
