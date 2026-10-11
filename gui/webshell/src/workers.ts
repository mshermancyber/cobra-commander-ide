// ---------------------------------------------------------------------------
// Workers panel — show active workers from GET /api/v1/tasks
// Auto-refresh every 5 seconds.
// ---------------------------------------------------------------------------

import theme from './theme.js';

interface WorkerTask {
  id: string;
  workerId?: string;
  status: string;
  description?: string;
  task?: string;
  startedAt?: number;
  createdAt?: number;
  elapsed?: number;
  tier?: string;
  tokensIn?: number;
  tokensOut?: number;
}

let _container: HTMLElement | null = null;
let _refreshTimer: ReturnType<typeof setInterval> | null = null;

function injectWorkersStyles(): void {
  if (document.getElementById('cc-workers-styles')) return;
  const style = document.createElement('style');
  style.id = 'cc-workers-styles';
  style.textContent = `
    .cc-workers-wrap {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      background: ${theme.bg};
    }
    .cc-workers-header {
      padding: 16px 20px 12px;
      border-bottom: 1px solid ${theme.border};
      background: ${theme.bgSecondary};
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .cc-workers-title {
      font-size: 14px;
      font-weight: 700;
      color: ${theme.text};
    }
    .cc-workers-subtitle {
      font-size: 11px;
      color: ${theme.textMuted};
    }
    .cc-workers-refresh-btn {
      min-width: 44px;
      min-height: 32px;
      padding: 4px 12px;
      background: none;
      border: 1px solid ${theme.border};
      border-radius: 6px;
      color: ${theme.textMuted};
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .cc-workers-refresh-btn:hover {
      color: ${theme.accent};
      border-color: ${theme.accent};
    }
    .cc-workers-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
    }
    .cc-workers-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: ${theme.textMuted};
      font-size: 13px;
      text-align: center;
      padding: 40px 20px;
      flex-direction: column;
      gap: 8px;
    }
    .cc-workers-item {
      padding: 12px 20px;
      border-bottom: 1px solid ${theme.border};
      transition: background 0.1s;
    }
    .cc-workers-item:hover {
      background: rgba(255,255,255,0.02);
    }
    .cc-workers-item-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 4px;
    }
    .cc-workers-item-id {
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 11px;
      color: ${theme.textMuted};
    }
    .cc-workers-item-status {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .cc-workers-item-status.active,
    .cc-workers-item-status.running {
      background: rgba(0,255,65,0.1);
      color: ${theme.accent};
    }
    .cc-workers-item-status.idle {
      background: rgba(255,255,255,0.05);
      color: ${theme.textMuted};
    }
    .cc-workers-item-status.completed {
      background: rgba(0,255,65,0.05);
      color: ${theme.accentGreen};
    }
    .cc-workers-item-status.failed,
    .cc-workers-item-status.error {
      background: rgba(255,77,77,0.1);
      color: ${theme.accentRed};
    }
    .cc-workers-item-desc {
      font-size: 13px;
      color: ${theme.text};
      line-height: 1.4;
    }
    .cc-workers-item-meta {
      display: flex;
      gap: 16px;
      margin-top: 4px;
      font-size: 11px;
      color: ${theme.textMuted};
    }
    .cc-workers-item-meta span {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .cc-workers-auto-badge {
      font-size: 10px;
      color: ${theme.textMuted};
      padding: 2px 6px;
      background: rgba(255,255,255,0.04);
      border-radius: 4px;
    }
    @media (max-width: 640px) {
      .cc-workers-item { padding: 10px 12px; }
      .cc-workers-item-meta { flex-wrap: wrap; gap: 8px; }
    }
  `;
  document.head.appendChild(style);
}

function isFinished(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'completed' || s === 'failed' || s === 'error' || s === 'done';
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Returns the worker list, or null when the server could not be reached
// (so an outage is not mistaken for "no workers").
async function fetchWorkers(): Promise<WorkerTask[] | null> {
  try {
    const resp = await fetch('/api/v1/workers');
    if (!resp.ok) return null;
    const data = await resp.json();
    const list = Array.isArray(data) ? data : data.workers || [];
    return Array.isArray(list) ? list : [];
  } catch {
    return null;
  }
}

function renderWorkers(tasks: WorkerTask[] | null): void {
  if (!_container) return;
  _container.innerHTML = '';

  if (tasks === null) {
    const err = document.createElement('div');
    err.className = 'cc-workers-empty';
    err.innerHTML = `
      <div style="font-size:32px;">⚠</div>
      <div>Couldn't reach the server</div>
      <div style="font-size:11px;">Retrying automatically…</div>`;
    const retry = document.createElement('button');
    retry.className = 'cc-workers-refresh-btn';
    retry.textContent = '⟳ Retry now';
    retry.style.marginTop = '12px';
    retry.addEventListener('click', refresh);
    err.appendChild(retry);
    _container.appendChild(err);
    return;
  }

  if (tasks.length === 0) {
    _container.innerHTML = `
      <div class="cc-workers-empty">
        <div style="font-size:32px;">⚙</div>
        <div>No active workers</div>
        <div style="font-size:11px;">Workers appear here when tasks are running</div>
      </div>`;
    return;
  }

  for (const task of tasks) {
    const item = document.createElement('div');
    item.className = 'cc-workers-item';

    const header = document.createElement('div');
    header.className = 'cc-workers-item-header';

    const idEl = document.createElement('span');
    idEl.className = 'cc-workers-item-id';
    idEl.textContent = `#${(task.id || task.workerId || '?').slice(0, 12)}`;

    const status = (task.status || 'unknown').toLowerCase();
    const statusClass = status === 'active' || status === 'running' ? 'active'
      : status === 'completed' ? 'completed'
      : status === 'failed' || status === 'error' ? 'failed'
      : 'idle';

    const statusEl = document.createElement('span');
    statusEl.className = `cc-workers-item-status ${statusClass}`;
    statusEl.textContent = status;

    header.appendChild(idEl);
    header.appendChild(statusEl);

    const desc = document.createElement('div');
    desc.className = 'cc-workers-item-desc';
    const rawDesc = task.description || task.task || 'No description';
    const truncated = rawDesc.length > 80;
    desc.textContent = truncated ? rawDesc.slice(0, 80) + '…' : rawDesc;
    if (truncated) {
      desc.style.cursor = 'pointer';
      desc.title = 'Tap to expand';
      let expanded = false;
      desc.addEventListener('click', () => {
        expanded = !expanded;
        desc.textContent = expanded ? rawDesc : rawDesc.slice(0, 80) + '…';
      });
    }

    const meta = document.createElement('div');
    meta.className = 'cc-workers-item-meta';

    const startedAt = task.startedAt || task.createdAt;
    if (startedAt) {
      // Freeze the duration for finished workers instead of ticking forever.
      const durationMs = isFinished(task.status || '')
        ? (task.elapsed ?? 0)
        : Date.now() - startedAt;
      const elapsedSpan = document.createElement('span');
      elapsedSpan.innerHTML = `⏱ ${formatDuration(durationMs)}`;
      meta.appendChild(elapsedSpan);

      const timeSpan = document.createElement('span');
      timeSpan.textContent = `Started ${formatTime(startedAt)}`;
      meta.appendChild(timeSpan);
    }

    if (task.tier) {
      const tierSpan = document.createElement('span');
      tierSpan.textContent = `🏷 ${task.tier}`;
      meta.appendChild(tierSpan);
    }
    const totalTokens = (task.tokensIn ?? 0) + (task.tokensOut ?? 0);
    if (totalTokens > 0) {
      const tokSpan = document.createElement('span');
      tokSpan.textContent = `🔢 ${totalTokens.toLocaleString()} tok`;
      meta.appendChild(tokSpan);
    }

    item.appendChild(header);
    item.appendChild(desc);
    item.appendChild(meta);
    _container.appendChild(item);
  }
}

async function refresh(): Promise<void> {
  // Don't poll while the PWA is backgrounded/hidden.
  if (typeof document !== 'undefined' && document.hidden) return;
  const tasks = await fetchWorkers();
  renderWorkers(tasks);
}

export function createWorkersPanel(container: HTMLElement): void {
  injectWorkersStyles();

  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'cc-workers-wrap';

  const header = document.createElement('div');
  header.className = 'cc-workers-header';

  const headerLeft = document.createElement('div');
  headerLeft.innerHTML = `
    <div class="cc-workers-title">Workers</div>
    <div class="cc-workers-subtitle">Active tasks and workers</div>`;

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'cc-workers-refresh-btn';
  refreshBtn.textContent = '⟳ Refresh';
  refreshBtn.addEventListener('click', refresh);

  const autoBadge = document.createElement('span');
  autoBadge.className = 'cc-workers-auto-badge';
  autoBadge.textContent = 'Auto 5s';

  header.appendChild(headerLeft);
  header.appendChild(autoBadge);
  header.appendChild(refreshBtn);

  const list = document.createElement('div');
  list.className = 'cc-workers-list';
  _container = list;

  wrap.appendChild(header);
  wrap.appendChild(list);
  container.appendChild(wrap);

  // Initial load
  refresh();

  // Auto-refresh every 5 seconds
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(refresh, 5000);
}

export function destroyWorkersPanel(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
  _container = null;
}
