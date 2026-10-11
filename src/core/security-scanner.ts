import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scannerLogin, scannerHeaders, resolveScannerBaseUrl, translatePath } from './scanner-auth.js';
import { installRoot } from './env-file.js';
import { isPrivateIP } from './url-validator.js';

export interface ScanConfig {
  apiBase: string;     // e.g., "https://localhost:20443"
  email: string;
  password: string;
  projectName: string;
  projectId?: string;  // known scanner project UUID — used directly, skips name lookup
}

export interface Finding {
  id: string;
  title: string;
  description: string;
  severity: string;   // critical, high, medium, low, info
  filePath: string;
  lineNumber: number;
  codeSnippet?: string;
  cweId?: string;
  type: string;        // sast, dast, sca, etc.
  status: string;      // open, confirmed, false_positive, closed
  confidence?: string;
}

export interface ScanResult {
  scanId: string;
  status: 'completed' | 'failed' | 'timeout';
  findings: Finding[];
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

function validateScanUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Invalid protocol: ${parsed.protocol}`);
    }
    const blocked = ['169.254.169.254', 'metadata.google.internal', 'metadata.internal', '100.100.100.200'];
    if (blocked.some(b => parsed.hostname === b || parsed.hostname.endsWith('.' + b))) {
      throw new Error(`Blocked metadata endpoint: ${parsed.hostname}`);
    }
    // Block private/internal IPs (SSRF prevention — CWE-918), EXCEPT the scanner backend
    // itself: it is a trusted, operator-configured service that legitimately lives on a
    // private address. The SSRF guard is for untrusted scan targets, not our own backend —
    // without this exemption every scan launch to a self-hosted scanner is silently blocked.
    let scannerHost = '';
    const configuredScanner = resolveScannerBaseUrl();
    if (configuredScanner) {
      try { scannerHost = new URL(configuredScanner).hostname; } catch { /* unparseable config */ }
    }
    if (parsed.hostname !== scannerHost && isPrivateIP(parsed.hostname)) {
      throw new Error(`Blocked private IP: ${parsed.hostname}`);
    }
  } catch (err) {
    if ((err as Error).message.includes('Invalid URL')) {
      throw new Error(`Invalid scan URL: ${url}`);
    }
    throw err;
  }
}

async function apiCall(
  method: string,
  url: string,
  body?: unknown,
  token?: string,
): Promise<unknown> {
  validateScanUrl(url);
  const headers: Record<string, string> = token
    ? { ...scannerHeaders(token) }
    : { 'Content-Type': 'application/json' };

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (body) {
    fetchOptions.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    clearTimeout(timeoutId);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Resolve the install home — the directory holding the canonical
 * `.cobra-commander/scanner.json` (scanner baseUrl/projectId/email/password).
 * Scanner credentials live only here, never in a per-task orchestrator's
 * sibling-project workDir. Honors `CC_HOME`, then walks up from this module's
 * own location, then falls back to the resolved install root.
 */
function resolveCcHome(): string {
  const envHome = process.env.CC_HOME;
  if (envHome && hasScannerConfig(envHome)) return envHome;

  try {
    let dir = dirname(fileURLToPath(import.meta.url)); // .../src/core
    for (let i = 0; i < 8; i++) {
      if (hasScannerConfig(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* fall through to default */ }

  return envHome || installRoot();
}

function hasScannerConfig(dir: string): boolean {
  return existsSync(join(dir, '.cobra-commander', 'scanner.json')) ||
    existsSync(join(dir, '.cobra-commander', 'security.json'));
}

/**
 * Load scanner scan config from a single directory's `.cobra-commander/` (scanner.json, then
 * legacy security.json). Returns null if neither file yields a usable config — the
 * caller decides whether to fall back to CC home or environment variables.
 */
function loadScanConfigFromDir(dir: string): ScanConfig | null {
  // Primary: load from .cobra-commander/scanner.json (unified scanner config)
  const scannerConfigPath = join(dir, '.cobra-commander', 'scanner.json');
  if (existsSync(scannerConfigPath)) {
    try {
      const raw = JSON.parse(readFileSync(scannerConfigPath, 'utf-8'));
      const resolved = resolveScannerBaseUrl(raw.baseUrl);
      if (resolved && raw.projectId) {
        return {
          apiBase: resolved,
          email: raw.email || process.env.SCANNER_EMAIL || '',
          password: raw.password || process.env.SCANNER_PASSWORD || '',
          projectName: raw.projectName || 'cobra-commander',
          projectId: raw.projectId,
        };
      }
    } catch { /* fall through */ }
  }

  // Legacy: .cobra-commander/security.json
  const configPath = join(dir, '.cobra-commander', 'security.json');
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      const resolved = resolveScannerBaseUrl(raw.apiBase);
      if (!resolved) return null;
      return {
        apiBase: resolved,
        email: raw.email || '',
        password: raw.password || '',
        projectName: raw.projectName || 'cobra-commander',
      };
    } catch { /* fall through */ }
  }

  return null;
}

export function loadScanConfig(workDir: string): ScanConfig | null {
  // 1) The given workDir first — preserves self-scanning and any project-local
  //    scanner override that a project chooses to ship.
  const local = loadScanConfigFromDir(workDir);
  if (local) return local;

  // 2) The install home. A per-task orchestrator runs with workDir set to a sibling
  //    project that has no .cobra-commander/scanner.json of its own, which silently
  //    skipped the post-delegation auto-scan. Credentials live only in the install
  //    home — fall back to it so sibling-project builds still get scanned.
  const ccHome = resolveCcHome();
  if (ccHome !== workDir) {
    const home = loadScanConfigFromDir(ccHome);
    if (home) return home;
  }

  // 3) Environment variables (SCANNER_EMAIL / SCANNER_PASSWORD / SCANNER_API_BASE).
  const email = process.env.SCANNER_EMAIL;
  const password = process.env.SCANNER_PASSWORD;
  if (email && password) {
    const resolved = resolveScannerBaseUrl(process.env.SCANNER_API_BASE);
    if (resolved) {
      return {
        apiBase: resolved,
        email,
        password,
        projectName: 'cobra-commander',
      };
    }
  }

  return null;
}

export async function authenticate(config: ScanConfig): Promise<string | null> {
  return scannerLogin({ baseUrl: config.apiBase, email: config.email, password: config.password });
}

export async function findOrCreateProject(
  config: ScanConfig,
  token: string,
): Promise<string | null> {
  // If we already know the project UUID (from scanner.json), use it directly — no lookup/create.
  if (config.projectId) return config.projectId;
  try {
    // Try to find existing project
    const resp = await apiCall('GET', `${config.apiBase}/api/projects`, undefined, token) as { data?: Array<Record<string, unknown>> };
    if (resp.data) {
      const existing = resp.data.find(p => p.name === config.projectName);
      if (existing) return existing.id as string;
    }

    // Create new project
    const createResp = await apiCall('POST', `${config.apiBase}/api/projects`, {
      name: config.projectName,
      description: 'cobra-commander self-scan target',
    }, token) as Record<string, unknown>;
    return (createResp.id as string) || null;
  } catch {
    return null;
  }
}

export async function launchSastScan(
  config: ScanConfig,
  token: string,
  projectId: string,
  targetPath: string,
): Promise<string | null> {
  try {
    // A containerised scanner sees the project at a different path than the host
    // does; sending the raw host path yields "scan path not found". The mapping is
    // configuration (SCANNER_HOST_PATH / SCANNER_CONTAINER_PATH), never a guess.
    const containerPath = translatePath(targetPath);
    const resp = await apiCall('POST', `${config.apiBase}/api/scans/launch`, {
      projectId,
      scanType: 'sast',
      name: `self-scan-${Date.now()}`,
      options: { targetPath: containerPath },
    }, token) as Record<string, unknown>;
    return (resp.id as string) || null;
  } catch {
    return null;
  }
}

export async function launchScaScan(
  config: ScanConfig,
  token: string,
  projectId: string,
): Promise<string | null> {
  try {
    const resp = await apiCall('POST', `${config.apiBase}/api/scans/launch`, {
      projectId,
      scanType: 'sca',
      name: `sca-scan-${Date.now()}`,
    }, token) as Record<string, unknown>;
    return (resp.id as string) || null;
  } catch {
    return null;
  }
}

export async function launchCodeReviewScan(
  config: ScanConfig,
  token: string,
  projectId: string,
  targetPath: string,
): Promise<string | null> {
  try {
    // Same host → container path mapping as the SAST launch.
    const containerPath = translatePath(targetPath);
    const resp = await apiCall('POST', `${config.apiBase}/api/code-review/reviews/launch`, {
      name: `code-review-${Date.now()}`,
      projectId,
      reviewType: 'security',
      targetType: 'folder',
      targetPath: containerPath,
      options: {},
    }, token) as Record<string, unknown>;
    return (resp.id as string) || null;
  } catch {
    return null;
  }
}

export async function getCodeReviewFindings(
  config: ScanConfig,
  token: string,
  reviewId: string,
): Promise<Finding[]> {
  try {
    const resp = await apiCall('GET', `${config.apiBase}/api/code-review/findings?reviewId=${reviewId}`, undefined, token) as { data?: Array<Record<string, unknown>> };
    if (!resp.data) return [];
    return resp.data.map(f => ({
      id: f.id as string,
      title: f.title as string || '',
      description: f.description as string || '',
      severity: f.severity as string || 'medium',
      filePath: f.file_path as string || '',
      lineNumber: (f.line_number as number) || 0,
      codeSnippet: f.code_snippet as string || '',
      cweId: f.cwe_id as string || '',
      type: 'code-review',
      status: f.status as string || 'open',
      confidence: f.confidence_score as string || '',
    }));
  } catch {
    return [];
  }
}

export async function pollScanStatus(
  config: ScanConfig,
  token: string,
  scanId: string,
  timeoutMs: number = 120000,
): Promise<'completed' | 'failed' | 'timeout'> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await apiCall('GET', `${config.apiBase}/api/scans/${scanId}`, undefined, token) as Record<string, unknown>;
      const status = resp.status as string;
      if (status === 'completed' || status === 'failed') {
        return status as 'completed' | 'failed';
      }
    } catch { /* retry */ }

    // Sleep 3 seconds between polls
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return 'timeout';
}

export async function getFindings(
  config: ScanConfig,
  token: string,
  scanId: string,
): Promise<Finding[]> {
  try {
    const resp = await apiCall('GET', `${config.apiBase}/api/scans/${scanId}/findings`, undefined, token) as { data?: Array<Record<string, unknown>> };
    if (!resp.data) return [];

    return resp.data.map(f => ({
      id: f.id as string,
      title: f.title as string || '',
      description: f.description as string || '',
      severity: f.severity as string || 'medium',
      filePath: f.file_path as string || f.filePath as string || '',
      lineNumber: (f.line_number as number) || (f.lineNumber as number) || 0,
      codeSnippet: f.code_snippet as string || f.codeSnippet as string || '',
      cweId: f.cwe_id as string || f.cweId as string || '',
      type: f.type as string || 'sast',
      status: f.status as string || 'open',
      confidence: f.confidence as string || '',
    }));
  } catch {
    return [];
  }
}

export function filterTruePositives(findings: Finding[]): Finding[] {
  // Filter out likely false positives and info-level findings
  return findings.filter(f => {
    if (f.status === 'false_positive' || f.status === 'closed') return false;
    if (f.severity === 'info') return false;
    // Keep confirmed, open findings of medium+ severity
    return ['critical', 'high', 'medium'].includes(f.severity);
  });
}

export function formatFindingsForWorker(findings: Finding[]): string {
  if (findings.length === 0) return 'No security findings to fix.';

  const parts = findings.map((f, i) => {
    let entry = `### Finding ${i + 1}: ${f.title} [${f.severity.toUpperCase()}]`;
    if (f.cweId) entry += ` (CWE-${f.cweId})`;
    entry += `\n**File:** ${f.filePath}`;
    if (f.lineNumber) entry += `:${f.lineNumber}`;
    entry += `\n**Description:** ${f.description}`;
    if (f.codeSnippet) entry += `\n**Code:**\n\`\`\`\n${f.codeSnippet}\n\`\`\``;
    return entry;
  });

  return `# Security Findings to Fix\n\n${parts.join('\n\n')}`;
}

export async function runSecurityScan(
  config: ScanConfig,
  workDir: string,
  onProgress: (msg: string) => void,
): Promise<ScanResult> {
  onProgress('Authenticating with the security scanner...');
  const token = await authenticate(config);
  if (!token) throw new Error('Failed to authenticate with the security scanner');

  onProgress('Finding/creating project...');
  const projectId = await findOrCreateProject(config, token);
  if (!projectId) throw new Error('Failed to find or create project');

  // Launch all 3 scan types in parallel
  onProgress('Launching SAST + SCA + Code Review scans...');
  const [sastId, scaId, reviewId] = await Promise.all([
    launchSastScan(config, token, projectId, workDir),
    launchScaScan(config, token, projectId),
    launchCodeReviewScan(config, token, projectId, workDir),
  ]);

  if (!sastId && !scaId && !reviewId) throw new Error('Failed to launch any scan');

  // Poll all running scans in parallel
  const pollPromises: Promise<{ type: string; id: string; status: 'completed' | 'failed' | 'timeout' }>[] = [];
  if (sastId) {
    onProgress(`SAST scan ${sastId.slice(0, 8)} queued...`);
    pollPromises.push(pollScanStatus(config, token, sastId).then(s => ({ type: 'sast', id: sastId, status: s })));
  }
  if (scaId) {
    onProgress(`SCA scan ${scaId.slice(0, 8)} queued...`);
    pollPromises.push(pollScanStatus(config, token, scaId).then(s => ({ type: 'sca', id: scaId, status: s })));
  }
  if (reviewId) {
    onProgress(`Code review ${reviewId.slice(0, 8)} queued...`);
    pollPromises.push(pollScanStatus(config, token, reviewId, 180000).then(s => ({ type: 'code-review', id: reviewId, status: s })));
  }

  const results = await Promise.all(pollPromises);

  // Collect findings from all completed scans
  onProgress('Fetching findings from all scans...');
  let allFindings: Finding[] = [];

  for (const r of results) {
    if (r.status !== 'completed') {
      onProgress(`${r.type} scan ${r.status}`);
      continue;
    }
    if (r.type === 'code-review') {
      const reviewFindings = await getCodeReviewFindings(config, token, r.id);
      allFindings = allFindings.concat(reviewFindings);
    } else {
      const scanFindings = await getFindings(config, token, r.id);
      allFindings = allFindings.concat(scanFindings);
    }
  }

  const summary = {
    total: allFindings.length,
    critical: allFindings.filter(f => f.severity === 'critical').length,
    high: allFindings.filter(f => f.severity === 'high').length,
    medium: allFindings.filter(f => f.severity === 'medium').length,
    low: allFindings.filter(f => f.severity === 'low').length,
  };

  const primaryId = sastId || scaId || reviewId || 'unknown';
  return { scanId: primaryId, status: 'completed', findings: allFindings, summary };
}
