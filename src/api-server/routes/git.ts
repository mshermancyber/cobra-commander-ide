import { execSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';

export function createGitRoutes(workDir: string) {
  function git(cmd: string): { ok: true; output: string } | { ok: false; error: string } {
    try {
      return { ok: true, output: execSync(`git ${cmd}`, { cwd: workDir, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim() };
    } catch (err) {
      const stderr = (err as any)?.stderr?.toString?.() || '';
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: stderr || message };
    }
  }

  async function getStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const branchResult = git('rev-parse --abbrev-ref HEAD');
    const statusResult = git('status --porcelain');
    if (!branchResult.ok) {
      sendError(res, 500, `git failed: ${branchResult.error}`);
      return;
    }
    const files = statusResult.ok
      ? statusResult.output.split('\n').filter(Boolean).map(line => ({
          status: line.slice(0, 2).trim(),
          path: line.slice(3),
        }))
      : [];
    sendJson(res, 200, { branch: branchResult.output, files, clean: files.length === 0 });
  }

  async function getLog(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
    const result = git(`log --oneline -${limit}`);
    if (!result.ok) {
      sendError(res, 500, `git log failed: ${result.error}`);
      return;
    }
    const commits = result.output.split('\n').filter(Boolean).map(line => {
      const [hash, ...msg] = line.split(' ');
      return { hash, message: msg.join(' ') };
    });
    sendJson(res, 200, commits);
  }

  async function getDiff(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const diffResult = git('diff');
    if (!diffResult.ok) {
      sendError(res, 500, `git diff failed: ${diffResult.error}`);
      return;
    }
    sendJson(res, 200, { diff: diffResult.output });
  }

  async function getCheckpoints(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendError(res, 501, 'Checkpoints feature has been archived and is no longer available');
  }

  async function createCheckpoint(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendError(res, 501, 'Checkpoints feature has been archived and is no longer available');
  }

  return { getStatus, getLog, getDiff, getCheckpoints, createCheckpoint };
}
