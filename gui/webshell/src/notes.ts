// ---------------------------------------------------------------------------
// Notes panel — persistent scratchpad for CTO context/ideas
// Uses the notepad API (CRUD via /api/v1/notepads)
// ---------------------------------------------------------------------------

import theme from './theme.js';

interface NotepadData {
  id: string;
  title: string;
  content: string;
  tags: string[];
  project?: string;
  pinned: boolean;
  global: boolean;
  createdAt: number;
  updatedAt: number;
  author: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function apiFetch(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

export interface NotesController {
  refresh(): void;
}

export function createNotes(container: HTMLElement): NotesController {
  // ── Styles ──
  const style = document.createElement('style');
  style.id = 'cc-notes-styles';
  style.textContent = `
    .cc-notes-wrap {
      display: flex; flex-direction: row;
      height: 100%;
      background: ${theme.bg};
      overflow: hidden;
    }
    .cc-notes-list {
      width: 220px; flex-shrink: 0;
      display: flex; flex-direction: column;
      background: ${theme.bgSecondary};
      border-right: 1px solid ${theme.border};
      overflow-y: auto;
    }
    .cc-notes-list-header {
      padding: 10px 12px;
      border-bottom: 1px solid ${theme.border};
      display: flex; align-items: center; gap: 6px;
    }
    .cc-notes-list-header-title {
      font-size: 11px; font-weight: 600;
      color: ${theme.textMuted};
      text-transform: uppercase;
      letter-spacing: 0.06em;
      flex: 1;
    }
    .cc-notes-new-btn {
      width: calc(100% - 24px); margin: 8px 12px;
      padding: 8px 12px;
      background: none;
      border: 1px solid ${theme.border};
      border-radius: 6px;
      color: ${theme.accent};
      font-family: inherit; font-size: 12px; font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
      text-align: left;
    }
    .cc-notes-new-btn:hover { background: rgba(0,255,65,0.06); }
    .cc-notes-item {
      display: flex; align-items: center; gap: 6px;
      width: 100%;
      padding: 7px 12px;
      background: none;
      border: none;
      border-left: 2px solid transparent;
      color: ${theme.text};
      font-family: inherit; font-size: 12px;
      cursor: pointer;
      text-align: left;
      transition: background 0.1s, border-color 0.1s;
    }
    .cc-notes-item:hover { background: rgba(255,255,255,0.03); }
    .cc-notes-item.active { border-left-color: ${theme.accent}; background: rgba(0,255,65,0.04); }
    .cc-notes-item-title {
      flex: 1;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cc-notes-item-pin { color: ${theme.accentYellow}; font-size: 10px; flex-shrink: 0; }
    .cc-notes-item-time {
      font-size: 10px; color: ${theme.textMuted}; flex-shrink: 0;
    }
    .cc-notes-editor {
      flex: 1; display: flex; flex-direction: column; overflow: hidden;
      min-width: 0;
    }
    .cc-notes-editor-header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 16px;
      border-bottom: 1px solid ${theme.border};
      background: ${theme.bgSecondary};
    }
    .cc-notes-editor-title {
      flex: 1;
      background: transparent;
      border: none; outline: none;
      color: ${theme.text};
      font-family: inherit; font-size: 14px; font-weight: 600;
      padding: 4px 0;
    }
    .cc-notes-editor-title::placeholder { color: ${theme.textMuted}; }
    .cc-notes-editor-actions {
      display: flex; gap: 4px;
    }
    .cc-notes-action-btn {
      padding: 4px 10px;
      background: none;
      border: 1px solid ${theme.border};
      border-radius: 4px;
      color: ${theme.textMuted};
      font-family: inherit; font-size: 11px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .cc-notes-action-btn:hover { color: ${theme.accent}; border-color: ${theme.accent}; }
    .cc-notes-action-btn.danger:hover { color: #ff4444; border-color: #ff4444; }
    .cc-notes-action-btn.pinned { color: ${theme.accentYellow}; border-color: ${theme.accentYellow}; }
    .cc-notes-editor-body {
      flex: 1; padding: 16px;
      overflow-y: auto;
    }
    .cc-notes-textarea {
      width: 100%; height: 100%;
      background: transparent;
      border: none; outline: none;
      color: ${theme.text};
      font-family: inherit; font-size: 13px; line-height: 1.6;
      resize: none;
    }
    .cc-notes-textarea::placeholder { color: ${theme.textMuted}; }
    .cc-notes-empty {
      display: flex; align-items: center; justify-content: center;
      height: 100%;
      color: ${theme.textMuted};
      font-size: 13px;
      text-align: center;
      padding: 24px;
      flex-direction: column;
      gap: 8px;
    }
    .cc-notes-meta {
      padding: 6px 16px;
      border-top: 1px solid ${theme.border};
      font-size: 10px; color: ${theme.textMuted};
      display: flex; gap: 12px;
    }
    @media (max-width: 640px) {
      .cc-notes-list { width: 160px; }
    }
  `;
  document.head.appendChild(style);

  container.className = 'cc-notes-wrap';

  // ── Note list sidebar ──
  const listEl = document.createElement('div');
  listEl.className = 'cc-notes-list';

  const listHeader = document.createElement('div');
  listHeader.className = 'cc-notes-list-header';
  listHeader.innerHTML = `<span class="cc-notes-list-header-title">Notes</span>`;

  const newBtn = document.createElement('button');
  newBtn.className = 'cc-notes-new-btn';
  newBtn.textContent = '+ New Note';

  const itemsContainer = document.createElement('div');
  itemsContainer.style.flex = '1';
  itemsContainer.style.overflowY = 'auto';

  listEl.appendChild(listHeader);
  listEl.appendChild(newBtn);
  listEl.appendChild(itemsContainer);

  // ── Editor area ──
  const editorEl = document.createElement('div');
  editorEl.className = 'cc-notes-editor';

  const emptyState = document.createElement('div');
  emptyState.className = 'cc-notes-empty';
  emptyState.innerHTML = `<div style="font-size:32px;">📝</div><div>Select a note or create a new one</div>`;

  editorEl.appendChild(emptyState);

  container.appendChild(listEl);
  container.appendChild(editorEl);

  // ── State ──
  let notepads: NotepadData[] = [];
  let activeId: string | null = null;
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Auto-save the active note ──
  function scheduleAutoSave(): void {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => saveActiveNote(), 1500);
  }

  async function saveActiveNote(): Promise<void> {
    if (!activeId) return;
    const titleEl = editorEl.querySelector('.cc-notes-editor-title') as HTMLInputElement;
    const bodyEl = editorEl.querySelector('.cc-notes-textarea') as HTMLTextAreaElement;
    if (!titleEl || !bodyEl) return;

    try {
      await apiFetch(`/api/v1/notepads/${encodeURIComponent(activeId)}`, {
        method: 'PUT',
        body: JSON.stringify({ title: titleEl.value, content: bodyEl.value }),
      });
    } catch {
      // silent save failure
    }
  }

  // ── Build editor UI ──
  function buildEditor(note: NotepadData): void {
    editorEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'cc-notes-editor-header';

    const titleInput = document.createElement('input');
    titleInput.className = 'cc-notes-editor-title';
    titleInput.value = note.title;
    titleInput.placeholder = 'Note title…';
    titleInput.addEventListener('input', scheduleAutoSave);

    const actions = document.createElement('div');
    actions.className = 'cc-notes-editor-actions';

    const pinBtn = document.createElement('button');
    pinBtn.className = `cc-notes-action-btn${note.pinned ? ' pinned' : ''}`;
    pinBtn.textContent = note.pinned ? '📌 Pinned' : '📌 Pin';
    pinBtn.addEventListener('click', async () => {
      try {
        const data = await apiFetch(`/api/v1/notepads/${encodeURIComponent(note.id)}/pin`, { method: 'POST' });
        note.pinned = data.pinned;
        pinBtn.classList.toggle('pinned', data.pinned);
        pinBtn.textContent = data.pinned ? '📌 Pinned' : '📌 Pin';
        renderList();
      } catch { /* ignore */ }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'cc-notes-action-btn danger';
    deleteBtn.textContent = '🗑 Delete';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this note?')) return;
      try {
        await apiFetch(`/api/v1/notepads/${encodeURIComponent(note.id)}`, { method: 'DELETE' });
        activeId = null;
        editorEl.innerHTML = '';
        editorEl.appendChild(emptyState.cloneNode(true));
        await refreshNotes();
      } catch { /* ignore */ }
    });

    actions.appendChild(pinBtn);
    actions.appendChild(deleteBtn);
    header.appendChild(titleInput);
    header.appendChild(actions);

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'cc-notes-editor-body';

    const textarea = document.createElement('textarea');
    textarea.className = 'cc-notes-textarea';
    textarea.value = note.content;
    textarea.placeholder = 'Write your notes here…';
    textarea.addEventListener('input', scheduleAutoSave);
    bodyWrap.appendChild(textarea);

    const meta = document.createElement('div');
    meta.className = 'cc-notes-meta';
    meta.textContent = `Updated ${formatDate(note.updatedAt)} ${formatTime(note.updatedAt)} · ${note.author}`;

    editorEl.appendChild(header);
    editorEl.appendChild(bodyWrap);
    editorEl.appendChild(meta);

    // Focus title if empty
    if (!note.title || note.title === 'Untitled') {
      setTimeout(() => titleInput.focus(), 50);
    }
  }

  // ── Render list ──
  function renderList(): void {
    itemsContainer.innerHTML = '';

    // Sort: pinned first, then updated
    const sorted = [...notepads].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.updatedAt - a.updatedAt;
    });

    for (const note of sorted) {
      const item = document.createElement('div');
      item.className = 'cc-notes-item';
      if (note.id === activeId) item.classList.add('active');

      const pinIcon = note.pinned ? '<span class="cc-notes-item-pin">📌</span>' : '';

      item.innerHTML = `
        <span class="cc-notes-item-title">${escapeHtml(note.title || 'Untitled')}</span>
        ${pinIcon}
        <span class="cc-notes-item-time">${formatTime(note.updatedAt)}</span>
      `;

      item.addEventListener('click', () => {
        activeId = note.id;
        renderList();
        buildEditor(note);
      });

      itemsContainer.appendChild(item);
    }

    // If active note ID is set but not in list, clear it
    if (activeId && !notepads.some(n => n.id === activeId)) {
      activeId = null;
      editorEl.innerHTML = '';
      editorEl.appendChild(emptyState.cloneNode(true));
    }
  }

  // ── Load notes from API ──
  async function refreshNotes(): Promise<void> {
    try {
      const data = await apiFetch('/api/v1/notepads');
      notepads = data.notepads || [];
      renderList();

      // If active note exists, rebuild editor with fresh data
      if (activeId) {
        const fresh = notepads.find(n => n.id === activeId);
        if (fresh) {
          buildEditor(fresh);
        }
      }
    } catch {
      itemsContainer.innerHTML = '<div style="padding:12px;font-size:11px;color:' + theme.textMuted + ';">Notes unavailable</div>';
    }
  }

  // ── New note ──
  newBtn.addEventListener('click', async () => {
    try {
      const data = await apiFetch('/api/v1/notepads', {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled', content: '', author: 'cto' }),
      });
      await refreshNotes();
      activeId = data.id;
      renderList();
      buildEditor(data);
    } catch { /* ignore */ }
  });

  // ── Initial load ──
  refreshNotes();

  return {
    refresh: refreshNotes,
  };
}
