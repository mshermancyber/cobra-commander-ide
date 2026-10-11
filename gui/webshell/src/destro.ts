// ---------------------------------------------------------------------------
// Destro — support/troubleshooting agent pane
// Dark-terminal aesthetic matching chat.ts theme patterns.
// ---------------------------------------------------------------------------

import theme from './theme.js';

const MIN_TAP_TARGET = 44;
const MAX_DOM_MESSAGES = 200;
const PRUNE_BATCH = 50;
const FLEET_POLL_INTERVAL = 10_000;

interface FleetHealth {
  ok: boolean;
  sessions: number;
  uptime: number;
}

interface FleetSession {
  id: string;
  status: string;
  targetDir: string;
  started: number;
  mode: string;
}

interface DestroSSEEvent {
  type: 'turn' | 'tool' | 'content' | 'approval_request' | 'approval_resolved' | 'approval_timeout' | 'result';
  turn?: number;
  status?: string;
  name?: string;
  input?: unknown;
  content?: string;
  approvalId?: string;
  tool?: string;
  sessionId?: string;
  summary?: string;
  actionsLedger?: Array<{ tool: string; input: unknown; timestamp?: number }>;
  error?: string;
}

interface LedgerEntry {
  tool: string;
  args: string;
  timestamp: number;
}

// ── API helpers ────────────────────────────────────────────────────────────

function getApiBase(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

async function destroApi(method: string, path: string, body?: unknown): Promise<unknown> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${getApiBase()}/api/v1/destro${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Destro API ${res.status}: ${text}`);
  }
  return res.json();
}

// ── CSS injection ──────────────────────────────────────────────────────────

function injectStyles(): void {
  const style = document.createElement('style');
  style.id = 'cc-destro-styles';
  style.textContent = `
    .destro-panel {
      height: 100%; display: flex; flex-direction: column;
      background: ${theme.bg}; color: ${theme.text};
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      overflow: hidden;
    }

    /* ── Header ── */
    .destro-header {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 20px;
      border-bottom: 1px solid ${theme.border};
      background: ${theme.bgSecondary};
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .destro-header-title {
      font-size: 16px; font-weight: 700; color: ${theme.accent};
      letter-spacing: 0.02em; margin-right: 4px;
    }
    .destro-mode-toggle {
      display: flex; gap: 0; border-radius: 6px;
      border: 1px solid ${theme.border}; overflow: hidden;
    }
    .destro-mode-btn {
      padding: 5px 14px;
      background: transparent;
      border: none;
      color: ${theme.textMuted};
      font-family: inherit; font-size: 12px; font-weight: 600;
      cursor: pointer; transition: background 0.15s, color 0.15s;
      min-height: ${MIN_TAP_TARGET}px;
      -webkit-tap-highlight-color: transparent;
    }
    .destro-mode-btn:not(:last-child) { border-right: 1px solid ${theme.border}; }
    .destro-mode-btn.active {
      background: ${theme.accent}; color: #000;
    }
    .destro-mode-btn:active:not(.active) { background: rgba(255,255,255,0.06); }

    /* ── Fleet status bar ── */
    .destro-fleet {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 20px;
      background: ${theme.bg};
      border-bottom: 1px solid ${theme.border};
      overflow-x: auto; overflow-y: hidden;
      flex-shrink: 0;
      -webkit-overflow-scrolling: touch;
    }
    .destro-fleet-tile {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      background: ${theme.bgSecondary};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      font-size: 11px; color: ${theme.textMuted};
      white-space: nowrap; flex-shrink: 0;
    }
    .destro-fleet-dot {
      width: 6px; height: 6px; border-radius: 50%;
      flex-shrink: 0;
    }
    .destro-fleet-dot.ok { background: ${theme.accentGreen}; box-shadow: 0 0 6px ${theme.accentGreen}; }
    .destro-fleet-dot.warn { background: ${theme.accentYellow}; box-shadow: 0 0 6px ${theme.accentYellow}; }
    .destro-fleet-dot.err { background: ${theme.accentRed}; box-shadow: 0 0 6px ${theme.accentRed}; }
    .destro-session-tile {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      background: ${theme.bgSecondary};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      font-size: 11px; color: ${theme.textMuted};
      white-space: nowrap; flex-shrink: 0;
    }
    .destro-status-badge {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 10px; font-weight: 600; text-transform: uppercase;
    }
    .destro-status-active { background: rgba(0,255,65,0.15); color: ${theme.accentGreen}; }
    .destro-status-idle { background: rgba(136,136,136,0.15); color: ${theme.textMuted}; }
    .destro-status-error { background: rgba(255,77,77,0.15); color: ${theme.accentRed}; }
    .destro-status-complete { background: rgba(0,255,65,0.1); color: ${theme.accentGreen}; }
    .destro-status-awaiting_approval { background: rgba(229,192,123,0.15); color: ${theme.accentYellow}; }

    /* ── Main body (flex row) ── */
    .destro-body {
      flex: 1; display: flex; flex-direction: row;
      overflow: hidden; min-height: 0;
    }

    /* ── Chat stream (left) ── */
    .destro-chat {
      flex: 1; display: flex; flex-direction: column;
      overflow: hidden; min-width: 0;
    }
    .destro-msgs {
      flex: 1 1 0; min-height: 0;
      overflow-y: auto; overflow-x: hidden;
      padding: 16px 0 8px;
      scroll-behavior: smooth;
      -webkit-overflow-scrolling: touch;
      display: flex; flex-direction: column;
      max-width: 800px; margin: 0 auto;
      width: 100%;
    }

    /* ── Message styles (match cc-msg from chat.ts) ── */
    .destro-msg {
      padding: 8px 24px;
      font-size: 14px; line-height: 1.6;
      animation: destro-msg-in 0.15s ease-out both;
      word-wrap: break-word; overflow-wrap: break-word;
      color: ${theme.text};
    }
    @keyframes destro-msg-in {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .destro-msg-label {
      font-size: 11px; font-weight: 600;
      color: ${theme.textMuted};
      margin-bottom: 2px;
      text-transform: uppercase; letter-spacing: 0.04em;
      line-height: 1.3;
    }
    .destro-msg-turn {
      border-left: 2px solid ${theme.accentYellow};
      margin-left: 12px;
      padding-top: 6px; padding-bottom: 6px;
      font-size: 13px;
    }
    .destro-msg-tool {
      border-left: 2px solid ${theme.accentPurple};
      margin-left: 12px;
      padding-top: 6px; padding-bottom: 6px;
      font-size: 13px;
    }
    .destro-msg-content {
      font-size: 14px;
    }
    .destro-msg-result {
      border-left: 2px solid ${theme.accentGreen};
      margin-left: 12px;
      padding-top: 6px; padding-bottom: 6px;
    }
    .destro-msg-error {
      border-left: 2px solid ${theme.accentRed};
      margin-left: 12px;
      padding-top: 6px; padding-bottom: 6px;
      color: ${theme.accentRed};
    }

    .destro-tool-preview {
      margin-top: 4px;
      padding: 6px 10px;
      background: ${theme.codeBlockBg};
      border: 1px solid ${theme.border};
      border-radius: 4px;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 11px; color: ${theme.textSecondary};
      overflow-x: auto;
      white-space: pre-wrap; word-break: break-all;
      max-height: 80px; overflow-y: auto;
    }

    /* ── Approval card ── */
    .destro-approval {
      margin: 8px 24px;
      padding: 12px 16px;
      background: ${theme.bgSecondary};
      border: 1px solid ${theme.accentYellow};
      border-radius: 8px;
      animation: destro-msg-in 0.15s ease-out both;
    }
    .destro-approval-tool {
      font-size: 12px; font-weight: 600; color: ${theme.accentYellow};
      text-transform: uppercase; letter-spacing: 0.04em;
      margin-bottom: 6px;
    }
    .destro-approval-preview {
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 11px; color: ${theme.textSecondary};
      padding: 6px 10px; background: ${theme.bg};
      border: 1px solid ${theme.border}; border-radius: 4px;
      margin-bottom: 10px;
      overflow-x: auto; white-space: pre-wrap; word-break: break-all;
      max-height: 80px; overflow-y: auto;
    }
    .destro-approval-actions {
      display: flex; gap: 8px; flex-wrap: wrap;
    }
    .destro-approval-btn {
      padding: 6px 14px; border: none; border-radius: 6px;
      font-family: inherit; font-size: 12px; font-weight: 600;
      cursor: pointer; transition: opacity 0.15s;
      min-height: ${MIN_TAP_TARGET}px;
      -webkit-tap-highlight-color: transparent;
    }
    .destro-approval-btn:active { opacity: 0.7; }
    .destro-approval-allow { background: ${theme.accentGreen}; color: #000; }
    .destro-approval-incident { background: ${theme.accentYellow}; color: #000; }
    .destro-approval-deny { background: ${theme.accentRed}; color: #fff; }

    /* ── Incident ledger sidebar ── */
    .destro-ledger {
      width: 280px; flex-shrink: 0;
      display: flex; flex-direction: column;
      background: ${theme.bgSecondary};
      border-left: 1px solid ${theme.border};
      overflow: hidden;
      transition: width 0.2s ease, min-width 0.2s ease;
    }
    .destro-ledger.collapsed {
      width: 0; min-width: 0; border-left: none;
    }
    .destro-ledger-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid ${theme.border};
      font-size: 11px; font-weight: 600; color: ${theme.textMuted};
      text-transform: uppercase; letter-spacing: 0.06em;
      flex-shrink: 0;
    }
    .destro-ledger-toggle {
      min-width: ${MIN_TAP_TARGET}px; min-height: ${MIN_TAP_TARGET}px;
      width: ${MIN_TAP_TARGET}px; height: ${MIN_TAP_TARGET}px;
      padding: 0; background: none; border: none;
      color: ${theme.textMuted}; font-size: 16px; cursor: pointer;
      border-radius: 4px; display: flex; align-items: center; justify-content: center;
      transition: color 0.15s;
      -webkit-tap-highlight-color: transparent;
      flex-shrink: 0;
    }
    .destro-ledger-toggle:hover { color: ${theme.accent}; }
    .destro-ledger-body {
      flex: 1; overflow-y: auto; padding: 8px 0;
    }
    .destro-ledger-item {
      padding: 6px 12px;
      font-size: 11px; border-bottom: 1px solid ${theme.border};
      display: flex; flex-direction: column; gap: 2px;
    }
    .destro-ledger-tool {
      font-weight: 600; color: ${theme.accentPurple};
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .destro-ledger-args {
      color: ${theme.textSecondary};
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 10px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .destro-ledger-time {
      color: ${theme.textMuted}; font-size: 10px;
    }

    /* ── Input area ── */
    .destro-input-area {
      padding: 8px 16px;
      padding-bottom: max(8px, env(safe-area-inset-bottom, 0px));
      background: ${theme.bg};
      max-width: 800px; margin: 0 auto;
      width: 100%; flex-shrink: 0;
    }
    .destro-target-row {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 6px;
    }
    .destro-target-input {
      flex: 1;
      padding: 5px 10px;
      background: ${theme.inputBg};
      color: ${theme.text};
      border: 1px solid ${theme.inputBorder};
      border-radius: 6px;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 12px;
      min-height: ${MIN_TAP_TARGET}px;
      box-sizing: border-box;
    }
    .destro-target-input:focus {
      outline: none; border-color: ${theme.inputFocusBorder};
      box-shadow: 0 0 8px rgba(0,255,65,0.08);
    }
    .destro-target-input::placeholder { color: ${theme.textMuted}; }
    .destro-session-badge {
      font-size: 11px; color: ${theme.textMuted};
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      white-space: nowrap;
    }
    .destro-input-wrap {
      display: flex; align-items: flex-end; gap: 8px;
      background: ${theme.inputAreaBg};
      border: 1px solid ${theme.border};
      border-radius: 12px;
      padding: 6px 10px 6px 14px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .destro-input-wrap:focus-within {
      border-color: rgba(0,255,65,0.4);
      box-shadow: 0 0 8px rgba(0,255,65,0.08);
    }
    .destro-input {
      flex: 1;
      background: transparent;
      color: ${theme.text};
      border: none; outline: none;
      padding: 6px 0;
      font-family: inherit; font-size: 14px; line-height: 1.45;
      resize: none;
      max-height: calc(1.45em * 4 + 12px);
      overflow-y: auto;
      -webkit-appearance: none;
    }
    .destro-input::placeholder { color: ${theme.textMuted}; }
    .destro-send-btn {
      min-width: ${MIN_TAP_TARGET}px; min-height: ${MIN_TAP_TARGET}px;
      width: ${MIN_TAP_TARGET}px; height: ${MIN_TAP_TARGET}px;
      padding: 0; display: flex; align-items: center; justify-content: center;
      background: none; border: none; cursor: pointer;
      flex-shrink: 0;
      -webkit-appearance: none;
      -webkit-tap-highlight-color: transparent;
      border-radius: 8px; transition: background 0.15s, color 0.15s;
      color: ${theme.textMuted};
    }
    .destro-send-btn.has-text { color: ${theme.accent}; }
    .destro-send-btn:active { background: rgba(0,255,65,0.10); }
    .destro-send-btn.stop-mode { color: ${theme.accentRed}; }
    .destro-send-btn.stop-mode:active { background: rgba(255,77,77,0.10); }

    /* ── Steer input ── */
    .destro-steer-row {
      display: flex; align-items: center; gap: 6px;
      margin-top: 6px;
    }
    .destro-steer-input {
      flex: 1;
      padding: 4px 8px;
      background: ${theme.bgSecondary};
      color: ${theme.text};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      font-family: inherit; font-size: 12px;
      min-height: 32px; box-sizing: border-box;
    }
    .destro-steer-input:focus {
      outline: none; border-color: ${theme.accentYellow};
    }
    .destro-steer-input::placeholder { color: ${theme.textMuted}; }
    .destro-steer-send {
      padding: 4px 10px;
      background: ${theme.bgSecondary};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      color: ${theme.accentYellow};
      font-family: inherit; font-size: 11px; font-weight: 600;
      cursor: pointer;
      min-height: 32px;
      transition: background 0.15s;
    }
    .destro-steer-send:active { background: rgba(229,192,123,0.1); }
    .destro-steer-send:disabled { opacity: 0.4; cursor: not-allowed; }

    /* ── Spinner ── */
    .destro-spinner {
      display: inline-block; width: 6px; height: 6px;
      border-radius: 50%;
      background: ${theme.accent};
      box-shadow: 0 0 6px ${theme.accent};
      animation: destro-think 1.2s ease-in-out infinite;
      flex-shrink: 0; margin-right: 6px; vertical-align: middle;
    }
    @keyframes destro-think {
      0%, 100% { opacity: 0.3; transform: scale(0.8); }
      50%      { opacity: 1;   transform: scale(1.3); }
    }

    /* ── Responsive ── */
    @media (max-width: 768px) {
      .destro-header { padding: 8px 12px; }
      .destro-fleet { padding: 4px 12px; }
      .destro-msgs { padding: 12px 0 6px; }
      .destro-msg { padding: 6px 12px; }
      .destro-input-area { padding: 6px 12px; }
      .destro-ledger {
        width: 240px;
        position: fixed; right: 0; top: 0; bottom: 0; z-index: 100;
        box-shadow: -4px 0 20px rgba(0,0,0,0.5);
      }
      .destro-ledger.collapsed {
        width: 0;
        box-shadow: none;
      }
    }
  `;
  document.head.appendChild(style);
}

// ── Main panel ─────────────────────────────────────────────────────────────

export function createDestroPanel(container: HTMLElement): void {
  injectStyles();

  // ── State ──
  let mode: 'interactive' | 'auto' = 'interactive';
  let sessionId: string | null = null;
  let abortController: AbortController | null = null;
  let isGenerating = false;
  let ledgerEntries: LedgerEntry[] = [];
  let fleetPollTimer: ReturnType<typeof setInterval> | null = null;

  // ── Build DOM ──

  const panel = document.createElement('div');
  panel.className = 'destro-panel';

  // ─ Header ─
  const header = document.createElement('div');
  header.className = 'destro-header';

  const title = document.createElement('span');
  title.className = 'destro-header-title';
  title.textContent = 'Destro';

  const modeToggle = document.createElement('div');
  modeToggle.className = 'destro-mode-toggle';

  const interactiveBtn = document.createElement('button');
  interactiveBtn.className = 'destro-mode-btn active';
  interactiveBtn.textContent = 'Interactive';

  const autoBtn = document.createElement('button');
  autoBtn.className = 'destro-mode-btn';
  autoBtn.textContent = 'Auto';

  interactiveBtn.addEventListener('click', () => {
    mode = 'interactive';
    interactiveBtn.classList.add('active');
    autoBtn.classList.remove('active');
  });
  autoBtn.addEventListener('click', () => {
    mode = 'auto';
    autoBtn.classList.add('active');
    interactiveBtn.classList.remove('active');
  });

  modeToggle.appendChild(interactiveBtn);
  modeToggle.appendChild(autoBtn);

  // Fleet tiles container in header
  const fleetInline = document.createElement('div');
  fleetInline.style.cssText = 'display:flex;align-items:center;gap:6px;margin-left:auto;overflow:hidden;';

  header.appendChild(title);
  header.appendChild(modeToggle);
  header.appendChild(fleetInline);

  // ─ Fleet bar ─
  const fleetBar = document.createElement('div');
  fleetBar.className = 'destro-fleet';

  // ─ Body ─
  const body = document.createElement('div');
  body.className = 'destro-body';

  // Chat left
  const chat = document.createElement('div');
  chat.className = 'destro-chat';

  const msgs = document.createElement('div');
  msgs.className = 'destro-msgs';

  // Input area
  const inputArea = document.createElement('div');
  inputArea.className = 'destro-input-area';

  // Target dir row
  const targetRow = document.createElement('div');
  targetRow.className = 'destro-target-row';

  const targetInput = document.createElement('input');
  targetInput.className = 'destro-target-input';
  targetInput.type = 'text';
  targetInput.placeholder = 'Target directory';
  targetInput.value = '/data';

  const sessionBadge = document.createElement('span');
  sessionBadge.className = 'destro-session-badge';
  sessionBadge.style.display = 'none';

  targetRow.appendChild(targetInput);
  targetRow.appendChild(sessionBadge);

  // Message wrap
  const inputWrap = document.createElement('div');
  inputWrap.className = 'destro-input-wrap';

  const textarea = document.createElement('textarea');
  textarea.className = 'destro-input';
  textarea.placeholder = 'Describe the issue or task for Destro...';
  textarea.rows = 1;

  const sendBtn = document.createElement('button');
  sendBtn.className = 'destro-send-btn';
  sendBtn.innerHTML = '▲';
  sendBtn.title = 'Send';
  sendBtn.disabled = true;

  inputWrap.appendChild(textarea);
  inputWrap.appendChild(sendBtn);

  // Steer row
  const steerRow = document.createElement('div');
  steerRow.className = 'destro-steer-row';
  steerRow.style.display = 'none';

  const steerInput = document.createElement('input');
  steerInput.className = 'destro-steer-input';
  steerInput.type = 'text';
  steerInput.placeholder = 'Steer: mid-task guidance...';

  const steerSendBtn = document.createElement('button');
  steerSendBtn.className = 'destro-steer-send';
  steerSendBtn.textContent = 'Steer';

  steerRow.appendChild(steerInput);
  steerRow.appendChild(steerSendBtn);

  inputArea.appendChild(targetRow);
  inputArea.appendChild(inputWrap);
  inputArea.appendChild(steerRow);

  chat.appendChild(msgs);
  chat.appendChild(inputArea);

  // Ledger right
  const ledger = document.createElement('div');
  ledger.className = 'destro-ledger';

  const ledgerHeader = document.createElement('div');
  ledgerHeader.className = 'destro-ledger-header';

  const ledgerTitle = document.createElement('span');
  ledgerTitle.textContent = 'Incident Ledger';

  const ledgerCount = document.createElement('span');
  ledgerCount.style.cssText = `font-size:10px;color:${theme.textMuted};`;
  ledgerCount.textContent = '';

  const ledgerToggleBtn = document.createElement('button');
  ledgerToggleBtn.className = 'destro-ledger-toggle';
  ledgerToggleBtn.innerHTML = '»';
  ledgerToggleBtn.title = 'Toggle ledger';

  const ledgerLeft = document.createElement('span');
  ledgerLeft.style.cssText = 'display:flex;align-items:center;gap:6px;';
  ledgerLeft.appendChild(ledgerTitle);
  ledgerLeft.appendChild(ledgerCount);

  ledgerHeader.appendChild(ledgerLeft);
  ledgerHeader.appendChild(ledgerToggleBtn);

  const ledgerBody = document.createElement('div');
  ledgerBody.className = 'destro-ledger-body';

  ledger.appendChild(ledgerHeader);
  ledger.appendChild(ledgerBody);

  // Toggle
  let ledgerOpen = true;
  ledgerToggleBtn.addEventListener('click', () => {
    ledgerOpen = !ledgerOpen;
    if (ledgerOpen) {
      ledger.classList.remove('collapsed');
      ledgerToggleBtn.innerHTML = '»';
    } else {
      ledger.classList.add('collapsed');
      ledgerToggleBtn.innerHTML = '«';
    }
  });

  body.appendChild(chat);
  body.appendChild(ledger);

  panel.appendChild(header);
  panel.appendChild(fleetBar);
  panel.appendChild(body);

  container.appendChild(panel);

  // ── Functions ──

  function appendMessage(type: string, label: string, bodyText: string, extraClass = ''): HTMLElement {
    const msg = document.createElement('div');
    msg.className = `destro-msg ${extraClass}`;

    const lbl = document.createElement('div');
    lbl.className = 'destro-msg-label';
    lbl.textContent = label;

    const content = document.createElement('div');
    content.textContent = bodyText;

    msg.appendChild(lbl);
    msg.appendChild(content);
    msgs.appendChild(msg);

    pruneMessages();
    scrollToBottom();

    return msg;
  }

  function pruneMessages(): void {
    while (msgs.children.length > MAX_DOM_MESSAGES) {
      for (let i = 0; i < PRUNE_BATCH && msgs.firstChild; i++) {
        msgs.firstChild.remove();
      }
    }
  }

  function scrollToBottom(): void {
    requestAnimationFrame(() => {
      msgs.scrollTop = msgs.scrollHeight;
    });
  }

  function addLedgerEntry(tool: string, args: unknown): void {
    const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    const truncated = argsStr.length > 120 ? argsStr.slice(0, 120) + '…' : argsStr;

    ledgerEntries.push({
      tool,
      args: truncated,
      timestamp: Date.now(),
    });

    renderLedger();
  }

  function renderLedger(): void {
    ledgerBody.innerHTML = '';

    for (const entry of ledgerEntries) {
      const item = document.createElement('div');
      item.className = 'destro-ledger-item';

      const toolEl = document.createElement('div');
      toolEl.className = 'destro-ledger-tool';
      toolEl.textContent = entry.tool;

      const argsEl = document.createElement('div');
      argsEl.className = 'destro-ledger-args';
      argsEl.textContent = entry.args;

      const timeEl = document.createElement('div');
      timeEl.className = 'destro-ledger-time';
      timeEl.textContent = new Date(entry.timestamp).toLocaleTimeString();

      item.appendChild(toolEl);
      item.appendChild(argsEl);
      item.appendChild(timeEl);
      ledgerBody.appendChild(item);
    }

    ledgerCount.textContent = ledgerEntries.length > 0 ? `(${ledgerEntries.length})` : '';
    ledgerBody.scrollTop = ledgerBody.scrollHeight;
  }

  function renderApprovalCard(
    approvalId: string,
    tool: string,
    input: unknown,
  ): void {
    const card = document.createElement('div');
    card.className = 'destro-approval';

    const toolLabel = document.createElement('div');
    toolLabel.className = 'destro-approval-tool';
    toolLabel.textContent = `Approval: ${tool}`;

    const preview = document.createElement('div');
    preview.className = 'destro-approval-preview';

    const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? {}, null, 2);
    preview.textContent = inputStr.length > 300 ? inputStr.slice(0, 300) + '…' : inputStr;

    const actions = document.createElement('div');
    actions.className = 'destro-approval-actions';

    const allowBtn = document.createElement('button');
    allowBtn.className = 'destro-approval-btn destro-approval-allow';
    allowBtn.textContent = 'Allow';

    const incidentBtn = document.createElement('button');
    incidentBtn.className = 'destro-approval-btn destro-approval-incident';
    incidentBtn.textContent = 'Allow for incident';

    const denyBtn = document.createElement('button');
    denyBtn.className = 'destro-approval-btn destro-approval-deny';
    denyBtn.textContent = 'Deny';

    async function handleDecision(decision: 'allow' | 'allow_incident' | 'deny'): Promise<void> {
      if (!sessionId) return;
      allowBtn.disabled = true;
      incidentBtn.disabled = true;
      denyBtn.disabled = true;

      try {
        await destroApi('POST', `/sessions/${sessionId}/approve`, { approvalId, decision });
        if (decision === 'deny') {
          await destroApi('POST', `/sessions/${sessionId}/abort`, {});
        }
      } catch (err) {
        console.error('Destro approval error:', err);
      }

      card.style.opacity = '0.5';
      actions.innerHTML = '';
      const resolved = document.createElement('span');
      resolved.style.cssText = `font-size:11px;color:${theme.textMuted};`;
      resolved.textContent = decision === 'deny' ? 'Denied' : `Approved (${decision})`;
      actions.appendChild(resolved);
    }

    allowBtn.addEventListener('click', () => handleDecision('allow'));
    incidentBtn.addEventListener('click', () => handleDecision('allow_incident'));
    denyBtn.addEventListener('click', () => handleDecision('deny'));

    actions.appendChild(allowBtn);
    actions.appendChild(incidentBtn);
    actions.appendChild(denyBtn);

    card.appendChild(toolLabel);
    card.appendChild(preview);
    card.appendChild(actions);
    msgs.appendChild(card);

    pruneMessages();
    scrollToBottom();
  }

  // ── SSE Chat ──

  async function sendMessage(): Promise<void> {
    const text = textarea.value.trim();
    const targetDir = targetInput.value.trim() || '/data';
    if (!text && !isGenerating) return;
    if (isGenerating) {
      stopGeneration();
      return;
    }

    textarea.value = '';
    textarea.style.height = 'auto';
    updateSendBtn();

    // Append user message
    appendMessage('user', 'You', text);

    // Show generating state
    isGenerating = true;
    sendBtn.classList.add('stop-mode');
    sendBtn.innerHTML = '■';
    sendBtn.title = 'Stop';
    sendBtn.disabled = false;
    steerRow.style.display = 'flex';

    if (sessionId) {
      sessionBadge.textContent = `Session: ${sessionId.slice(0, 12)}…`;
      sessionBadge.style.display = 'inline';
    }

    const thinkingMsg = document.createElement('div');
    thinkingMsg.className = 'destro-msg';
    thinkingMsg.innerHTML = `<span class="destro-msg-label"><span class="destro-spinner"></span>Destro</span>`;
    msgs.appendChild(thinkingMsg);
    scrollToBottom();

    abortController = new AbortController();

    try {
      const resp = await fetch(`${getApiBase()}/api/v1/destro/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          message: text,
          targetDir,
          mode,
          sessionId: sessionId || undefined,
        }),
        signal: abortController.signal,
      });

      // Remove thinking
      thinkingMsg.remove();

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event: DestroSSEEvent = JSON.parse(jsonStr);
            handleSSEEvent(event);
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      // Flush remaining buffer
      if (buffer.startsWith('data: ')) {
        const jsonStr = buffer.slice(6).trim();
        if (jsonStr) {
          try {
            const event: DestroSSEEvent = JSON.parse(jsonStr);
            handleSSEEvent(event);
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        appendMessage('system', 'Destro', 'Session aborted.', 'destro-msg-error');
      } else {
        appendMessage('system', 'Error', (err as Error).message, 'destro-msg-error');
      }
    } finally {
      isGenerating = false;
      abortController = null;
      sendBtn.classList.remove('stop-mode');
      sendBtn.innerHTML = '▲';
      sendBtn.title = 'Send';
      updateSendBtn();
      steerRow.style.display = sessionId ? 'flex' : 'none';
    }
  }

  function handleSSEEvent(event: DestroSSEEvent): void {
    switch (event.type) {
      case 'turn':
        if (event.turn !== undefined) {
          const statusText = event.status ? ` (${event.status})` : '';
          appendMessage('assistant', `Destro — Turn ${event.turn}${statusText}`, '', 'destro-msg-turn');
        }
        break;

      case 'tool':
        if (event.name) {
          const argsPreview = typeof event.input === 'string'
            ? event.input
            : JSON.stringify(event.input ?? {});
          const truncatedPreview = argsPreview.length > 200
            ? argsPreview.slice(0, 200) + '…'
            : argsPreview;

          const msg = document.createElement('div');
          msg.className = 'destro-msg destro-msg-tool';

          const lbl = document.createElement('div');
          lbl.className = 'destro-msg-label';
          lbl.textContent = `Tool: ${event.name}`;

          const preview = document.createElement('div');
          preview.className = 'destro-tool-preview';
          preview.textContent = truncatedPreview;

          msg.appendChild(lbl);
          msg.appendChild(preview);
          msgs.appendChild(msg);

          addLedgerEntry(event.name, event.input);
          pruneMessages();
          scrollToBottom();
        }
        break;

      case 'content':
        if (event.content) {
          appendMessage('assistant', 'Destro', event.content, 'destro-msg-content');
        }
        break;

      case 'approval_request':
        if (event.approvalId && event.tool) {
          renderApprovalCard(event.approvalId, event.tool, event.input);
        }
        break;

      case 'approval_resolved':
      case 'approval_timeout':
        appendMessage('system', 'Approval', `Approval ${event.approvalId || ''} ${event.type === 'approval_resolved' ? 'resolved' : 'timed out'}`, '');
        break;

      case 'result': {
        const statusText = event.status === 'error' ? 'ERROR' : 'COMPLETE';
        const cssClass = event.status === 'error' ? 'destro-msg-error' : 'destro-msg-result';

        const msg = document.createElement('div');
        msg.className = `destro-msg ${cssClass}`;

        const lbl = document.createElement('div');
        lbl.className = 'destro-msg-label';
        lbl.textContent = `Destro — ${statusText}`;

        const summary = document.createElement('div');
        summary.textContent = event.summary || (event.error ? `Error: ${event.error}` : 'Done.');

        msg.appendChild(lbl);
        msg.appendChild(summary);
        msgs.appendChild(msg);

        // Populate ledger from result
        if (event.actionsLedger && Array.isArray(event.actionsLedger)) {
          for (const entry of event.actionsLedger) {
            addLedgerEntry(entry.tool, entry.input);
          }
        }

        pruneMessages();
        scrollToBottom();

        // Update session badge
        if (sessionId) {
          sessionBadge.textContent = `Session: ${sessionId.slice(0, 12)}…`;
          sessionBadge.style.display = 'inline';
        }
        break;
      }
    }
  }

  function stopGeneration(): void {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (sessionId) {
      destroApi('POST', `/sessions/${sessionId}/abort`, {}).catch(() => {});
    }
    isGenerating = false;
    sendBtn.classList.remove('stop-mode');
    sendBtn.innerHTML = '▲';
    sendBtn.title = 'Send';
    updateSendBtn();
    steerRow.style.display = sessionId ? 'flex' : 'none';
  }

  // ── Input handlers ──

  function updateSendBtn(): void {
    const hasText = textarea.value.trim().length > 0;
    if (hasText) {
      sendBtn.classList.add('has-text');
    } else {
      sendBtn.classList.remove('has-text');
    }
    sendBtn.disabled = !hasText && !isGenerating;
  }

  textarea.addEventListener('input', () => {
    updateSendBtn();
    // Auto-resize
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  // Steer
  steerSendBtn.addEventListener('click', async () => {
    const steerText = steerInput.value.trim();
    if (!steerText || !sessionId) return;

    steerSendBtn.disabled = true;
    try {
      await destroApi('POST', `/sessions/${sessionId}/steer`, { message: steerText });
      steerInput.value = '';
      appendMessage('system', 'Steer', `Mid-task guidance sent: "${steerText}"`, '');
    } catch (err) {
      appendMessage('system', 'Error', `Steer failed: ${(err as Error).message}`, 'destro-msg-error');
    } finally {
      steerSendBtn.disabled = false;
    }
  });

  steerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      steerSendBtn.click();
    }
  });

  // ── Session resume from URL ──

  function checkURLForSession(): void {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get('destroSession');
    if (sid) {
      sessionId = sid;
      sessionBadge.textContent = `Session: ${sid.slice(0, 12)}…`;
      sessionBadge.style.display = 'inline';
      steerRow.style.display = 'flex';
      // Fetch session details and populate ledger
      destroApi('GET', `/sessions/${sid}`)
        .then((data) => {
          const sessionData = data as {
            id: string;
            status: string;
            targetDir: string;
            mode: string;
            started: number;
            incidentSummary?: string;
            actionsLedger?: Array<{ tool: string; input: unknown; timestamp?: number }>;
          };
          if (sessionData.targetDir) targetInput.value = sessionData.targetDir;
          if (sessionData.mode === 'auto' || sessionData.mode === 'interactive') {
            mode = sessionData.mode as 'interactive' | 'auto';
            if (mode === 'auto') {
              autoBtn.classList.add('active');
              interactiveBtn.classList.remove('active');
            }
          }
          // Populate ledger from existing session
          if (sessionData.actionsLedger && Array.isArray(sessionData.actionsLedger)) {
            ledgerEntries = [];
            for (const entry of sessionData.actionsLedger) {
              const argsStr = typeof entry.input === 'string'
                ? entry.input
                : JSON.stringify(entry.input ?? {});
              const truncated = argsStr.length > 120 ? argsStr.slice(0, 120) + '…' : argsStr;
              ledgerEntries.push({
                tool: entry.tool,
                args: truncated,
                timestamp: entry.timestamp || Date.now(),
              });
            }
            renderLedger();
          }
          appendMessage('system', 'Session', `Resumed session ${sid.slice(0, 12)}… (${sessionData.status})`, '');
        })
        .catch(() => {
          appendMessage('system', 'Warning', `Could not resume session ${sid.slice(0, 12)}…`, 'destro-msg-error');
        });
    }
  }

  // ── Fleet polling ──

  async function pollFleet(): Promise<void> {
    try {
      const health = await destroApi('GET', '/health') as FleetHealth;
      const sessions = await destroApi('GET', '/sessions') as FleetSession[];

      // Inline fleet (header)
      fleetInline.innerHTML = '';

      const healthDot = document.createElement('span');
      healthDot.className = `destro-fleet-dot ${health.ok ? 'ok' : 'err'}`;
      healthDot.title = health.ok ? 'Healthy' : 'Unhealthy';

      const healthText = document.createElement('span');
      healthText.style.cssText = `font-size:11px;color:${theme.textMuted};white-space:nowrap;`;
      healthText.textContent = `${health.sessions} session${health.sessions !== 1 ? 's' : ''}`;

      const uptimeText = document.createElement('span');
      uptimeText.style.cssText = `font-size:10px;color:${theme.textMuted};white-space:nowrap;`;
      const uptimeMins = Math.floor(health.uptime / 60);
      uptimeText.textContent = uptimeMins < 120
        ? `${uptimeMins}m`
        : `${Math.floor(uptimeMins / 60)}h ${uptimeMins % 60}m`;

      fleetInline.appendChild(healthDot);
      fleetInline.appendChild(healthText);
      fleetInline.appendChild(uptimeText);

      // Fleet bar
      fleetBar.innerHTML = '';

      // Health tile
      const healthTile = document.createElement('div');
      healthTile.className = 'destro-fleet-tile';
      healthTile.innerHTML = `<span class="destro-fleet-dot ${health.ok ? 'ok' : 'err'}"></span>${health.ok ? 'Healthy' : 'Down'} · ${health.sessions} sessions · ${uptimeMins}m up`;
      fleetBar.appendChild(healthTile);

      // Session tiles
      for (const s of sessions) {
        const tile = document.createElement('div');
        tile.className = 'destro-session-tile';
        tile.title = `ID: ${s.id}\nDir: ${s.targetDir}\nMode: ${s.mode}`;

        let statusClass = 'destro-status-idle';
        if (s.status === 'active' || s.status === 'running') statusClass = 'destro-status-active';
        else if (s.status === 'error') statusClass = 'destro-status-error';
        else if (s.status === 'complete' || s.status === 'done') statusClass = 'destro-status-complete';
        else if (s.status === 'awaiting_approval') statusClass = 'destro-status-awaiting_approval';

        tile.innerHTML = `
          <span style="font-family:monospace;font-size:10px;color:${theme.textMuted};">${s.id.slice(0, 8)}</span>
          <span class="destro-status-badge ${statusClass}">${s.status}</span>
          <span style="font-size:10px;color:${theme.textMuted};">${s.mode}</span>
        `;

        tile.addEventListener('click', () => {
          sessionId = s.id;
          sessionBadge.textContent = `Session: ${s.id.slice(0, 12)}…`;
          sessionBadge.style.display = 'inline';
          steerRow.style.display = 'flex';
          targetInput.value = s.targetDir;
          if (s.mode === 'auto') {
            mode = 'auto';
            autoBtn.classList.add('active');
            interactiveBtn.classList.remove('active');
          } else {
            mode = 'interactive';
            interactiveBtn.classList.add('active');
            autoBtn.classList.remove('active');
          }

          // Load session ledger
          destroApi('GET', `/sessions/${s.id}`).then((data) => {
            const sd = data as {
              actionsLedger?: Array<{ tool: string; input: unknown; timestamp?: number }>;
            };
            if (sd.actionsLedger && Array.isArray(sd.actionsLedger)) {
              ledgerEntries = [];
              for (const entry of sd.actionsLedger) {
                const argsStr = typeof entry.input === 'string'
                  ? entry.input
                  : JSON.stringify(entry.input ?? {});
                const truncated = argsStr.length > 120 ? argsStr.slice(0, 120) + '…' : argsStr;
                ledgerEntries.push({
                  tool: entry.tool,
                  args: truncated,
                  timestamp: entry.timestamp || Date.now(),
                });
              }
              renderLedger();
            }
          }).catch(() => {});
        });

        fleetBar.appendChild(tile);
      }
    } catch {
      // Fleet poll failed silently
    }
  }

  // Start polling
  pollFleet();
  fleetPollTimer = setInterval(pollFleet, FLEET_POLL_INTERVAL);

  // Check URL for session param
  checkURLForSession();

  // Cleanup on panel removal
  const observer = new MutationObserver(() => {
    if (!panel.isConnected) {
      if (fleetPollTimer) clearInterval(fleetPollTimer);
      observer.disconnect();
    }
  });
  observer.observe(container, { childList: true });
}
