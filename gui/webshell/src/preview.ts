// ---------------------------------------------------------------------------
// Preview tab — split layout: mini chat (left) + file preview (right)
// ---------------------------------------------------------------------------

import theme from './theme.js';
import type { ChatController } from './chat.js';

let _currentPath = '';
let _lastEditedPath = '';
let _currentDocFormat = ''; // 'docx', 'doc', 'pdf' — empty means not a document
let _iframeEl: HTMLIFrameElement | null = null;
let _pathBarEl: HTMLElement | null = null;
let _activeDevice: 'desktop' | 'tablet' | 'mobile' = 'desktop';
let _chatController: ChatController | null = null;
let _previewMsgsEl: HTMLElement | null = null;
let _exportBtnEl: HTMLButtonElement | null = null;
let _exportDropdownEl: HTMLElement | null = null;

const DEVICE_WIDTHS = { desktop: '100%', tablet: '768px', mobile: '375px' };

function injectPreviewStyles(): void {
  if (document.getElementById('cc-preview-styles')) return;
  const style = document.createElement('style');
  style.id = 'cc-preview-styles';
  style.textContent = `
    .cc-preview-split {
      display: flex;
      flex-direction: row;
      height: 100%;
      overflow: hidden;
    }
    .cc-preview-chat {
      width: 38%;
      min-width: 260px;
      max-width: 420px;
      display: flex;
      flex-direction: column;
      background: ${theme.bg};
      border-right: 1px solid ${theme.border};
      overflow: hidden;
    }
    .cc-preview-chat-header {
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 600;
      color: ${theme.textMuted};
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 1px solid ${theme.border};
      background: ${theme.bgSecondary};
    }
    .cc-preview-chat-msgs {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .cc-preview-chat-msg {
      font-size: 13px;
      line-height: 1.5;
      color: ${theme.text};
    }
    .cc-preview-chat-msg.user { color: ${theme.textMuted}; }
    .cc-preview-chat-msg.user::before { content: 'You: '; font-weight: 600; color: ${theme.text}; }
    .cc-preview-chat-msg.assistant::before { content: 'the worker model: '; font-weight: 600; color: ${theme.accent}; }
    .cc-preview-chat-msg.system { font-size: 11px; color: ${theme.textMuted}; font-style: italic; }
    .cc-preview-chat-input-area {
      padding: 8px 12px;
      border-top: 1px solid ${theme.border};
      background: ${theme.bgSecondary};
      display: flex;
      gap: 6px;
    }
    .cc-preview-chat-input {
      flex: 1;
      background: ${theme.inputAreaBg};
      color: ${theme.text};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      padding: 7px 10px;
      font-family: inherit;
      font-size: 13px;
      outline: none;
      resize: none;
    }
    .cc-preview-chat-input:focus { border-color: rgba(0,255,65,0.4); }
    .cc-preview-chat-input::placeholder { color: ${theme.textMuted}; }
    .cc-preview-chat-send {
      width: 32px;
      height: 32px;
      background: none;
      border: 1px solid ${theme.border};
      border-radius: 6px;
      color: ${theme.accent};
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
    }
    .cc-preview-chat-send:hover { border-color: ${theme.accent}; }

    .cc-preview-wrap {
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      background: ${theme.bg};
    }
    .cc-preview-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: ${theme.bgSecondary};
      border-bottom: 1px solid ${theme.border};
      min-height: 36px;
      flex-shrink: 0;
    }
    .cc-preview-path {
      flex: 1;
      background: ${theme.inputAreaBg};
      color: ${theme.text};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      padding: 5px 10px;
      font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
      font-size: 12px;
      outline: none;
      cursor: pointer;
      text-overflow: ellipsis;
      overflow: hidden;
      white-space: nowrap;
    }
    .cc-preview-path:focus { border-color: rgba(0,255,65,0.4); }
    .cc-preview-path::placeholder { color: ${theme.textMuted}; }
    .cc-preview-picker {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      max-height: 320px;
      overflow-y: auto;
      background: ${theme.bgSecondary};
      border: 1px solid ${theme.border};
      border-radius: 0 0 8px 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      z-index: 100;
      display: none;
    }
    .cc-preview-picker.open { display: block; }
    .cc-preview-picker-breadcrumb {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 6px 10px;
      font-size: 11px;
      color: ${theme.textMuted};
      border-bottom: 1px solid ${theme.border};
      flex-wrap: wrap;
    }
    .cc-preview-picker-crumb {
      background: none;
      border: none;
      color: ${theme.accent};
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      padding: 1px 3px;
      border-radius: 3px;
    }
    .cc-preview-picker-crumb:hover { background: rgba(0,255,65,0.08); }
    .cc-preview-picker-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      cursor: pointer;
      color: ${theme.text};
      font-size: 12px;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      font-family: inherit;
    }
    .cc-preview-picker-item:hover { background: rgba(255,255,255,0.04); }
    .cc-preview-picker-item.dir { color: ${theme.accent}; }
    .cc-preview-picker-item.file { color: ${theme.text}; }
    .cc-preview-picker-item.previewable { font-weight: 600; }
    .cc-preview-picker-icon { width: 16px; text-align: center; font-size: 12px; flex-shrink: 0; }
    .cc-preview-btn {
      padding: 5px 10px;
      background: none;
      color: ${theme.textMuted};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      transition: color 0.12s, border-color 0.12s;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .cc-preview-btn:hover { color: ${theme.text}; border-color: ${theme.text}; }
    .cc-preview-btn.active { color: ${theme.accent}; border-color: ${theme.accent}; }
    .cc-preview-device-group {
      display: flex;
      gap: 2px;
      margin-left: 4px;
    }
    .cc-preview-device-btn {
      padding: 4px 8px;
      background: none;
      color: ${theme.textMuted};
      border: 1px solid ${theme.border};
      font-size: 13px;
      cursor: pointer;
      transition: color 0.12s, border-color 0.12s, background 0.12s;
    }
    .cc-preview-device-btn:first-child { border-radius: 6px 0 0 6px; }
    .cc-preview-device-btn:last-child { border-radius: 0 6px 6px 0; }
    .cc-preview-device-btn:not(:first-child) { border-left: none; }
    .cc-preview-device-btn:hover { color: ${theme.text}; }
    .cc-preview-device-btn.active {
      color: ${theme.accent};
      border-color: ${theme.accent};
      background: rgba(0,255,65,0.06);
    }
    .cc-preview-viewport {
      flex: 1;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      overflow: auto;
      background: #111;
      padding: 0;
    }
    .cc-preview-iframe {
      border: none;
      background: #fff;
      height: 100%;
      transition: width 0.25s ease;
    }
    .cc-preview-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: ${theme.textMuted};
      font-size: 14px;
      gap: 8px;
    }
    .cc-preview-empty-icon { font-size: 32px; opacity: 0.4; }
    .cc-preview-empty-hint { font-size: 12px; }
    .cc-preview-export-wrap {
      position: relative;
      flex-shrink: 0;
    }
    .cc-preview-export-dropdown {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 2px;
      background: ${theme.bgSecondary};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      z-index: 101;
      display: none;
      min-width: 140px;
      overflow: hidden;
    }
    .cc-preview-export-dropdown.open { display: block; }
    .cc-preview-export-item {
      display: block;
      width: 100%;
      padding: 6px 14px;
      background: none;
      border: none;
      color: ${theme.text};
      font-family: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .cc-preview-export-item:hover { background: rgba(255,255,255,0.06); }
    .cc-preview-export-item:disabled { color: ${theme.textMuted}; cursor: not-allowed; }
    @keyframes fadeOut { 0% { opacity: 1; } 100% { opacity: 0; } }
  `;
  document.head.appendChild(style);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fetchFileContent(filePath: string): Promise<string> {
  try {
    const resp = await fetch(`/api/v1/files?path=${encodeURIComponent(filePath)}`);
    if (!resp.ok) return `<html><body><h1>Error loading ${filePath}</h1><p>Status: ${resp.status}</p></body></html>`;
    const data = await resp.json();
    return data.content || '';
  } catch (e) {
    return `<html><body><h1>Error</h1><p>${e}</p></body></html>`;
  }
}

function setDeviceWidth(device: 'desktop' | 'tablet' | 'mobile'): void {
  _activeDevice = device;
  if (_iframeEl) {
    _iframeEl.style.width = DEVICE_WIDTHS[device];
  }
  document.querySelectorAll('.cc-preview-device-btn').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.device === device);
  });
}

// ── Export button visibility ──
function updateExportButton(): void {
  const isDoc = _currentDocFormat !== '';
  if (_exportBtnEl) {
    _exportBtnEl.parentElement!.style.display = isDoc ? '' : 'none';
  }
  if (_exportDropdownEl) {
    _exportDropdownEl.classList.remove('open');
  }
}

async function doDocumentExport(format: string): Promise<void> {
  if (!_iframeEl) return;
  const html = _iframeEl.srcdoc || '';
  if (!html) return;

  const basePath = _currentPath.replace(/\.(docx|doc|pdf)$/i, '');
  const ext = format === 'pdf' ? '.pdf' : '.docx';
  const outputPath = `${basePath}-updated${ext}`;

  if (_exportBtnEl) {
    _exportBtnEl.textContent = '⏳ ...';
    _exportBtnEl.disabled = true;
  }

  try {
    const resp = await fetch('/api/v1/documents/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, outputPath, format }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      alert(`Export failed: ${data.error || resp.status}`);
      return;
    }
    // Success toast
    const viewport = _iframeEl.parentElement;
    if (viewport) {
      const toast = document.createElement('div');
      toast.textContent = `✓ Exported: ${data.path}`;
      toast.style.cssText = `
        position: absolute; top: 8px; right: 8px; padding: 4px 10px;
        background: rgba(0,255,65,0.15); color: #0f0; border-radius: 4px;
        font-size: 11px; font-weight: 600; z-index: 10; pointer-events: none;
        animation: fadeOut 2.5s ease forwards;
      `;
      viewport.style.position = 'relative';
      viewport.appendChild(toast);
      setTimeout(() => toast.remove(), 2500);
    }
  } catch (e) {
    alert(`Export error: ${e}`);
  } finally {
    if (_exportBtnEl) {
      _exportBtnEl.textContent = '⤓ Export';
      _exportBtnEl.disabled = false;
    }
  }
}

async function loadPreview(filePath: string): Promise<void> {
  if (!filePath || !_iframeEl) return;
  _currentPath = filePath;
  _currentDocFormat = '';
  if (_pathBarEl) _pathBarEl.textContent = filePath;

  const docExt = filePath.match(/\.(docx|doc|pdf)$/i)?.[0]?.toLowerCase();
  if (docExt) {
    _currentDocFormat = docExt.replace('.', '');
    try {
      const resp = await fetch('/api/v1/documents/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, format: 'html' }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `Status ${resp.status}` }));
        _iframeEl.srcdoc = `<html><body><h1>Conversion Error</h1><p>${err.error || resp.status}</p></body></html>`;
        updateExportButton();
        return;
      }
      const data = await resp.json();
      _iframeEl.srcdoc = data.html;
    } catch (e) {
      _iframeEl.srcdoc = `<html><body><h1>Error</h1><p>${e}</p></body></html>`;
    }
    // Hide empty state
    const empty = _iframeEl.parentElement?.querySelector('.cc-preview-empty') as HTMLElement;
    if (empty) empty.style.display = 'none';
    updateExportButton();
    return;
  }

  const content = await fetchFileContent(filePath);

  const isHtml = filePath.endsWith('.html') || filePath.endsWith('.htm');
  if (isHtml) {
    _iframeEl.srcdoc = content;
  } else if (filePath.endsWith('.md')) {
    _iframeEl.srcdoc = `<html><head><style>body{font-family:system-ui,sans-serif;padding:24px;max-width:800px;margin:0 auto;line-height:1.6;color:#222}</style></head><body><pre style="white-space:pre-wrap">${escapeHtml(content)}</pre></body></html>`;
  } else if (filePath.endsWith('.css')) {
    _iframeEl.srcdoc = `<html><head><style>${content}</style></head><body><h2>CSS Preview</h2><p>Styles loaded from ${escapeHtml(filePath)}</p><div class="demo"><h3>Heading</h3><p>Paragraph text. <a href="#">Link</a>. <strong>Bold</strong>. <em>Italic</em>.</p></div></body></html>`;
  } else if (filePath.match(/\.(png|jpg|jpeg|gif|svg|webp|ico)$/i)) {
    _iframeEl.srcdoc = `<html><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5"><img src="/api/v1/files?path=${encodeURIComponent(filePath)}&raw=1" style="max-width:100%;max-height:100vh" /></body></html>`;
  } else {
    _iframeEl.srcdoc = `<html><head><style>body{font-family:'SF Mono',Menlo,Consolas,monospace;padding:16px;font-size:13px;line-height:1.5;color:#222;background:#fafafa}</style></head><body><pre>${escapeHtml(content)}</pre></body></html>`;
  }

  // Hide empty state
  const empty = _iframeEl.parentElement?.querySelector('.cc-preview-empty') as HTMLElement;
  if (empty) empty.style.display = 'none';

  // Hide export button for non-document files
  updateExportButton();
}

export function previewFile(path: string): void {
  loadPreview(path);
}

export function connectPreviewChat(chat: ChatController): void {
  _chatController = chat;

  let assistantContent = '';

  chat.onMessage((msg: any) => {
    if (!_previewMsgsEl) return;

    // Only process messages for the preview channel, plus tool_activity (shared)
    if (msg.channel && msg.channel !== 'preview') return;

    if (msg.type === 'text') {
      assistantContent += msg.content || '';
      let lastAssistant = _previewMsgsEl.querySelector('.cc-preview-chat-msg.assistant:last-child') as HTMLElement;
      if (!lastAssistant || lastAssistant.dataset.done === 'true') {
        lastAssistant = document.createElement('div');
        lastAssistant.className = 'cc-preview-chat-msg assistant';
        _previewMsgsEl.appendChild(lastAssistant);
      }
      lastAssistant.textContent = assistantContent;
      _previewMsgsEl.scrollTop = _previewMsgsEl.scrollHeight;
    } else if (msg.type === 'done') {
      assistantContent = '';
      const lastAssistant = _previewMsgsEl.querySelector('.cc-preview-chat-msg.assistant:last-child') as HTMLElement;
      if (lastAssistant) lastAssistant.dataset.done = 'true';
    } else if (msg.type === 'error') {
      const el = document.createElement('div');
      el.className = 'cc-preview-chat-msg system';
      el.textContent = `Error: ${msg.message}`;
      _previewMsgsEl.appendChild(el);
      _previewMsgsEl.scrollTop = _previewMsgsEl.scrollHeight;
    } else if (msg.type === 'tool_activity') {
      const fileTools = ['write_file', 'edit_file', 'patch_file'];
      if (msg.action === 'call') {
        if (fileTools.includes(msg.tool) && msg.path) {
          _lastEditedPath = msg.path;
        }
        if (msg.tool === 'run_command' && msg.args && /sed\s+-i/.test(msg.args)) {
          _lastEditedPath = _currentPath;
        }
      }
      if (msg.action === 'result' && !msg.error && _currentPath && _lastEditedPath) {
        if (_lastEditedPath === _currentPath) {
          refreshPreviewAfterEdit();
        }
        _lastEditedPath = '';
      }
    } else if (msg.type === 'done' && _currentPath) {
      refreshPreviewAfterEdit();
    }
  });
}

function refreshPreviewAfterEdit(): void {
  if (!_currentPath || !_iframeEl) return;
  setTimeout(() => {
    loadPreview(_currentPath);
    showRefreshIndicator();
  }, 300);
}

function showRefreshIndicator(): void {
  if (!_iframeEl) return;
  const viewport = _iframeEl.parentElement;
  if (!viewport) return;
  const toast = document.createElement('div');
  toast.textContent = '↻ Refreshed';
  toast.style.cssText = `
    position: absolute; top: 8px; right: 8px; padding: 4px 10px;
    background: rgba(0,255,65,0.15); color: #0f0; border-radius: 4px;
    font-size: 11px; font-weight: 600; z-index: 10; pointer-events: none;
    animation: fadeOut 1.5s ease forwards;
  `;
  viewport.style.position = 'relative';
  viewport.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
}

export function createPreview(container: HTMLElement): void {
  injectPreviewStyles();
  container.innerHTML = '';

  const split = document.createElement('div');
  split.className = 'cc-preview-split';

  // ── Left: Mini Chat ──
  const chatPanel = document.createElement('div');
  chatPanel.className = 'cc-preview-chat';

  const chatHeader = document.createElement('div');
  chatHeader.className = 'cc-preview-chat-header';
  chatHeader.textContent = 'Context Chat';

  const chatMsgs = document.createElement('div');
  chatMsgs.className = 'cc-preview-chat-msgs';
  _previewMsgsEl = chatMsgs;

  const welcomeMsg = document.createElement('div');
  welcomeMsg.className = 'cc-preview-chat-msg system';
  welcomeMsg.textContent = 'Discuss the file you\'re previewing here.';
  chatMsgs.appendChild(welcomeMsg);

  const chatInputArea = document.createElement('div');
  chatInputArea.className = 'cc-preview-chat-input-area';

  const chatInput = document.createElement('textarea');
  chatInput.className = 'cc-preview-chat-input';
  chatInput.placeholder = 'Ask about this file…';
  chatInput.rows = 1;

  const chatSendBtn = document.createElement('button');
  chatSendBtn.className = 'cc-preview-chat-send';
  chatSendBtn.innerHTML = '↑';

  function sendPreviewMsg(): void {
    const text = chatInput.value.trim();
    if (!text || !_chatController) return;

    const userEl = document.createElement('div');
    userEl.className = 'cc-preview-chat-msg user';
    userEl.textContent = text;
    chatMsgs.appendChild(userEl);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;

    const contextText = _currentPath
      ? `[Editing file: ${_currentPath}] ${text}`
      : text;
    _chatController.sendToChannel('preview', contextText);
    chatInput.value = '';
  }

  chatSendBtn.addEventListener('click', sendPreviewMsg);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPreviewMsg();
    }
  });

  chatInputArea.appendChild(chatInput);
  chatInputArea.appendChild(chatSendBtn);

  chatPanel.appendChild(chatHeader);
  chatPanel.appendChild(chatMsgs);
  chatPanel.appendChild(chatInputArea);

  // ── Right: File Preview ──
  const wrap = document.createElement('div');
  wrap.className = 'cc-preview-wrap';

  const toolbar = document.createElement('div');
  toolbar.className = 'cc-preview-toolbar';
  toolbar.style.position = 'relative';

  const pathBar = document.createElement('div');
  pathBar.className = 'cc-preview-path';
  pathBar.textContent = 'Browse files…';
  _pathBarEl = pathBar;

  // File picker dropdown
  const picker = document.createElement('div');
  picker.className = 'cc-preview-picker';
  let pickerDir = '/data';
  const PREVIEWABLE = new Set(['.html', '.htm', '.md', '.css', '.json', '.txt', '.svg', '.xml', '.log', '.docx', '.doc', '.pdf']);

  function getExt(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot).toLowerCase() : '';
  }

  async function renderPicker(dir: string): Promise<void> {
    pickerDir = dir;
    picker.innerHTML = '';

    // Breadcrumb
    const bc = document.createElement('div');
    bc.className = 'cc-preview-picker-breadcrumb';
    const parts = dir.split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc += '/' + parts[i];
      const path = acc;
      if (i > 0) {
        const sep = document.createElement('span');
        sep.textContent = ' / ';
        bc.appendChild(sep);
      }
      const crumb = document.createElement('button');
      crumb.className = 'cc-preview-picker-crumb';
      crumb.textContent = parts[i];
      crumb.addEventListener('click', (e) => { e.stopPropagation(); renderPicker(path); });
      bc.appendChild(crumb);
    }
    picker.appendChild(bc);

    // Fetch directory
    try {
      const resp = await fetch(`/api/v1/files/tree?path=${encodeURIComponent(dir)}&depth=1`);
      if (!resp.ok) return;
      const data = await resp.json();
      const entries: Array<{ name: string; type: string }> = data.tree || data.children || data || [];
      const sorted = entries.sort((a, b) => {
        if ((a.type === 'dir' || a.type === 'directory') && (b.type !== 'dir' && b.type !== 'directory')) return -1;
        if ((b.type === 'dir' || b.type === 'directory') && (a.type !== 'dir' && a.type !== 'directory')) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of sorted) {
        const isDir = entry.type === 'dir' || entry.type === 'directory';
        const ext = getExt(entry.name);
        const previewable = !isDir && PREVIEWABLE.has(ext);
        if (!isDir && !previewable) continue; // hide non-previewable files

        const item = document.createElement('button');
        item.className = `cc-preview-picker-item ${isDir ? 'dir' : 'file'}${previewable ? ' previewable' : ''}`;

        const icon = document.createElement('span');
        icon.className = 'cc-preview-picker-icon';
        icon.textContent = isDir ? '📂' : '📄';

        const label = document.createElement('span');
        label.textContent = entry.name;

        item.appendChild(icon);
        item.appendChild(label);

        const fullPath = `${dir}/${entry.name}`;
        if (isDir) {
          item.addEventListener('click', (e) => { e.stopPropagation(); renderPicker(fullPath); });
        } else {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            loadPreview(fullPath);
            pathBar.textContent = fullPath;
            picker.classList.remove('open');
          });
        }
        picker.appendChild(item);
      }
    } catch { /* ignore */ }
  }

  pathBar.addEventListener('click', () => {
    if (picker.classList.contains('open')) {
      picker.classList.remove('open');
    } else {
      const startDir = _currentPath ? _currentPath.replace(/\/[^/]+$/, '') : '/data';
      renderPicker(startDir);
      picker.classList.add('open');
    }
  });

  // Close picker when clicking outside
  document.addEventListener('click', (e) => {
    if (!toolbar.contains(e.target as Node)) {
      picker.classList.remove('open');
    }
  });

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'cc-preview-btn';
  refreshBtn.textContent = '⟳';
  refreshBtn.title = 'Refresh';
  refreshBtn.addEventListener('click', () => {
    if (_currentPath) loadPreview(_currentPath);
  });

  const deviceGroup = document.createElement('div');
  deviceGroup.className = 'cc-preview-device-group';

  const devices: Array<{ key: 'desktop' | 'tablet' | 'mobile'; icon: string; title: string }> = [
    { key: 'desktop', icon: '🖥', title: 'Desktop' },
    { key: 'tablet', icon: '📱', title: 'Tablet (768px)' },
    { key: 'mobile', icon: '📲', title: 'Mobile (375px)' },
  ];

  for (const d of devices) {
    const btn = document.createElement('button');
    btn.className = `cc-preview-device-btn${d.key === 'desktop' ? ' active' : ''}`;
    btn.textContent = d.icon;
    btn.title = d.title;
    btn.dataset.device = d.key;
    btn.addEventListener('click', () => setDeviceWidth(d.key));
    deviceGroup.appendChild(btn);
  }

  toolbar.appendChild(pathBar);
  toolbar.appendChild(picker);
  toolbar.appendChild(refreshBtn);
  toolbar.appendChild(deviceGroup);

  // ── Export button (visible only for documents) ──
  const exportWrap = document.createElement('div');
  exportWrap.className = 'cc-preview-export-wrap';
  exportWrap.style.display = 'none';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'cc-preview-btn';
  exportBtn.textContent = '⤓ Export';
  exportBtn.title = 'Export document';
  _exportBtnEl = exportBtn;

  const exportDropdown = document.createElement('div');
  exportDropdown.className = 'cc-preview-export-dropdown';
  _exportDropdownEl = exportDropdown;

  function buildExportDropdown(): void {
    exportDropdown.innerHTML = '';
    const formats: Array<{ label: string; format: string }> = [
      { label: 'Save as DOCX', format: 'docx' },
      { label: 'Save as PDF', format: 'pdf' },
    ];
    for (const item of formats) {
      const btn = document.createElement('button');
      btn.className = 'cc-preview-export-item';
      btn.textContent = item.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportDropdown.classList.remove('open');
        doDocumentExport(item.format);
      });
      exportDropdown.appendChild(btn);
    }
  }
  buildExportDropdown();

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportDropdown.classList.toggle('open');
  });

  exportWrap.appendChild(exportBtn);
  exportWrap.appendChild(exportDropdown);
  toolbar.appendChild(exportWrap);

  // Close export dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!exportWrap.contains(e.target as Node)) {
      exportDropdown.classList.remove('open');
    }
  });

  const viewport = document.createElement('div');
  viewport.className = 'cc-preview-viewport';

  const iframe = document.createElement('iframe');
  iframe.className = 'cc-preview-iframe';
  iframe.sandbox.add('allow-scripts', 'allow-same-origin');
  iframe.style.width = DEVICE_WIDTHS.desktop;
  _iframeEl = iframe;

  const empty = document.createElement('div');
  empty.className = 'cc-preview-empty';
  empty.innerHTML = `
    <span class="cc-preview-empty-icon">👁</span>
    <span>No file loaded</span>
    <span class="cc-preview-empty-hint">Enter a path above or click a file link in chat</span>
  `;

  viewport.appendChild(iframe);
  viewport.appendChild(empty);

  iframe.addEventListener('load', () => {
    if (_currentPath) empty.style.display = 'none';
  });

  wrap.appendChild(toolbar);
  wrap.appendChild(viewport);

  split.appendChild(chatPanel);
  split.appendChild(wrap);
  container.appendChild(split);
}
