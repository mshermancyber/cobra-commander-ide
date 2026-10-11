import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { translatePath } from './scanner-auth.js';
import { boundText } from './bounded-fetch.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single security finding from a scan. */
export interface ScanFinding {
  id: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  filePath: string;
  lineNumber: number;
  codeSnippet?: string;
  cweId?: string;
  type: string;
  status: string;
}

/** Result summary for a completed scan. */
export interface ScanResult {
  scanId: string;
  scanType: string;
  status: 'completed' | 'failed' | 'timeout';
  findings: ScanFinding[];
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

// ---------------------------------------------------------------------------
// the scanner resolution
// ---------------------------------------------------------------------------

/** Resolve the scanner container's IP address via docker inspect. */
function resolveContainerIP(container: string): string | null {
  try {
    const raw = execSync(
      `docker inspect ${container} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    const ips = raw.split(/\s+/).filter(Boolean);
    return ips[0] || null;
  } catch {
    return null;
  }
}

/** Load the the scanner base URL, resolving container IP if needed. */
function resolveBaseUrl(workDir: string): string | null {
  // Check .cobra-commander/security.json
  const secPath = join(workDir, '.cobra-commander', 'security.json');
  if (existsSync(secPath)) {
    try {
      const sec = JSON.parse(readFileSync(secPath, 'utf-8'));
      if (sec.apiBase) return sec.apiBase;
    } catch { /* fall through */ }
  }

  // Check .cobra-commander/scanner.json
  const scannerConfigPath = join(workDir, '.cobra-commander', 'scanner.json');
  if (existsSync(scannerConfigPath)) {
    try {
      const dv = JSON.parse(readFileSync(scannerConfigPath, 'utf-8'));
      if (dv.baseUrl) return dv.baseUrl.replace(/\/+$/, '');
    } catch { /* fall through */ }
  }

  // Try docker-based resolution
  const containerIP = resolveContainerIP('');
  if (containerIP) {
    return `http://${containerIP}:3000`;
  }

  // Fallback env
  return process.env.SCANNER_API_BASE || process.env.SCANNER_API_BASE || null;
}

/** Load the scanner credentials from config files or environment. */
function loadCredentials(workDir: string): { email: string; password: string } | null {
  // Try security.json
  const secPath = join(workDir, '.cobra-commander', 'security.json');
  if (existsSync(secPath)) {
    try {
      const sec = JSON.parse(readFileSync(secPath, 'utf-8'));
      if (sec.email && sec.password) return { email: sec.email, password: sec.password };
    } catch { /* fall through */ }
  }

  // Try scanner.json
  const scannerConfigPath = join(workDir, '.cobra-commander', 'scanner.json');
  if (existsSync(scannerConfigPath)) {
    try {
      const dv = JSON.parse(readFileSync(scannerConfigPath, 'utf-8'));
      if (dv.email && dv.password) return { email: dv.email, password: dv.password };
    } catch { /* fall through */ }
  }

  // Env fallback
  const email = process.env.SCANNER_EMAIL;
  const password = process.env.SCANNER_PASSWORD;
  if (email && password) return { email, password };

  return null;
}

// ---------------------------------------------------------------------------
// AsyncScanHandle
// ---------------------------------------------------------------------------

/**
 * A handle to a background scanner scan.
 *
 * Use `poll()` for a non-blocking check, or `await wait()` to block until
 * the scan completes (or times out).
 */
export class AsyncScanHandle {
  private baseUrl: string;
  private email: string;
  private password: string;
  private projectPath: string;
  private scanTypes: string[];
  private projectId: string | null = null;
  private scanIds: Array<{ id: string; type: string }> = [];
  private token: string | null = null;
  private launched = false;
  private launchError: string | null = null;
  private launchPromise: Promise<void> | null = null;

  constructor(
    baseUrl: string,
    email: string,
    password: string,
    projectPath: string,
    scanTypes: string[],
  ) {
    this.baseUrl = baseUrl;
    this.email = email;
    this.password = password;
    this.projectPath = projectPath;
    this.scanTypes = scanTypes.length > 0 ? scanTypes : ['sast'];
  }

  // -----------------------------------------------------------------------
  // Internal: lazy launch
  // -----------------------------------------------------------------------

  private async ensureLaunched(): Promise<void> {
    if (this.launched) return;
    if (this.launchError) throw new Error(this.launchError);

    if (!this.launchPromise) {
      this.launchPromise = this.doLaunch();
    }
    await this.launchPromise;
  }

  private async doLaunch(): Promise<void> {
    try {
      // 1. Authenticate
      const loginResp = await this.fetchAPI('/api/auth/login', 'POST', {
        email: this.email,
        password: this.password,
      });
      const body = loginResp as Record<string, unknown>;
      const token =
        (body.token as string) ||
        this.extractCookie(loginResp);
      if (!token) throw new Error('the scanner authentication failed');
      this.token = token;

      // 2. Find or create project
      const projResp = await this.fetchAPI(
        '/api/projects',
        'GET',
        undefined,
        token,
      ) as { data?: Array<Record<string, unknown>> };
      const projName = this.projectPath.split('/').pop() || 'cobra-commander';
      if (projResp.data) {
        const existing = projResp.data.find(p => p.name === projName);
        if (existing) {
          this.projectId = existing.id as string;
        }
      }
      if (!this.projectId) {
        const createResp = await this.fetchAPI(
          '/api/projects',
          'POST',
          { name: projName, description: 'cobra-commander async scan' },
          token,
        ) as Record<string, unknown>;
        this.projectId = (createResp.id as string) || null;
        if (!this.projectId) throw new Error('Failed to create scanner project');
      }

      // 3. Launch scans
      const containerPath = translatePath(this.projectPath);
      for (const scanType of this.scanTypes) {
        const launchBody: Record<string, unknown> = {
          projectId: this.projectId,
          scanType,
          name: `async-${scanType}-${Date.now()}`,
          options: { targetPath: containerPath },
        };
        const launchResp = await this.fetchAPI(
          '/api/scans/launch',
          'POST',
          launchBody,
          token,
        ) as Record<string, unknown>;
        const scanId = launchResp.id as string;
        if (scanId) {
          this.scanIds.push({ id: scanId, type: scanType });
        }
      }

      this.launched = true;
    } catch (err) {
      this.launchError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Non-blocking poll. Returns `null` if scans are still running, or an
   * array of ScanResult when all scans have completed.
   */
  async poll(): Promise<ScanResult[] | null> {
    try {
      await this.ensureLaunched();
    } catch {
      return [];
    }

    if (this.scanIds.length === 0) return [];

    const results = await Promise.all(
      this.scanIds.map(s => this.pollOne(s.id, s.type)),
    );

    // If any scan is still running, return null.
    if (results.some(r => !r)) return null;
    return results.filter(Boolean) as ScanResult[];
  }

  /**
   * Block until all scans complete. Returns scan results.
   * Polls every 5 seconds. Times out after `timeoutMs` (default 10 minutes).
   */
  async wait(timeoutMs = 600_000): Promise<ScanResult[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const results = await this.poll();
      if (results !== null) return results;
      await sleep(5000);
    }
    // Timeout — return whatever we have with timeout markers
    return this.scanIds.map(s => ({
      scanId: s.id,
      scanType: s.type,
      status: 'timeout' as const,
      findings: [],
      summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
    }));
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async pollOne(
    scanId: string,
    scanType: string,
  ): Promise<ScanResult | null> {
    if (!this.token) return null;
    try {
      const resp = await this.fetchAPI(
        `/api/scans/${scanId}`,
        'GET',
        undefined,
        this.token,
      ) as Record<string, unknown>;

      const status = resp.status as string;
      if (status === 'pending' || status === 'running' || status === 'queued') {
        return null; // still running
      }

      if (status !== 'completed') {
        return {
          scanId,
          scanType,
          status: 'failed',
          findings: [],
          summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
        };
      }

      // Fetch findings
      const findingsResp = await this.fetchAPI(
        `/api/scans/${scanId}/findings`,
        'GET',
        undefined,
        this.token,
      ) as { data?: Array<Record<string, unknown>> };

      const findings: ScanFinding[] = (findingsResp.data || []).map(
        (f: Record<string, unknown>) => ({
          id: f.id as string,
          title: f.title as string || '',
          description: f.description as string || '',
          severity: (f.severity as ScanFinding['severity']) || 'medium',
          filePath: (f.file_path as string) || (f.filePath as string) || '',
          lineNumber: (f.line_number as number) || (f.lineNumber as number) || 0,
          codeSnippet: (f.code_snippet as string) || (f.codeSnippet as string) || '',
          cweId: (f.cwe_id as string) || (f.cweId as string) || '',
          type: scanType,
          status: (f.status as string) || 'open',
        }),
      );

      const summary = {
        total: findings.length,
        critical: findings.filter(f => f.severity === 'critical').length,
        high: findings.filter(f => f.severity === 'high').length,
        medium: findings.filter(f => f.severity === 'medium').length,
        low: findings.filter(f => f.severity === 'low').length,
      };

      return { scanId, scanType, status: 'completed', findings, summary };
    } catch {
      return null; // Network error — caller will retry
    }
  }

  private async fetchAPI(
    path: string,
    method: string,
    body?: unknown,
    token?: string,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['Cookie'] = `access_token=${token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    try {
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body) {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      const text = boundText(await response.text(), 500_000);
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private extractCookie(_resp: unknown): string | null {
    // fetch Response objects have headers.getSetCookie()
    // But we receive a parsed body, not the Response.
    // Token extraction via scannerLogin is the canonical approach.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Launch a scanner scan in the background. Returns immediately with a handle.
 *
 * @param projectPath - Absolute host path to the project to scan.
 * @param scanTypes   - Array of scan types (e.g., ['sast', 'deps']).
 * @param workDir     - Working directory used to resolve the scanner configuration.
 * @returns An AsyncScanHandle that can be polled or awaited.
 */
export function launchAsyncScan(
  projectPath: string,
  scanTypes: string[],
  workDir?: string,
): AsyncScanHandle {
  const wd = workDir || process.cwd();
  const baseUrl = resolveBaseUrl(wd);
  if (!baseUrl) {
    // Return a handle in a permanently failed state.
    const handle = new AsyncScanHandle('http://localhost:3000', '', '', projectPath, scanTypes);
    // Override the internal state to mark as already failed.
    setLaunchError(handle, 'the scanner base URL not configured');
    return handle;
  }

  const creds = loadCredentials(wd);
  if (!creds) {
    const handle = new AsyncScanHandle(baseUrl, '', '', projectPath, scanTypes);
    setLaunchError(handle, 'the scanner credentials not configured');
    return handle;
  }

  return new AsyncScanHandle(
    baseUrl,
    creds.email,
    creds.password,
    projectPath,
    scanTypes,
  );
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Write a launch error to a handle's private field without exposing it
 * in the public API. This avoids a full constructor for the pre-failed case.
 */
function setLaunchError(handle: AsyncScanHandle, msg: string): void {
  (handle as unknown as { launchError: string | null }).launchError = msg;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
