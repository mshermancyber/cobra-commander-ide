// ---------------------------------------------------------------------------
// Intake Agent panel — submit prompts, review requirements, approve & send
// ---------------------------------------------------------------------------

import theme from './theme.js';
import { switchTab } from './layout.js';

interface IntakeRequest {
  id: string;
  prompt: string;
  requirements: string | null;
  projectName: string | null;
  projectPath: string | null;
  ports: { frontend: number; backend: number } | null;
  nginxConfig: string | null;
  templateUsed: string | null;
  status: 'draft' | 'expanding' | 'review' | 'approved' | 'sent' | 'rejected';
  createdAt: number;
  updatedAt: number;
}

function getApiBase(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

async function apiCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${getApiBase()}/api/v1${path}`, opts);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export function createIntakePanel(container: HTMLElement): void {
  const style = document.createElement('style');
  style.textContent = `
    .intake-panel {
      height: 100%; display: flex; flex-direction: column;
      background: ${theme.bg}; color: ${theme.text};
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
    }
    .intake-header {
      padding: 16px 20px 12px; border-bottom: 1px solid ${theme.border};
      font-size: 16px; font-weight: 700; color: ${theme.accent};
      display: flex; justify-content: space-between; align-items: center;
    }
    .intake-header-actions { display: flex; gap: 8px; }
    .intake-body { flex: 1; overflow-y: auto; padding: 16px 20px; }

    .intake-input-area {
      background: ${theme.bgSecondary}; border: 1px solid ${theme.border};
      border-radius: 8px; padding: 16px; margin-bottom: 16px;
    }
    .intake-label {
      font-size: 11px; font-weight: 600; color: ${theme.textMuted};
      text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px;
    }
    .intake-textarea {
      width: 100%; min-height: 80px; padding: 10px 12px;
      background: ${theme.bg}; color: ${theme.text};
      border: 1px solid ${theme.border}; border-radius: 6px;
      font-family: inherit; font-size: 14px; resize: vertical;
      box-sizing: border-box;
    }
    .intake-textarea:focus { outline: none; border-color: ${theme.accent}; }
    .intake-textarea::placeholder { color: ${theme.textMuted}; }

    .intake-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 16px; border: none; border-radius: 6px;
      font-family: inherit; font-size: 13px; font-weight: 600;
      cursor: pointer; transition: opacity 0.15s;
      min-height: 44px; min-width: 44px; justify-content: center;
    }
    .intake-btn:active { opacity: 0.7; }
    .intake-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .intake-btn-primary { background: ${theme.accent}; color: #000; }
    .intake-btn-approve { background: #22c55e; color: #000; }
    .intake-btn-reject { background: #ef4444; color: #fff; }
    .intake-btn-send { background: #3b82f6; color: #fff; }
    .intake-btn-ghost {
      background: transparent; color: ${theme.textMuted};
      border: 1px solid ${theme.border};
    }

    .intake-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }

    .intake-requirements {
      background: ${theme.bgSecondary}; border: 1px solid ${theme.border};
      border-radius: 8px; padding: 16px; margin-bottom: 16px;
      white-space: pre-wrap; font-size: 13px; line-height: 1.6;
      max-height: 60vh; overflow-y: auto;
    }
    .intake-requirements h1, .intake-requirements h2, .intake-requirements h3 {
      color: ${theme.accent}; margin: 12px 0 6px;
    }
    .intake-requirements h1 { font-size: 16px; }
    .intake-requirements h2 { font-size: 14px; }

    .intake-status-badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 600; text-transform: uppercase;
    }
    .intake-status-draft { background: rgba(136,136,136,0.2); color: ${theme.textMuted}; }
    .intake-status-expanding { background: rgba(59,130,246,0.2); color: #60a5fa; }
    .intake-status-review { background: rgba(234,179,8,0.2); color: #facc15; }
    .intake-status-approved { background: rgba(34,197,94,0.2); color: #22c55e; }
    .intake-status-sent { background: rgba(168,85,247,0.2); color: #a855f7; }
    .intake-status-rejected { background: rgba(239,68,68,0.2); color: #ef4444; }

    .intake-history-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px; background: ${theme.bgSecondary};
      border: 1px solid ${theme.border}; border-radius: 6px;
      margin-bottom: 8px; cursor: pointer; transition: border-color 0.15s;
    }
    .intake-history-item:hover { border-color: ${theme.accent}; }
    .intake-history-prompt {
      font-size: 13px; color: ${theme.text}; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      margin-right: 12px;
    }
    .intake-history-meta {
      display: flex; align-items: center; gap: 8px;
      font-size: 11px; color: ${theme.textMuted}; flex-shrink: 0;
    }

    .intake-loading {
      display: flex; align-items: center; gap: 8px;
      padding: 20px; color: ${theme.textMuted}; font-size: 13px;
    }
    .intake-spinner {
      width: 16px; height: 16px; border: 2px solid ${theme.border};
      border-top-color: ${theme.accent}; border-radius: 50%;
      animation: intake-spin 0.6s linear infinite;
    }
    @keyframes intake-spin { to { transform: rotate(360deg); } }

    .intake-empty {
      text-align: center; padding: 40px 20px; color: ${theme.textMuted};
      font-size: 13px;
    }

    .intake-nginx-toggle {
      margin-top: 8px; padding: 4px 0;
    }
    .intake-nginx-toggle summary {
      cursor: pointer; font-size: 12px; color: ${theme.textMuted};
      user-select: none;
    }
    .intake-nginx-block {
      margin-top: 8px; padding: 10px; background: ${theme.bg};
      border: 1px solid ${theme.border}; border-radius: 4px;
      font-family: monospace; font-size: 12px; white-space: pre-wrap;
      overflow-x: auto;
    }

    @media (max-width: 768px) {
      .intake-body { padding: 12px; }
      .intake-header { padding: 12px 16px 10px; }
      .intake-actions { flex-direction: column; }
      .intake-btn { width: 100%; }
    }
  `;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'intake-panel';

  const header = document.createElement('div');
  header.className = 'intake-header';
  header.innerHTML = '<span>New Request</span>';

  const headerActions = document.createElement('div');
  headerActions.className = 'intake-header-actions';

  const historyBtn = document.createElement('button');
  historyBtn.className = 'intake-btn intake-btn-ghost';
  historyBtn.textContent = 'History';
  historyBtn.addEventListener('click', () => showHistory());
  headerActions.appendChild(historyBtn);
  header.appendChild(headerActions);

  const body = document.createElement('div');
  body.className = 'intake-body';

  panel.appendChild(header);
  panel.appendChild(body);
  container.appendChild(panel);

  showNewRequest();

  // Chat can hand a prompt to intake via "/build …" (see chat.ts).
  window.addEventListener('cc-build', ((e: Event) => {
    const detail = (e as CustomEvent).detail as { prompt?: string } | undefined;
    if (detail?.prompt) showNewRequest(detail.prompt, true);
  }) as EventListener);

  function showNewRequest(prefill?: string, autoSubmit = false): void {
    header.querySelector('span')!.textContent = 'New Request';
    body.innerHTML = '';

    const inputArea = document.createElement('div');
    inputArea.className = 'intake-input-area';

    const label = document.createElement('div');
    label.className = 'intake-label';
    label.textContent = 'What do you want to build?';

    const textarea = document.createElement('textarea');
    textarea.className = 'intake-textarea';
    textarea.placeholder = 'Describe your app in plain English...\ne.g. "build me a time tracking app for freelancers"';
    textarea.rows = 4;
    if (prefill) textarea.value = prefill;

    const actions = document.createElement('div');
    actions.className = 'intake-actions';

    const submitBtn = document.createElement('button');
    submitBtn.className = 'intake-btn intake-btn-primary';
    submitBtn.textContent = 'Expand Requirements';
    submitBtn.addEventListener('click', async () => {
      const prompt = textarea.value.trim();
      if (!prompt) return;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Expanding...';

      body.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'intake-loading';
      loading.innerHTML = '<div class="intake-spinner"></div><span>AI is expanding your prompt into requirements...</span>';
      body.appendChild(loading);

      try {
        const result = await apiCall('POST', '/intake/expand', { prompt }) as IntakeRequest;
        showRequestDetail(result);
      } catch (err) {
        body.innerHTML = '';
        const errDiv = document.createElement('div');
        errDiv.style.cssText = `color: #ef4444; padding: 20px; font-size: 13px;`;
        errDiv.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
        body.appendChild(errDiv);

        const retryBtn = document.createElement('button');
        retryBtn.className = 'intake-btn intake-btn-ghost';
        retryBtn.textContent = 'Back';
        retryBtn.style.marginTop = '12px';
        retryBtn.addEventListener('click', () => showNewRequest());
        body.appendChild(retryBtn);
      }
    });

    // Handed off from chat via "/build …": expand immediately.
    if (prefill && autoSubmit) {
      setTimeout(() => submitBtn.click(), 0);
    }

    actions.appendChild(submitBtn);
    inputArea.appendChild(label);
    inputArea.appendChild(textarea);
    inputArea.appendChild(actions);
    body.appendChild(inputArea);

    setTimeout(() => textarea.focus(), 100);
  }

  function renderMarkdown(text: string): string {
    return text
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/^\- \[x\] (.+)$/gm, '<div>✅ $1</div>')
      .replace(/^\- \[ \] (.+)$/gm, '<div>☐ $1</div>')
      .replace(/^\- (.+)$/gm, '<div style="padding-left:12px">• $1</div>')
      .replace(/^\d+\. (.+)$/gm, (_, text) => `<div style="padding-left:12px">${text}</div>`)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }

  function showRequestDetail(request: IntakeRequest, sentTaskId?: string): void {
    header.querySelector('span')!.textContent = request.projectName || 'Request';
    body.innerHTML = '';

    if (request.status === 'sent') {
      const sentBanner = document.createElement('div');
      sentBanner.style.cssText = `padding:10px 12px;margin-bottom:12px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.35);border-radius:6px;color:${theme.text};font-size:13px;`;
      sentBanner.textContent = `✅ Sent to the orchestrator${sentTaskId ? ` — task ${sentTaskId}` : ''}. Workers will pick it up.`;
      body.appendChild(sentBanner);
    }

    const metaRow = document.createElement('div');
    metaRow.style.cssText = 'display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap;';

    const badge = document.createElement('span');
    badge.className = `intake-status-badge intake-status-${request.status}`;
    badge.textContent = request.status;
    metaRow.appendChild(badge);

    if (request.projectPath) {
      const pathEl = document.createElement('span');
      pathEl.style.cssText = `font-size:12px;color:${theme.textMuted};font-family:monospace;`;
      pathEl.textContent = request.projectPath;
      metaRow.appendChild(pathEl);
    }
    if (request.ports) {
      const portEl = document.createElement('span');
      portEl.style.cssText = `font-size:12px;color:${theme.textMuted};`;
      portEl.textContent = `Ports: ${request.ports.frontend} / ${request.ports.backend}`;
      metaRow.appendChild(portEl);
    }
    body.appendChild(metaRow);

    const promptBox = document.createElement('div');
    promptBox.style.cssText = `font-size:13px;color:${theme.textMuted};margin-bottom:12px;padding:8px 12px;background:${theme.bgSecondary};border-radius:6px;border:1px solid ${theme.border};`;
    promptBox.textContent = `"${request.prompt}"`;
    body.appendChild(promptBox);

    // In review, requirements are editable before approval; otherwise read-only.
    let editedRequirements = request.requirements || '';
    if (request.requirements) {
      if (request.status === 'review') {
        const ta = document.createElement('textarea');
        ta.className = 'intake-requirements-edit';
        ta.value = request.requirements;
        ta.style.cssText = `width:100%;min-height:220px;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:12px;line-height:1.5;padding:10px 12px;background:${theme.bgSecondary};color:${theme.text};border:1px solid ${theme.border};border-radius:6px;resize:vertical;`;
        ta.addEventListener('input', () => { editedRequirements = ta.value; });
        const hint = document.createElement('div');
        hint.style.cssText = `font-size:11px;color:${theme.textMuted};margin:4px 0 12px;`;
        hint.textContent = 'Edit the requirements before approving — your changes are saved on Approve.';
        body.appendChild(ta);
        body.appendChild(hint);
      } else {
        const reqBox = document.createElement('div');
        reqBox.className = 'intake-requirements';
        reqBox.innerHTML = renderMarkdown(request.requirements);
        body.appendChild(reqBox);
      }
    }

    const errRow = document.createElement('div');
    errRow.style.cssText = `display:none;color:#ef4444;font-size:12px;padding:8px 12px;margin:8px 0;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:6px;`;
    const showErr = (msg: string) => { errRow.textContent = msg; errRow.style.display = 'block'; };
    body.appendChild(errRow);

    if (request.nginxConfig) {
      const details = document.createElement('details');
      details.className = 'intake-nginx-toggle';
      details.innerHTML = `<summary>Nginx Config</summary><div class="intake-nginx-block">${request.nginxConfig}</div>`;
      body.appendChild(details);
    }

    const actions = document.createElement('div');
    actions.className = 'intake-actions';

    if (request.status === 'review') {
      const approveBtn = document.createElement('button');
      approveBtn.className = 'intake-btn intake-btn-approve';
      approveBtn.textContent = 'Approve';
      approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        try {
          // Persist any edits before approving.
          if (editedRequirements !== request.requirements) {
            await apiCall('PUT', `/intake/requests/${request.id}`, { requirements: editedRequirements });
          }
          const updated = await apiCall('POST', `/intake/requests/${request.id}/approve`) as IntakeRequest;
          showRequestDetail(updated);
        } catch (err) {
          approveBtn.disabled = false;
          showErr(`Approve failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      actions.appendChild(approveBtn);

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'intake-btn intake-btn-reject';
      rejectBtn.textContent = 'Reject';
      rejectBtn.addEventListener('click', async () => {
        rejectBtn.disabled = true;
        try {
          await apiCall('POST', `/intake/requests/${request.id}/reject`);
          showNewRequest();
        } catch (err) {
          rejectBtn.disabled = false;
          showErr(`Reject failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      actions.appendChild(rejectBtn);
    }

    if (request.status === 'approved') {
      const sendBtn = document.createElement('button');
      sendBtn.className = 'intake-btn intake-btn-send';
      sendBtn.textContent = 'Send to Orchestrator';
      sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';
        try {
          // /send creates the task AND fires the orchestrator — a separate
          // POST /tasks would dispatch the same work twice.
          const sent = await apiCall('POST', `/intake/requests/${request.id}/send`) as { taskId?: string };
          const updated = await apiCall('GET', `/intake/requests/${request.id}`) as IntakeRequest;
          showRequestDetail(updated, sent && sent.taskId ? sent.taskId : undefined);
        } catch (err) {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send to Orchestrator';
          showErr(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      actions.appendChild(sendBtn);
    }

    if (request.status === 'sent') {
      const viewBtn = document.createElement('button');
      viewBtn.className = 'intake-btn intake-btn-send';
      viewBtn.textContent = '⚙ View in Workers';
      viewBtn.addEventListener('click', () => switchTab('workers'));
      actions.appendChild(viewBtn);
    }

    const backBtn = document.createElement('button');
    backBtn.className = 'intake-btn intake-btn-ghost';
    backBtn.textContent = 'New Request';
    backBtn.addEventListener('click', () => showNewRequest());
    actions.appendChild(backBtn);

    body.appendChild(actions);
  }

  async function showHistory(): Promise<void> {
    header.querySelector('span')!.textContent = 'Request History';
    body.innerHTML = '';

    const loading = document.createElement('div');
    loading.className = 'intake-loading';
    loading.innerHTML = '<div class="intake-spinner"></div><span>Loading history...</span>';
    body.appendChild(loading);

    try {
      const data = await apiCall('GET', '/intake/requests') as { requests: IntakeRequest[] };
      body.innerHTML = '';

      if (!data.requests.length) {
        const empty = document.createElement('div');
        empty.className = 'intake-empty';
        empty.textContent = 'No requests yet. Submit your first prompt above.';
        body.appendChild(empty);
      } else {
        for (const req of data.requests) {
          const item = document.createElement('div');
          item.className = 'intake-history-item';

          const promptEl = document.createElement('div');
          promptEl.className = 'intake-history-prompt';
          promptEl.textContent = req.prompt;

          const meta = document.createElement('div');
          meta.className = 'intake-history-meta';

          const badge = document.createElement('span');
          badge.className = `intake-status-badge intake-status-${req.status}`;
          badge.textContent = req.status;

          const dateEl = document.createElement('span');
          dateEl.textContent = new Date(req.createdAt).toLocaleDateString();

          meta.appendChild(badge);
          meta.appendChild(dateEl);
          item.appendChild(promptEl);
          item.appendChild(meta);
          item.addEventListener('click', () => showRequestDetail(req));
          body.appendChild(item);
        }
      }

      const backBtn = document.createElement('button');
      backBtn.className = 'intake-btn intake-btn-ghost';
      backBtn.textContent = 'New Request';
      backBtn.style.marginTop = '12px';
      backBtn.addEventListener('click', () => showNewRequest());
      body.appendChild(backBtn);
    } catch (err) {
      body.innerHTML = '';
      const errDiv = document.createElement('div');
      errDiv.style.cssText = `color: #ef4444; padding: 20px; font-size: 13px;`;
      errDiv.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
      body.appendChild(errDiv);
    }
  }
}
