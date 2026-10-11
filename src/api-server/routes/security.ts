import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson, sendError } from '../middleware/error-handler.js';
import { scannerLogin, scannerHeaders, translatePath, resolveScannerBaseUrl } from '../../core/scanner-auth.js';

interface ScannerConfig {
  baseUrl: string;
  projectId: string;
  email: string;
  password: string;
}

type ScanType = 'sast' | 'sca' | 'code-review' | 'full';

export function createSecurityRoutes(workDir: string) {
  function getScannerConfig(): ScannerConfig | null {
    const configPath = join(workDir, '.cobra-commander', 'scanner.json');
    if (existsSync(configPath)) {
      try {
        const data = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (data.baseUrl && data.projectId) {
          return {
            baseUrl: data.baseUrl.replace(/\/+$/, ''),
            projectId: data.projectId,
            email: data.email || process.env.SCANNER_EMAIL || '',
            password: data.password || process.env.SCANNER_PASSWORD || '',
          };
        }
      } catch { /* fall through to environment */ }
    }

    // Environment-only configuration — no file needed.
    const baseUrl = resolveScannerBaseUrl();
    const projectId = process.env.SCANNER_PROJECT_ID;
    if (baseUrl && projectId) {
      return {
        baseUrl: baseUrl.replace(/\/+$/, ''),
        projectId,
        email: process.env.SCANNER_EMAIL || '',
        password: process.env.SCANNER_PASSWORD || '',
      };
    }

    return null;
  }

  async function getAuthHeaders(config: ScannerConfig): Promise<Record<string, string>> {
    const token = await scannerLogin({ baseUrl: config.baseUrl, email: config.email, password: config.password });
    if (!token) return { 'Content-Type': 'application/json' };
    return scannerHeaders(token);
  }

  async function launchScan_(config: ScannerConfig, headers: Record<string, string>, scanType: 'sast' | 'sca', name: string): Promise<unknown> {
    const url = `${config.baseUrl}/api/scans/launch`;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: config.projectId, scanType, name }),
    });
    return resp.json();
  }

  async function launchCodeReview(config: ScannerConfig, headers: Record<string, string>, name: string, targetPath?: string): Promise<unknown> {
    const url = `${config.baseUrl}/api/code-review/reviews/launch`;
    // The scanner may see the project at a different path than the host does;
    // the mapping comes from SCANNER_HOST_PATH / SCANNER_CONTAINER_PATH.
    const hostPath = targetPath || join(workDir, 'src');
    const containerPath = translatePath(hostPath);
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name,
        projectId: config.projectId,
        reviewType: 'security',
        targetType: 'folder',
        targetPath: containerPath,
        options: {},
      }),
    });
    return resp.json();
  }

  async function launchScan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const scannerConfig = getScannerConfig();
    if (!scannerConfig) { sendError(res, 503, 'Security scanner not configured'); return; }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const scanType: ScanType = body.type || 'sast';
    const targetPath = body.targetPath as string | undefined;
    const ts = Date.now();

    const validTypes: ScanType[] = ['sast', 'sca', 'code-review', 'full'];
    if (!validTypes.includes(scanType)) {
      sendError(res, 400, `Invalid scan type: ${scanType}. Valid: ${validTypes.join(', ')}`);
      return;
    }

    try {
      const headers = await getAuthHeaders(scannerConfig);
      const results: Record<string, unknown> = {};

      if (scanType === 'sast') {
        results.sast = await launchScan_(scannerConfig, headers, 'sast', body.name || `sast-${ts}`);
      } else if (scanType === 'sca') {
        results.sca = await launchScan_(scannerConfig, headers, 'sca', body.name || `sca-${ts}`);
      } else if (scanType === 'code-review') {
        results.codeReview = await launchCodeReview(scannerConfig, headers, body.name || `cc-review-${ts}`, targetPath);
      } else if (scanType === 'full') {
        const [sast, sca, review] = await Promise.all([
          launchScan_(scannerConfig, headers, 'sast', `sast-full-${ts}`),
          launchScan_(scannerConfig, headers, 'sca', `sca-full-${ts}`),
          launchCodeReview(scannerConfig, headers, `cc-review-full-${ts}`, targetPath),
        ]);
        results.sast = sast;
        results.sca = sca;
        results.codeReview = review;
      }

      sendJson(res, 200, { type: scanType, results });
    } catch (err) {
      console.error('[security] scanner API error:', err instanceof Error ? err.stack || err.message : String(err));
      sendError(res, 502, 'Scanner API request failed');
    }
  }

  async function getFindings(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const scannerConfig = getScannerConfig();
    if (!scannerConfig) { sendError(res, 503, 'Security scanner not configured'); return; }

    try {
      const headers = await getAuthHeaders(scannerConfig);
      const url = `${scannerConfig.baseUrl}/api/findings?projectId=${scannerConfig.projectId}`;
      const resp = await fetch(url, { headers });
      const data = await resp.json();
      sendJson(res, 200, data);
    } catch (err) {
      console.error('[security] scanner API error:', err instanceof Error ? err.stack || err.message : String(err));
      sendError(res, 502, 'Scanner API request failed');
    }
  }

  async function getDashboard(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const scannerConfig = getScannerConfig();
    if (!scannerConfig) { sendError(res, 503, 'Security scanner not configured'); return; }

    try {
      const headers = await getAuthHeaders(scannerConfig);
      const url = `${scannerConfig.baseUrl}/api/dashboard?projectId=${scannerConfig.projectId}`;
      const resp = await fetch(url, { headers });
      const data = await resp.json();
      sendJson(res, 200, data);
    } catch (err) {
      console.error('[security] scanner API error:', err instanceof Error ? err.stack || err.message : String(err));
      sendError(res, 502, 'Scanner API request failed');
    }
  }

  async function getReviews(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const scannerConfig = getScannerConfig();
    if (!scannerConfig) { sendError(res, 503, 'Security scanner not configured'); return; }

    try {
      const headers = await getAuthHeaders(scannerConfig);
      const url = `${scannerConfig.baseUrl}/api/code-review/reviews?projectId=${scannerConfig.projectId}`;
      const resp = await fetch(url, { headers });
      const data = await resp.json();
      sendJson(res, resp.status >= 400 ? 502 : 200, data);
    } catch (err) {
      console.error('[security] scanner API error:', err instanceof Error ? err.stack || err.message : String(err));
      sendError(res, 502, 'Scanner API request failed');
    }
  }

  async function getReviewFindings(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const scannerConfig = getScannerConfig();
    if (!scannerConfig) { sendError(res, 503, 'Security scanner not configured'); return; }

    const reviewId = params.id;
    if (!reviewId) { sendError(res, 400, 'Review ID required'); return; }

    try {
      const headers = await getAuthHeaders(scannerConfig);
      const url = `${scannerConfig.baseUrl}/api/code-review/findings?reviewId=${reviewId}`;
      const resp = await fetch(url, { headers });
      const data = await resp.json();
      sendJson(res, resp.status >= 400 ? 502 : 200, data);
    } catch (err) {
      console.error('[security] scanner API error:', err instanceof Error ? err.stack || err.message : String(err));
      sendError(res, 502, 'Scanner API request failed');
    }
  }

  return { launchScan, getFindings, getDashboard, getReviews, getReviewFindings };
}
