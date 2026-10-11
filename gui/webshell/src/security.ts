// ---------------------------------------------------------------------------
// Security panel — scan buttons (SCA, API Scan, Code Review, DAST, SAST)
// ---------------------------------------------------------------------------

import theme from './theme.js';
import { getWorkspaceRoot } from './workspace-root.js';

interface ScanResult {
  id: string;
  type: string;
  status: string;
  findings?: Array<{ severity: string; title: string; file?: string }>;
  error?: string;
  createdAt?: number;
}

let _workDir = getWorkspaceRoot();
let _resultsEl: HTMLElement | null = null;
let _statusEl: HTMLElement | null = null;
let _projectPathEl: HTMLElement | null = null;
let _activePollId = 0;

export function setSecurityWorkDir(dir: string): void {
  _workDir = dir;
  if (_projectPathEl) {
    _projectPathEl.textContent = dir;
  }
}

function injectSecurityStyles(): void {
  if (document.getElementById('cc-security-styles')) return;
  const style = document.createElement('style');
  style.id = 'cc-security-styles';
  style.textContent = `
    .cc-security-wrap {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      background: ${theme.bg};
    }
    .cc-security-header {
      padding: 16px 20px 12px;
      border-bottom: 1px solid ${theme.border};
      background: ${theme.bgSecondary};
    }
    .cc-security-title {
      font-size: 14px;
      font-weight: 700;
      color: ${theme.text};
      margin-bottom: 2px;
    }
    .cc-security-subtitle {
      font-size: 11px;
      color: ${theme.textMuted};
    }
    .cc-security-project {
      padding: 8px 20px;
      font-size: 11px;
      color: ${theme.textMuted};
      border-bottom: 1px solid ${theme.border};
      background: ${theme.bg};
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cc-security-project-path {
      color: ${theme.accent};
      font-family: 'SF Mono', Menlo, Consolas, monospace;
    }
    .cc-security-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 16px 20px;
      border-bottom: 1px solid ${theme.border};
    }
    .cc-security-btn {
      min-width: 110px;
      min-height: 44px;
      padding: 10px 18px;
      background: ${theme.bgSecondary};
      color: ${theme.text};
      border: 1px solid ${theme.border};
      border-radius: 8px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
      display: flex;
      align-items: center;
      gap: 6px;
      -webkit-tap-highlight-color: transparent;
    }
    .cc-security-btn:hover {
      border-color: ${theme.accent};
      color: ${theme.accent};
      background: rgba(0,255,65,0.04);
    }
    .cc-security-btn:active {
      background: rgba(0,255,65,0.08);
    }
    .cc-security-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .cc-security-btn .cc-security-btn-icon {
      font-size: 16px;
    }
    .cc-security-status {
      padding: 8px 20px;
      font-size: 12px;
      color: ${theme.accent};
      background: ${theme.bgSecondary};
      border-bottom: 1px solid ${theme.border};
      min-height: 36px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cc-security-status.error {
      color: ${theme.accentRed};
    }
    .cc-security-results {
      flex: 1;
      overflow-y: auto;
      padding: 12px 20px;
    }
    .cc-security-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: ${theme.textMuted};
      font-size: 13px;
      text-align: center;
      padding: 40px 20px;
    }
    .cc-security-result-item {
      padding: 10px 14px;
      background: ${theme.bgSecondary};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      margin-bottom: 8px;
    }
    .cc-security-result-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .cc-security-result-type {
      font-size: 11px;
      font-weight: 600;
      color: ${theme.textMuted};
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .cc-security-result-status {
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 10px;
      font-weight: 600;
    }
    .cc-security-result-status.completed {
      background: rgba(0,255,65,0.1);
      color: ${theme.accent};
    }
    .cc-security-result-status.failed {
      background: rgba(255,77,77,0.1);
      color: ${theme.accentRed};
    }
    .cc-security-result-status.running {
      background: rgba(0,255,65,0.05);
      color: ${theme.accentYellow};
    }
    .cc-security-finding {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 0;
      font-size: 12px;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
    }
    .cc-security-finding.severity-critical { color: #ff4d4d; }
    .cc-security-finding.severity-high { color: #ff8844; }
    .cc-security-finding.severity-medium { color: ${theme.accentYellow}; }
    .cc-security-finding.severity-low { color: ${theme.textMuted}; }
    .cc-security-finding-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .cc-security-finding.severity-critical .cc-security-finding-dot { background: #ff4d4d; }
    .cc-security-finding.severity-high .cc-security-finding-dot { background: #ff8844; }
    .cc-security-finding.severity-medium .cc-security-finding-dot { background: ${theme.accentYellow}; }
    .cc-security-finding.severity-low .cc-security-finding-dot { background: ${theme.textMuted}; }
    @media (max-width: 640px) {
      .cc-security-buttons { gap: 6px; padding: 12px 12px; }
      .cc-security-btn { min-width: 90px; padding: 8px 12px; font-size: 12px; }
    }
  `;
  document.head.appendChild(style);
}

async function launchScan(scanType: string): Promise<void> {
  if (!_statusEl || !_resultsEl) return;

  _statusEl.textContent = `⏳ Launching ${scanType} scan on ${_workDir}…`;
  _statusEl.className = 'cc-security-status';

  try {
    const resp = await fetch('/api/v1/security/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: scanType, projectPath: _workDir }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
      _statusEl.textContent = `❌ Scan failed: ${err.error || resp.statusText}`;
      _statusEl.className = 'cc-security-status error';
      return;
    }

    const data = await resp.json();
    const scanId = data.results?.[scanType]?.id || data.scanId || data.id || null;
    _statusEl.textContent = scanId
      ? `✅ ${scanType} scan launched — ID: ${scanId}`
      : `✅ ${scanType} scan launched`;
    _statusEl.className = 'cc-security-status';

    if (data.findings || data.results) {
      renderResults([data]);
    } else if (scanId) {
      pollScanStatus(scanId, scanType);
    }
  } catch (e) {
    _statusEl.textContent = `❌ Network error: ${e}`;
    _statusEl.className = 'cc-security-status error';
  }
}

async function pollScanStatus(scanId: string, scanType: string): Promise<void> {
  const pollId = ++_activePollId; // invalidate prior polls
  const maxPolls = 30;
  for (let i = 0; i < maxPolls; i++) {
    if (pollId !== _activePollId) return; // cancelled by a new launch
    await new Promise((r) => setTimeout(r, 2000));
    if (pollId !== _activePollId) return;
    try {
      const resp = await fetch(`/api/v1/security/scan/${encodeURIComponent(scanId)}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.status === 'completed' || data.status === 'failed') {
        if (pollId !== _activePollId) return;
        _statusEl!.textContent = data.status === 'completed'
          ? `✅ ${scanType} scan completed`
          : `❌ ${scanType} scan failed: ${data.error || ''}`;
        _statusEl!.className = data.status === 'completed'
          ? 'cc-security-status'
          : 'cc-security-status error';
        renderResults([data]);
        return;
      }
      if (pollId !== _activePollId) return;
      _statusEl!.textContent = `⏳ ${scanType} scan running… (${i + 1}/${maxPolls})`;
    } catch {
      // continue polling
    }
  }
  if (pollId !== _activePollId) return;
  _statusEl!.textContent = `⚠ ${scanType} scan timed out waiting for results`;
  _statusEl!.className = 'cc-security-status error';
}

function renderResults(results: ScanResult[]): void {
  if (!_resultsEl) return;
  _resultsEl.innerHTML = '';

  if (results.length === 0) {
    _resultsEl.innerHTML = '<div class="cc-security-empty">No scan results yet. Launch a scan to get started.</div>';
    return;
  }

  for (const result of results) {
    const item = document.createElement('div');
    item.className = 'cc-security-result-item';

    const header = document.createElement('div');
    header.className = 'cc-security-result-header';

    const typeEl = document.createElement('span');
    typeEl.className = 'cc-security-result-type';
    typeEl.textContent = result.type || 'Scan';

    const statusEl = document.createElement('span');
    statusEl.className = `cc-security-result-status ${result.status || 'unknown'}`;
    statusEl.textContent = result.status || 'unknown';

    header.appendChild(typeEl);
    header.appendChild(statusEl);
    item.appendChild(header);

    if (result.error) {
      const errEl = document.createElement('div');
      errEl.style.cssText = `color:${theme.accentRed};font-size:12px;`;
      errEl.textContent = result.error;
      item.appendChild(errEl);
    }

    if (result.findings && result.findings.length > 0) {
      for (const finding of result.findings) {
        const f = document.createElement('div');
        f.className = `cc-security-finding severity-${finding.severity?.toLowerCase() || 'low'}`;
        f.innerHTML = `<span class="cc-security-finding-dot"></span> ${finding.severity?.toUpperCase() || 'LOW'}: ${finding.title}${finding.file ? ` (${finding.file})` : ''}`;
        item.appendChild(f);
      }
    }

    _resultsEl.appendChild(item);
  }
}

export function createSecurityPanel(container: HTMLElement): void {
  injectSecurityStyles();

  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'cc-security-wrap';

  // Header
  const header = document.createElement('div');
  header.className = 'cc-security-header';
  header.innerHTML = `
    <div class="cc-security-title">Security Dashboard</div>
    <div class="cc-security-subtitle">Launch security scans on the current project</div>
  `;

  // Project info
  const projectBar = document.createElement('div');
  projectBar.className = 'cc-security-project';
  const projectPathSpan = document.createElement('span');
  projectPathSpan.className = 'cc-security-project-path';
  projectPathSpan.textContent = _workDir;
  projectBar.innerHTML = '📁 Project: ';
  projectBar.appendChild(projectPathSpan);
  _projectPathEl = projectPathSpan;

  // Scan buttons
  const buttons = document.createElement('div');
  buttons.className = 'cc-security-buttons';

  const scanTypes = [
    { id: 'sca', label: 'SCA', icon: '📦', desc: 'Dependency scan' },
    { id: 'api', label: 'API Scan', icon: '🔗', desc: 'API security' },
    { id: 'codereview', label: 'Code Review', icon: '🔍', desc: 'Code analysis' },
    { id: 'dast', label: 'DAST', icon: '🌐', desc: 'Dynamic scan' },
    { id: 'sast', label: 'SAST', icon: '📊', desc: 'Static analysis' },
  ];

  for (const st of scanTypes) {
    const btn = document.createElement('button');
    btn.className = 'cc-security-btn';
    btn.title = st.desc;
    btn.innerHTML = `<span class="cc-security-btn-icon">${st.icon}</span> ${st.label}`;
    btn.addEventListener('click', () => launchScan(st.id));
    buttons.appendChild(btn);
  }

  // Status
  const statusEl = document.createElement('div');
  statusEl.className = 'cc-security-status';
  statusEl.textContent = 'Ready — select a scan type to begin';
  _statusEl = statusEl;

  // Results area
  const results = document.createElement('div');
  results.className = 'cc-security-results';
  results.innerHTML = '<div class="cc-security-empty">No scan results yet. Launch a scan to get started.</div>';
  _resultsEl = results;

  wrap.appendChild(header);
  wrap.appendChild(projectBar);
  wrap.appendChild(buttons);
  wrap.appendChild(statusEl);
  wrap.appendChild(results);
  container.appendChild(wrap);
}
