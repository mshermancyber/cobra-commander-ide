// ---------------------------------------------------------------------------
// Chat panel — Claude Code web UI aesthetic
// Warm dark bg, plain text messages (no cards/bubbles), left-aligned,
// bottom-pinned input with status bar, chat sidebar with persistence.
// ---------------------------------------------------------------------------

import { WSConnection } from './connection.js';
import theme from './theme.js';
import { switchTab } from './layout.js';
import { getWorkspaceRoot } from './workspace-root.js';

const MIN_TAP_TARGET = 44;
const MAX_TEXTAREA_LINES = 4;
const MAX_DOM_MESSAGES = 200;
const PRUNE_BATCH = 50;

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolSuccess?: boolean;
  toolResult?: string;
  timestamp: number;
}

// Matches server ChatMeta shape
interface ChatMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

// ── CSS injection ──────────────────────────────────────────────────────────

function injectChatStyles(): void {
  const style = document.createElement('style');
  style.id = 'cc-chat-styles';
  style.textContent = `
    /* ── Container (flex row: sidebar + main) ── */
    .cc-chat-wrap {
      display: flex; flex-direction: row;
      height: 100%;
      background: ${theme.bg};
      overflow: hidden;
    }

    /* ── Sidebar (chat list) ── */
    .cc-chat-sidebar {
      width: 240px;
      flex-shrink: 0;
      display: flex; flex-direction: column;
      background: ${theme.bgSecondary};
      border-right: 1px solid ${theme.border};
      overflow-y: auto; overflow-x: hidden;
    }
    .cc-chat-sidebar-header {
      padding: 10px 12px;
      border-bottom: 1px solid ${theme.border};
      display: flex; align-items: center; gap: 6px;
    }
    .cc-chat-sidebar-header-title {
      font-size: 10px;
      font-weight: 600;
      color: ${theme.textMuted};
      text-transform: uppercase;
      letter-spacing: 0.06em;
      flex: 1;
    }
    .cc-chat-new-btn {
      width: 100%;
      padding: 6px 12px;
      background: none;
      border: 1px solid ${theme.border};
      border-radius: 6px;
      color: ${theme.accent};
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
      margin: 8px 12px;
      width: calc(100% - 24px);
      min-height: ${MIN_TAP_TARGET}px;
      -webkit-tap-highlight-color: transparent;
      text-align: left;
    }
    .cc-chat-new-btn:active { background: rgba(0,255,65,0.06); }
    .cc-chat-list {
      flex: 1;
      overflow-y: auto;
      padding: 0;
    }
    .cc-chat-item {
      display: flex; align-items: center; gap: 8px;
      width: 100%;
      padding: 8px 12px;
      background: none;
      border: none;
      border-left: 2px solid transparent;
      color: ${theme.text};
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      text-align: left;
      transition: background 0.1s, border-color 0.1s;
      -webkit-tap-highlight-color: transparent;
      min-height: ${MIN_TAP_TARGET}px;
      position: relative;
    }
    .cc-chat-item:hover { background: rgba(255,255,255,0.03); }
    .cc-chat-item.active { border-left-color: ${theme.accent}; background: rgba(0,255,65,0.04); }
    .cc-chat-item-content { flex: 1; overflow: hidden; }
    .cc-chat-item-title {
      font-size: 12px;
      line-height: 1.4;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: ${theme.text};
    }
    .cc-chat-item-time {
      font-size: 10px;
      color: ${theme.textMuted};
      margin-top: 1px;
    }
    .cc-chat-action-btn {
      min-width: 24px; min-height: 24px;
      width: 24px; height: 24px;
      padding: 0;
      background: none;
      border: none;
      cursor: pointer;
      color: ${theme.textMuted};
      font-size: 11px;
      border-radius: 4px;
      display: flex; align-items: center; justify-content: center;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s;
      flex-shrink: 0;
      -webkit-appearance: none;
      -webkit-tap-highlight-color: transparent;
    }
    .cc-chat-item:hover .cc-chat-action-btn,
    .cc-chat-item.active .cc-chat-action-btn { opacity: 1; }
    .cc-chat-action-btn:hover { color: ${theme.accent}; }
    .cc-chat-action-btn.delete:hover { color: ${theme.accentRed}; }
    .cc-chat-actions {
      display: flex; gap: 2px; flex-shrink: 0;
    }
    .cc-chat-sidebar-section {
      padding: 6px 12px 2px;
      font-size: 10px;
      font-weight: 600;
      color: ${theme.textMuted};
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .cc-chat-archive-toggle {
      display: flex; align-items: center; gap: 4px;
      width: 100%;
      padding: 8px 12px;
      background: none;
      border: none;
      border-top: 1px solid ${theme.border};
      color: ${theme.textMuted};
      font-family: inherit;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      margin-top: auto;
      -webkit-tap-highlight-color: transparent;
    }
    .cc-chat-archive-toggle:hover { color: ${theme.text}; }
    .cc-chat-archive-list {
      display: none;
      border-top: 1px solid ${theme.border};
    }
    .cc-chat-archive-list.open { display: block; }

    /* ── Main chat area ── */
    .cc-chat-main {
      flex: 1;
      display: flex; flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }

    /* ── Messages area ── */
    .cc-chat-msgs {
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto; overflow-x: hidden;
      padding: 16px 0 8px;
      scroll-behavior: smooth;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      display: flex; flex-direction: column;
      max-width: 800px;
      margin: 0 auto;
      width: 100%;
    }

    /* ── Message base — plain text, no cards, no bubbles, no borders ── */
    .cc-msg {
      padding: 12px 24px;
      font-size: 14px;
      line-height: 1.6;
      animation: cc-msg-in 0.15s ease-out both;
      word-wrap: break-word; overflow-wrap: break-word;
      color: ${theme.text};
    }
    @keyframes cc-msg-in {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* ── Message label — tiny, muted, uppercase ── */
    .cc-msg-label {
      font-size: 11px;
      font-weight: 600;
      color: ${theme.textMuted};
      margin-bottom: 2px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      line-height: 1.3;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cc-msg-time {
      font-size: 10px;
      font-weight: 400;
      color: ${theme.textMuted};
      opacity: 0.6;
      text-transform: none;
      letter-spacing: 0;
    }

    /* ── System message ── */
    .cc-msg-system {
      text-align: center;
      color: ${theme.textMuted};
      font-size: 12px;
      padding: 4px 24px;
    }

    /* ── User message — plain text, left-aligned, label above ── */
    .cc-msg-user {
      /* no bg change, no card, no border */
    }

    /* ── Assistant message — plain text, left-aligned, label above ── */
    .cc-msg-assistant {
      /* no bg change, no card, no border */
    }

    /* ── Thinking indicator — subtle dot next to label ── */
    .cc-thinking-dot {
      display: inline-block;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: ${theme.accent};
      box-shadow: 0 0 6px ${theme.accent};
      animation: cc-think 1.2s ease-in-out infinite;
      flex-shrink: 0;
      margin-right: 6px;
      vertical-align: middle;
    }
    @keyframes cc-think {
      0%, 100% { opacity: 0.3; transform: scale(0.8); }
      50%      { opacity: 1;   transform: scale(1.3); }
    }

    /* ── Tool message ── */
    .cc-msg-tool {
      border-left: 2px solid ${theme.accentYellow};
      margin-left: 12px;
      padding-top: 8px; padding-bottom: 8px;
      font-size: 13px;
    }
    .cc-msg-tool .cc-tool-pill {
      display: inline-flex; align-items: center; gap: 6px;
      background: ${theme.toolBg};
      border: 1px solid ${theme.border};
      border-radius: 20px;
      padding: 4px 12px;
      font-size: 11px;
      font-weight: 600;
      color: ${theme.textSecondary};
      cursor: pointer;
      min-height: ${MIN_TAP_TARGET}px;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      transition: border-color 0.15s, color 0.15s;
    }
    .cc-msg-tool .cc-tool-pill:active {
      border-color: ${theme.accentYellow};
      color: ${theme.accentYellow};
    }
    .cc-msg-tool .cc-tool-detail {
      margin-top: 8px;
      display: none;
    }
    .cc-msg-tool .cc-tool-detail.open {
      display: block;
    }
    .cc-msg-tool .cc-tool-detail pre {
      background: ${theme.codeBlockBg};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      padding: 10px 14px;
      margin: 0;
      overflow-x: auto; overflow-y: hidden;
      font-size: 12px;
      line-height: 1.4;
      white-space: pre;
      word-wrap: normal;
      -webkit-overflow-scrolling: touch;
      color: ${theme.textSecondary};
    }
    .cc-msg-tool .cc-tool-status {
      font-size: 11px;
      margin-top: 4px;
    }
    .cc-msg-tool .cc-tool-status.ok  { color: ${theme.accentGreen}; }
    .cc-msg-tool .cc-tool-status.err { color: ${theme.accentRed}; }

    /* ── Markdown: inline code ── */
    .cc-inline-code {
      background: ${theme.inlineCodeBg};
      border: 1px solid ${theme.border};
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 0.92em;
      font-family: inherit;
      color: ${theme.accentYellow};
    }

    /* ── Markdown: code block ── */
    .cc-code-block {
      background: ${theme.codeBlockBg};
      border: 1px solid ${theme.border};
      border-radius: 8px;
      margin: 10px 0;
      overflow: hidden;
    }
    .cc-code-block .cc-code-lang {
      font-size: 10px;
      color: ${theme.textMuted};
      padding: 5px 14px;
      background: transparent;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      border-bottom: 1px solid ${theme.border};
    }
    .cc-code-block pre {
      padding: 12px 14px;
      margin: 0;
      overflow-x: auto; overflow-y: hidden;
      font-size: 13px;
      line-height: 1.45;
      white-space: pre;
      word-wrap: normal;
      -webkit-overflow-scrolling: touch;
      color: ${theme.text};
    }

    /* ── Markdown: lists ── */
    .cc-msg-body ul, .cc-msg-body ol {
      padding-left: 20px;
      margin: 6px 0;
    }
    .cc-msg-body li {
      margin: 2px 0;
    }

    /* ── Markdown: links ── */
    .cc-msg-body a {
      color: ${theme.accent};
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .cc-msg-body a.cc-file-link {
      cursor: pointer;
      text-decoration-style: dashed;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 0.92em;
    }
    .cc-msg-body a.cc-file-link:hover {
      text-decoration-style: solid;
      background: rgba(0,255,65,0.06);
      border-radius: 2px;
      padding: 0 2px;
    }

    /* ── Markdown: headings ── */
    .cc-msg-body h1, .cc-msg-body h2, .cc-msg-body h3,
    .cc-msg-body h4, .cc-msg-body h5, .cc-msg-body h6 {
      color: ${theme.text};
      margin: 10px 0 6px;
      line-height: 1.3;
    }
    .cc-msg-body h1 { font-size: 1.3em; }
    .cc-msg-body h2 { font-size: 1.15em; }
    .cc-msg-body h3 { font-size: 1.05em; }

    /* ── Markdown: bold / italic ── */
    .cc-msg-body strong { color: ${theme.text}; font-weight: 700; }
    .cc-msg-body em     { font-style: italic; color: ${theme.textSecondary}; }

    /* ── Markdown: horizontal rule ── */
    .cc-msg-body hr {
      border: none;
      border-top: 1px solid ${theme.border};
      margin: 12px 0;
    }

    /* ── Input area — rounded container at bottom, centered ── */
    .cc-chat-input-area {
      padding: 8px 16px;
      padding-bottom: max(8px, env(safe-area-inset-bottom, 0px));
      background: ${theme.bg};
      max-width: 800px;
      margin: 0 auto;
      width: 100%;
    }
    .cc-chat-input-wrap {
      display: flex; align-items: flex-end; gap: 8px;
      background: ${theme.inputAreaBg};
      border: 1px solid ${theme.border};
      border-radius: 12px;
      padding: 6px 10px 6px 14px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .cc-chat-input-wrap:focus-within {
      border-color: rgba(0,255,65,0.4);
      box-shadow: 0 0 8px rgba(0,255,65,0.08);
    }

    .cc-chat-input {
      flex: 1;
      background: transparent;
      color: ${theme.text};
      border: none;
      outline: none;
      padding: 6px 0;
      font-family: inherit;
      font-size: 14px;
      line-height: 1.45;
      resize: none;
      max-height: calc(1.45em * ${MAX_TEXTAREA_LINES} + 12px);
      overflow-y: auto;
      -webkit-appearance: none;
    }
    .cc-chat-input::placeholder {
      color: ${theme.textMuted};
    }

    /* ── Send button — green arrow icon, visible only when text ── */
    .cc-chat-send-btn {
      min-width: ${MIN_TAP_TARGET}px;
      min-height: ${MIN_TAP_TARGET}px;
      width: ${MIN_TAP_TARGET}px;
      height: ${MIN_TAP_TARGET}px;
      padding: 0;
      display: flex; align-items: center; justify-content: center;
      background: none;
      border: none;
      cursor: pointer;
      flex-shrink: 0;
      -webkit-appearance: none;
      -webkit-tap-highlight-color: transparent;
      border-radius: 8px;
      transition: background 0.15s, color 0.15s;
      color: ${theme.textMuted};
    }
    .cc-chat-send-btn.has-text {
      color: ${theme.accent};
    }
    .cc-chat-send-btn:active {
      background: rgba(0,255,65,0.10);
    }
    .cc-chat-send-btn:disabled {
      color: ${theme.textMuted};
      cursor: not-allowed;
    }
    .cc-chat-send-btn.stop-mode {
      color: ${theme.accent};
    }
    .cc-chat-send-btn.stop-mode:active {
      background: rgba(255,65,65,0.10);
    }

    /* ── Status bar below input ── */
    .cc-chat-context-bar {
      padding: 4px 16px 2px;
      font-size: 11px;
      color: ${theme.textMuted};
      opacity: 0.7;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      -webkit-user-select: none; user-select: none;
    }
    .cc-chat-status {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 16px 8px;
      font-size: 11px;
      color: ${theme.textMuted};
      -webkit-user-select: none; user-select: none;
    }
    .cc-chat-status-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: ${theme.accent};
      flex-shrink: 0;
      transition: background 0.2s;
    }
    .cc-chat-status-dot.offline { background: #ef4444; }
    .cc-chat-status-dot.connecting { background: #eab308; }
    /* ── Terminal toggle in status bar ── */
    .cc-terminal-toggle {
      margin-left: auto;
      background: none;
      border: 1px solid ${theme.border};
      border-radius: 6px;
      color: ${theme.textMuted};
      font-family: inherit;
      font-size: 11px;
      padding: 2px 10px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
      -webkit-appearance: none;
      -webkit-tap-highlight-color: transparent;
    }
    .cc-terminal-toggle:hover,
    .cc-terminal-toggle:active {
      color: ${theme.accent};
      border-color: ${theme.accent};
    }

    /* ── Attach button ── */
    .cc-chat-attach-btn {
      min-width: 36px; min-height: 36px; width: 36px; height: 36px;
      padding: 0; display: flex; align-items: center; justify-content: center;
      background: none; border: none; cursor: pointer; flex-shrink: 0;
      border-radius: 6px; color: ${theme.textMuted}; font-size: 16px;
      transition: color 0.15s;
    }
    .cc-chat-attach-btn:hover { color: ${theme.accent}; }
    .cc-chat-image-preview {
      display: none; padding: 6px 10px; gap: 8px;
      flex-wrap: wrap; align-items: center;
      border-bottom: 1px solid ${theme.border};
    }
    .cc-chat-image-preview.has-images { display: flex; }
    .cc-chat-image-thumb {
      position: relative; width: 48px; height: 48px;
      border-radius: 6px; overflow: hidden; border: 1px solid ${theme.border};
    }
    .cc-chat-image-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .cc-chat-image-thumb-remove {
      position: absolute; top: -2px; right: -2px; width: 16px; height: 16px;
      background: ${theme.bgSecondary}; border: 1px solid ${theme.border};
      border-radius: 50%; color: ${theme.textMuted}; font-size: 10px;
      display: flex; align-items: center; justify-content: center; cursor: pointer;
    }
    .cc-chat-image-thumb-remove:hover { color: #ff4444; }
    .cc-msg-image {
      max-width: 240px; max-height: 180px; border-radius: 8px;
      border: 1px solid ${theme.border}; margin: 6px 0; cursor: pointer;
    }
    .cc-msg-image:hover { opacity: 0.85; }
    .cc-chat-drop-overlay {
      display: none; position: absolute; inset: 0;
      background: rgba(0,255,65,0.05); border: 2px dashed ${theme.accent};
      border-radius: 12px; z-index: 100; align-items: center;
      justify-content: center; font-size: 14px; color: ${theme.accent};
      pointer-events: none;
    }
    .cc-chat-drop-overlay.visible { display: flex; }

    /* ── Scrollbar styling ── */
    .cc-chat-msgs::-webkit-scrollbar { width: 4px; }
    .cc-chat-msgs::-webkit-scrollbar-track { background: transparent; }
    .cc-chat-msgs::-webkit-scrollbar-thumb {
      background: ${theme.border};
      border-radius: 4px;
    }
    .cc-chat-sidebar::-webkit-scrollbar { width: 4px; }
    .cc-chat-sidebar::-webkit-scrollbar-track { background: transparent; }
    .cc-chat-sidebar::-webkit-scrollbar-thumb {
      background: ${theme.border};
      border-radius: 4px;
    }
    .cc-chat-list::-webkit-scrollbar { width: 4px; }
    .cc-chat-list::-webkit-scrollbar-track { background: transparent; }
    .cc-chat-list::-webkit-scrollbar-thumb {
      background: ${theme.border};
      border-radius: 4px;
    }

    /* ── Sidebar toggle for mobile (chat history) ──
       Anchored top-right so it doesn't collide with the layout hamburger
       which lives at top-left. */
    .cc-chat-sidebar-toggle {
      display: none;
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 10;
      width: 28px; height: 28px;
      background: ${theme.bgSecondary};
      border: 1px solid ${theme.border};
      border-radius: 4px;
      color: ${theme.textMuted};
      font-size: 14px;
      cursor: pointer;
      align-items: center; justify-content: center;
    }
    @media (max-width: 640px) {
      .cc-chat-sidebar {
        position: absolute; left: -240px; top: 0; bottom: 0;
        z-index: 20; transition: left 0.2s ease;
      }
      .cc-chat-sidebar.open { left: 0; }
      .cc-chat-sidebar-toggle { display: flex; }
      .cc-chat-main { padding-left: 36px; position: relative; }
    }
  `;
  document.head.appendChild(style);
}

// ── Markdown renderer ──────────────────────────────────────────────────────

function renderMarkdown(raw: string): string {
  let html = escapeHtml(raw);

  // Block-level: fenced code blocks (```lang\n...\n```)
  html = html.replace(
    /```([a-z]*)\n([\s\S]*?)```/g,
    (_m: string, lang: string, code: string) => {
      const langTag = lang
        ? `<div class="cc-code-lang">${lang}</div>`
        : '';
      return `<div class="cc-code-block">${langTag}<pre>${code.trimEnd()}</pre></div>`;
    },
  );

  // Inline code (must run after code blocks)
  html = html.replace(
    /`([^`]+)`/g,
    '<code class="cc-inline-code">$1</code>',
  );

  // Bold: **text** or __text__
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  html = html.replace(/\b_([^_]+)_\b/g, '<em>$1</em>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Images: ![alt](url)
  html = html.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    `<span style="color:${theme.textMuted};font-size:12px;">📷 $1</span>`,
  );

  // Links: [text](url) — block dangerous URL schemes (javascript:, data:, vbscript:)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m: string, text: string, url: string) => {
      const trimmed = url.trim();
      if (/^(javascript|data|vbscript):/i.test(trimmed)) {
        return text; // strip the link, keep the text
      }
      return `<a href="${trimmed}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  );

  // File paths — clickable links to open in Preview tab
  html = html.replace(
    /(?<!["\w])(\/(data|tmp|home|etc|var)\/[^\s<>&"']+\.\w{1,10})(?!["\w])/g,
    '<a class="cc-file-link" data-path="$1" href="#">$1</a>',
  );

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Unordered list items
  html = html.replace(
    /(?:^[-*] .+(?:\n|$))+/gm,
    (match: string) => {
      const items = match
        .trim()
        .split('\n')
        .map((line) => `<li>${line.replace(/^[-*] /, '')}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    },
  );

  // Ordered list items
  html = html.replace(
    /(?:^\d+\. .+(?:\n|$))+/gm,
    (match: string) => {
      const items = match
        .trim()
        .split('\n')
        .map((line) => `<li>${line.replace(/^\d+\. /, '')}</li>`)
        .join('');
      return `<ol>${items}</ol>`;
    },
  );

  // Paragraphs
  const blocks = html.split(/\n\n+/);
  html = blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (
        /^<(div|pre|ul|ol|h[1-6]|hr|table|blockquote)/.test(trimmed)
      ) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  return html;
}

// ── Escaping ───────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Time formatting ────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── API helpers ────────────────────────────────────────────────────────────

async function apiFetch(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── Main ───────────────────────────────────────────────────────────────────

export interface ChatController {
  setWorkDir(path: string): void;
  startNewChat(): void;
  onToolActivity(cb: (line: string) => void): void;
  onFileClick(cb: (path: string) => void): void;
  onMessage(cb: (msg: any) => void): void;
  sendText(text: string): void;
  sendToChannel(channel: string, text: string): void;
  dispose(): void;
}

export function createChat(
  container: HTMLElement,
  wsBase: string,
  onToggleTerminal?: () => boolean,
): ChatController {
  injectChatStyles();

  container.className = 'cc-chat-wrap';

  // ── Sidebar ──
  const sidebar = document.createElement('aside');
  sidebar.className = 'cc-chat-sidebar';

  const sidebarHeader = document.createElement('div');
  sidebarHeader.className = 'cc-chat-sidebar-header';
  sidebarHeader.innerHTML = `<span class="cc-chat-sidebar-header-title">Chats</span>`;

  const newChatBtn = document.createElement('button');
  newChatBtn.className = 'cc-chat-new-btn';
  newChatBtn.innerHTML = `&#x2795; New Chat`;

  const chatList = document.createElement('div');
  chatList.className = 'cc-chat-list';

  const archiveToggle = document.createElement('button');
  archiveToggle.className = 'cc-chat-archive-toggle';
  archiveToggle.innerHTML = '▸ Archive';

  const archiveList = document.createElement('div');
  archiveList.className = 'cc-chat-archive-list';

  archiveToggle.addEventListener('click', () => {
    const open = archiveList.classList.toggle('open');
    archiveToggle.innerHTML = open ? '▾ Archive' : '▸ Archive';
  });

  sidebar.appendChild(sidebarHeader);
  sidebar.appendChild(newChatBtn);
  sidebar.appendChild(chatList);
  sidebar.appendChild(archiveToggle);
  sidebar.appendChild(archiveList);

  // ── Main area ──
  const mainArea = document.createElement('div');
  mainArea.className = 'cc-chat-main';

  // Messages area
  const messagesEl = document.createElement('div');
  messagesEl.className = 'cc-chat-msgs';

  // Thinking indicator
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'cc-msg cc-msg-assistant';
  thinkingEl.style.display = 'none';
  thinkingEl.innerHTML = `
    <div class="cc-msg-label">
      <span class="cc-thinking-dot"></span> the worker model
    </div>
    <div style="color:${theme.textMuted};font-style:italic;font-size:13px;">Thinking…</div>
  `;

  // Input area
  const inputArea = document.createElement('div');
  inputArea.className = 'cc-chat-input-area';

  const inputWrap = document.createElement('div');
  inputWrap.className = 'cc-chat-input-wrap';

  const inputEl = document.createElement('textarea');
  inputEl.className = 'cc-chat-input';
  inputEl.placeholder = 'Message the worker model…';
  inputEl.rows = 1;

  const sendBtn = document.createElement('button');
  sendBtn.className = 'cc-chat-send-btn';
  sendBtn.setAttribute('aria-label', 'Send');
  const sendIcon = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 14V4M9 4L5 8M9 4L13 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const stopIcon = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="4" y="4" width="10" height="10" rx="2" fill="currentColor"/></svg>`;
  sendBtn.innerHTML = sendIcon;

  // Status bar
  const statusBar = document.createElement('div');
  statusBar.className = 'cc-chat-status';
  statusBar.innerHTML = `
    <span class="cc-chat-status-dot connecting"></span>
    <span class="cc-chat-status-text">Connecting…</span>
    <button class="cc-terminal-toggle" aria-label="Toggle terminal">▸ Terminal</button>
  `;

  const terminalToggleBtn = statusBar.querySelector('.cc-terminal-toggle') as HTMLButtonElement;
  if (terminalToggleBtn && onToggleTerminal) {
    terminalToggleBtn.addEventListener('click', () => {
      const isOpen = onToggleTerminal();
      terminalToggleBtn.textContent = isOpen ? '▾ Terminal' : '▸ Terminal';
    });
  }

  // Auto-grow textarea
  function autoGrow(): void {
    inputEl.style.height = 'auto';
    const lineHeight =
      parseFloat(getComputedStyle(inputEl).lineHeight) || 1.45 * 14;
    const maxHeight = lineHeight * MAX_TEXTAREA_LINES + 12;
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, maxHeight)}px`;
  }

  function updateSendButton(): void {
    const hasContent = inputEl.value.trim().length > 0 || pendingImages.length > 0;
    if (hasContent) {
      sendBtn.classList.add('has-text');
    } else {
      sendBtn.classList.remove('has-text');
    }
  }

  inputEl.addEventListener('input', () => {
    autoGrow();
    updateSendButton();
  });

  // ── Image attachment system ──
  const pendingImages: string[] = [];

  const imagePreview = document.createElement('div');
  imagePreview.className = 'cc-chat-image-preview';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.style.display = 'none';

  const attachBtn = document.createElement('button');
  attachBtn.className = 'cc-chat-attach-btn';
  attachBtn.setAttribute('aria-label', 'Attach image');
  attachBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M15.5 9.5l-6-6a3.5 3.5 0 00-5 5l7 7a2 2 0 003-3l-7-7a.5.5 0 00-1 1l5.5 5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  attachBtn.addEventListener('click', () => fileInput.click());

  function resizeImage(file: File): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const MAX = 2048;
          let w = img.width, h = img.height;
          if (w > MAX || h > MAX) {
            const scale = MAX / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });
  }

  function addPendingImage(dataUrl: string): void {
    pendingImages.push(dataUrl);
    renderImagePreview();
    updateSendButton();
  }

  function renderImagePreview(): void {
    imagePreview.innerHTML = '';
    if (pendingImages.length === 0) {
      imagePreview.classList.remove('has-images');
      return;
    }
    imagePreview.classList.add('has-images');
    pendingImages.forEach((url, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'cc-chat-image-thumb';
      thumb.innerHTML = `<img src="${url}"><span class="cc-chat-image-thumb-remove">✕</span>`;
      thumb.querySelector('.cc-chat-image-thumb-remove')!.addEventListener('click', () => {
        pendingImages.splice(i, 1);
        renderImagePreview();
        updateSendButton();
      });
      imagePreview.appendChild(thumb);
    });
  }

  fileInput.addEventListener('change', async () => {
    if (!fileInput.files) return;
    for (const file of Array.from(fileInput.files)) {
      const dataUrl = await resizeImage(file);
      addPendingImage(dataUrl);
    }
    fileInput.value = '';
  });

  // Paste images
  inputEl.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const dataUrl = await resizeImage(file);
          addPendingImage(dataUrl);
        }
      }
    }
  });

  // Drag and drop
  const dropOverlay = document.createElement('div');
  dropOverlay.className = 'cc-chat-drop-overlay';
  dropOverlay.textContent = 'Drop image here';

  // Context bar — shows active project
  const contextBar = document.createElement('div');
  contextBar.className = 'cc-chat-context-bar';
  contextBar.textContent = `\u{1F4C1} ${getWorkspaceRoot()}`;

  inputWrap.appendChild(attachBtn);
  inputWrap.appendChild(inputEl);
  inputWrap.appendChild(sendBtn);
  inputArea.appendChild(imagePreview);
  inputArea.appendChild(inputWrap);
  inputArea.appendChild(contextBar);
  inputArea.appendChild(statusBar);
  inputArea.appendChild(fileInput);

  mainArea.appendChild(messagesEl);
  mainArea.appendChild(thinkingEl);
  mainArea.appendChild(inputArea);
  mainArea.appendChild(dropOverlay);
  mainArea.style.position = 'relative';

  // Drag and drop handlers
  let dragCounter = 0;
  mainArea.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (e.dataTransfer?.types.includes('Files')) {
      dropOverlay.classList.add('visible');
    }
  });
  mainArea.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay.classList.remove('visible');
    }
  });
  mainArea.addEventListener('dragover', (e) => e.preventDefault());
  mainArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('visible');
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const dataUrl = await resizeImage(file);
        addPendingImage(dataUrl);
      }
    }
  });

  // Sidebar toggle for mobile
  const sidebarToggle = document.createElement('button');
  sidebarToggle.className = 'cc-chat-sidebar-toggle';
  sidebarToggle.innerHTML = '☰';
  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });
  mainArea.appendChild(sidebarToggle);

  container.appendChild(sidebar);
  container.appendChild(mainArea);

  // ── Scroll helper ──
  // Returns true if the user was already at the bottom (within 60px)
  function isAtBottom(): boolean {
    const tolerance = 60;
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= tolerance;
  }

  function scrollToBottom(opts?: { force?: boolean; smooth?: boolean }): void {
    // During streaming, only auto-scroll if the user hasn't scrolled away
    if (!opts?.force && !isAtBottom()) return;
    messagesEl.scrollTo({
      top: messagesEl.scrollHeight,
      behavior: opts?.smooth ? 'smooth' : 'auto',
    });
  }

  function formatTime(ts?: number): string {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ── Message rendering ──
  function pruneMessages(): void {
    const children = messagesEl.children;
    while (children.length > MAX_DOM_MESSAGES) {
      for (let i = 0; i < PRUNE_BATCH && children.length > MAX_DOM_MESSAGES; i++) {
        children[0].remove();
      }
    }
  }

  function addMessage(msg: ChatMessage): void {
    pruneMessages();
    const el = document.createElement('div');
    el.className = `cc-msg cc-msg-${msg.role}`;

    switch (msg.role) {
      case 'user': {
        el.innerHTML = `
          <div class="cc-msg-label">You <span class="cc-msg-time">${formatTime(msg.timestamp)}</span></div>
          <div class="cc-msg-body">${escapeHtml(msg.content)}</div>`;
        break;
      }
      case 'assistant': {
        el.innerHTML = `
          <div class="cc-msg-label">the worker model <span class="cc-msg-time">${formatTime(msg.timestamp)}</span></div>
          <div class="cc-msg-body">${renderMarkdown(msg.content)}</div>`;
        break;
      }
      case 'tool': {
        const toolName = escapeHtml(msg.toolName || 'tool');
        const success = msg.toolSuccess ?? true;
        const statusClass = success ? 'ok' : 'err';
        const statusLabel = success ? '✓ Success' : '✗ Failed';

        let detailHtml = '';
        if (msg.toolResult) {
          detailHtml = `
            <div class="cc-tool-detail">
              <pre>${escapeHtml(msg.toolResult)}</pre>
            </div>`;
        }

        el.innerHTML = `
          <div class="cc-tool-pill" role="button" tabindex="0" aria-expanded="false">
            <span>⚙</span>
            <span>${toolName}</span>
          </div>
          <div class="cc-tool-status ${statusClass}">${statusLabel}</div>
          ${detailHtml}`;

        const pill = el.querySelector('.cc-tool-pill') as HTMLElement;
        const detail = el.querySelector('.cc-tool-detail') as HTMLElement;
        if (pill && detail) {
          pill.addEventListener('click', () => {
            const open = detail.classList.toggle('open');
            pill.setAttribute('aria-expanded', String(open));
          });
          pill.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              const open = detail.classList.toggle('open');
              pill.setAttribute('aria-expanded', String(open));
            }
          });
        }
        break;
      }
      case 'system': {
        el.innerHTML = `<span>${escapeHtml(msg.content)}</span>`;
        break;
      }
    }

    // Attach file link click handlers
    el.querySelectorAll('.cc-file-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const path = (link as HTMLElement).dataset.path;
        if (path && fileClickCb) fileClickCb(path);
      });
    });

    messagesEl.appendChild(el);
    scrollToBottom();
  }

  // ── State ──
  let activeChatId: string | null = null;
  let activeChatTitle: string = 'New Chat';

  // ── Chat sidebar rendering ──
  function renderChatList(): void {
    chatList.innerHTML = '';
    archiveList.innerHTML = '';

    // Active chats
    apiFetch('/api/chats')
      .then((data) => {
        const chats: ChatMeta[] = data.chats || [];
        renderChatItems(chatList, chats, false);
      })
      .catch(() => {
        chatList.innerHTML = '<div style="padding:12px;font-size:11px;color:' + theme.textMuted + ';">Chats unavailable</div>';
      });

    // Archived chats (in collapsible section)
    apiFetch('/api/chats/archived')
      .then((data) => {
        const archived: ChatMeta[] = data.chats || [];
        if (archived.length > 0) {
          archiveToggle.style.display = '';
          renderChatItems(archiveList, archived, true);
        } else {
          archiveToggle.style.display = 'none';
          archiveList.classList.remove('open');
        }
      })
      .catch(() => { archiveToggle.style.display = 'none'; });
  }

  function renderChatItems(parent: HTMLElement, chats: ChatMeta[], archived: boolean): void {
    for (const chat of chats) {
      const item = document.createElement('div');
      item.className = 'cc-chat-item';
      if (chat.id === activeChatId) item.classList.add('active');

      const actionsHtml = archived
        ? `<div class="cc-chat-actions">
             <button class="cc-chat-action-btn unarchive" title="Restore">↩</button>
             <button class="cc-chat-action-btn delete" title="Delete">✕</button>
           </div>`
        : `<div class="cc-chat-actions">
             <button class="cc-chat-action-btn archive" title="Archive">▼</button>
             <button class="cc-chat-action-btn delete" title="Delete">✕</button>
           </div>`;

      item.innerHTML = `
        <div class="cc-chat-item-content">
          <div class="cc-chat-item-title">${escapeHtml(chat.title)}</div>
          <div class="cc-chat-item-time">${formatTime(chat.updatedAt)}</div>
        </div>
        ${actionsHtml}
      `;

      // Click to load chat
      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.cc-chat-action-btn')) return;
        loadChat(chat.id);
      });

      // Delete button
      const deleteBtn = item.querySelector('.cc-chat-action-btn.delete') as HTMLButtonElement;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('Delete this chat permanently?')) return;
        apiFetch(`/api/chats/${encodeURIComponent(chat.id)}`, { method: 'DELETE' })
          .then(() => {
            if (chat.id === activeChatId) newChat();
            renderChatList();
          })
          .catch(() => { /* ignore */ });
      });

      // Archive/unarchive button
      const actionBtn = item.querySelector('.cc-chat-action-btn.archive, .cc-chat-action-btn.unarchive') as HTMLButtonElement;
      if (actionBtn) {
        actionBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const endpoint = archived
            ? `/api/chats/${encodeURIComponent(chat.id)}/unarchive`
            : `/api/chats/${encodeURIComponent(chat.id)}/archive`;
          apiFetch(endpoint, { method: 'POST' })
            .then(() => {
              if (!archived && chat.id === activeChatId) newChat();
              renderChatList();
            })
            .catch(() => { /* ignore */ });
        });
      }

      parent.appendChild(item);
    }
  }

  // ── Load a chat's messages from the server ──
  async function loadChat(chatId: string): Promise<void> {
    try {
      const data = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}`);
      const chat = data.chat;
      if (!chat || !chat.messages) return;

      activeChatId = chat.id;
      activeChatTitle = chat.title;

      // Clear messages and render loaded ones
      messagesEl.innerHTML = '';
      currentAssistantContent = '';
      currentAssistantEl = null;

      for (const msg of chat.messages) {
        if (msg.role === 'system') {
          addMessage({ role: 'system', content: msg.content || '', timestamp: chat.createdAt });
        } else if (msg.role === 'user') {
          addMessage({ role: 'user', content: msg.content || '', timestamp: chat.createdAt });
        } else if (msg.role === 'assistant') {
          addMessage({ role: 'assistant', content: msg.content || '', timestamp: chat.createdAt });
        }
        // Skip tool messages in display (they're internal)
      }

      scrollToBottom();
      renderChatList();

      // Update status bar
      const statusSpan = statusBar.querySelector('span:nth-child(2)');
      if (statusSpan) {
        statusSpan.textContent = `Head of Engineering · ${escapeHtml(activeChatTitle)}`;
      }
    } catch {
      addMessage({ role: 'system', content: 'Failed to load chat.', timestamp: Date.now() });
    }
  }

  // ── Create a new chat (locally, server creates on first message) ──
  function newChat(): void {
    activeChatId = null;
    activeChatTitle = 'New Chat';
    messagesEl.innerHTML = '';
    currentAssistantContent = '';
    currentAssistantEl = null;

    // Show system message
    addMessage({ role: 'system', content: 'New chat — type a message to begin.', timestamp: Date.now() });

    renderChatList();

    // Update status bar
    const statusSpan = statusBar.querySelector('span:nth-child(2)');
    if (statusSpan) {
      statusSpan.textContent = 'Head of Engineering · New Chat';
    }

    // Focus input
    inputEl.focus();
  }

  // Wire New Chat button
  newChatBtn.addEventListener('click', newChat);

  // ── WebSocket connection ──
  const wsUrl = `${wsBase.replace(/\/+$/, '')}/ws/chat`;
  const conn = new WSConnection(wsUrl);
  let currentAssistantContent = '';
  let currentAssistantEl: HTMLElement | null = null;
  let isGenerating = false;
  let _renderScheduled = false;

  function showThinking(): void {
    isGenerating = true;
    thinkingEl.style.display = 'block';
    sendBtn.disabled = false;
    sendBtn.classList.add('stop-mode');
    sendBtn.innerHTML = stopIcon;
    scrollToBottom();
  }

  function hideThinking(): void {
    isGenerating = false;
    thinkingEl.style.display = 'none';
    sendBtn.disabled = false;
    sendBtn.classList.remove('stop-mode');
    sendBtn.innerHTML = sendIcon;
  }

  function ensureAssistantMessageEl(): HTMLElement {
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement('div');
      currentAssistantEl.className = 'cc-msg cc-msg-assistant';
      currentAssistantEl.innerHTML = `
        <div class="cc-msg-label">the worker model <span class="cc-msg-time">${formatTime()}</span></div>
        <div class="cc-msg-body"></div>`;
      messagesEl.appendChild(currentAssistantEl);
    }
    return currentAssistantEl;
  }

  const setConnState = (state: 'online' | 'offline' | 'connecting') => {
    const dot = statusBar.querySelector('.cc-chat-status-dot');
    const txt = statusBar.querySelector('.cc-chat-status-text');
    if (dot) dot.className = `cc-chat-status-dot${state === 'offline' ? ' offline' : state === 'connecting' ? ' connecting' : ''}`;
    if (txt) txt.textContent = state === 'online' ? 'Head of Engineering · Auto' : state === 'connecting' ? 'Connecting…' : 'Offline — reconnecting…';
  };

  conn.on('connected', () => {
    setConnState('online');
    addMessage({
      role: 'system',
      content: 'Connected to Cobra Commander.',
      timestamp: Date.now(),
    });
    // Load chat list on connect
    renderChatList();

    // If no active chat, start a new one
    if (!activeChatId) {
      newChat();
    }
  });

  conn.on('message', (msg: any) => {
    // ── Channel routing ──
    // Skip messages explicitly tagged for preview — those go only to messageCb
    if (msg.channel === 'preview') return;

    switch (msg.type) {
      case 'chat_info': {
        // Server tells us the active chat
        if (msg.chatId && typeof msg.chatId === 'string') {
          activeChatId = msg.chatId;
          if (msg.title && typeof msg.title === 'string') {
            activeChatTitle = msg.title;
          }
          renderChatList();
          // Update status bar
          const statusSpan = statusBar.querySelector('span:nth-child(2)');
          if (statusSpan) {
            statusSpan.textContent = `Head of Engineering · ${escapeHtml(activeChatTitle)}`;
          }
        }
        break;
      }

      case 'text': {
        if (!isGenerating) showThinking();
        const el = ensureAssistantMessageEl();
        currentAssistantContent += msg.content as string;
        const body = el.querySelector('.cc-msg-body');
        if (body) {
          // Throttle rendering: batch updates via rAF to avoid O(n²) perf collapse
          if (!_renderScheduled) {
            _renderScheduled = true;
            requestAnimationFrame(() => {
              _renderScheduled = false;
              if (!currentAssistantContent) return;
              body.innerHTML = renderMarkdown(currentAssistantContent);
              scrollToBottom();
            });
          }
        }
        break;
      }

      case 'tool_call':
      case 'tool_result':
      case 'progress':
        break;

      // ── Workspace events — routed to terminal only (not chat) ──
      case 'workspace:started':
      case 'workspace:executing':
      case 'workspace:step_started': {
        const stepDesc = msg.step?.description || msg.task || '';
        const wsMsg = msg.type === 'workspace:step_started'
          ? `📋 Step ${(msg.stepIndex || 0) + 1}: ${stepDesc}`
          : `📋 Workspace: ${stepDesc}`;
        if (toolActivityCb) {
          toolActivityCb(`\x1b[36m${wsMsg}\x1b[0m`);
        }
        break;
      }
      case 'workspace:step_completed': {
        const doneMsg = `✅ Step ${(msg.stepIndex || 0) + 1} complete`;
        if (toolActivityCb) {
          toolActivityCb(`\x1b[32m${doneMsg}\x1b[0m`);
        }
        break;
      }
      case 'workspace:step_failed': {
        const failMsg = `❌ Step ${(msg.stepIndex || 0) + 1} failed: ${msg.error || 'unknown'}`;
        if (toolActivityCb) {
          toolActivityCb(`\x1b[31m${failMsg}\x1b[0m`);
        }
        break;
      }
      case 'workspace:completed':
      case 'workspace:execution_done': {
        const completeMsg = '✅ Workspace task complete. Review changes and approve/reject.';
        if (toolActivityCb) {
          toolActivityCb(`\x1b[32m${completeMsg}\x1b[0m`);
        }
        break;
      }
      case 'workspace:failed': {
        const wfMsg = `❌ Workspace failed: ${msg.error || 'unknown error'}`;
        if (toolActivityCb) {
          toolActivityCb(`\x1b[31m${wfMsg}\x1b[0m`);
        }
        break;
      }
      case 'workspace:stopped':
        if (toolActivityCb) {
          toolActivityCb('⏹ Workspace stopped.');
        }
        break;
      case 'workspace:approved':
        if (toolActivityCb) {
          toolActivityCb('✅ All changes approved.');
        }
        break;
      case 'workspace:change_rejected':
        if (toolActivityCb) {
          toolActivityCb(`❌ Rejected change in ${msg.file || `file index ${msg.fileIndex}`}`);
        }
        break;
      case 'workspace:tool_call': {
        if (toolActivityCb) {
          const args = msg.args ? JSON.stringify(msg.args).slice(0, 120) : '';
          toolActivityCb(`\x1b[2m[ws]\x1b[0m \x1b[36m→ ${msg.tool}\x1b[0m(${args})`);
        }
        break;
      }
      case 'workspace:tool_result': {
        if (toolActivityCb) {
          const icon = msg.success ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
          toolActivityCb(`\x1b[2m[ws]\x1b[0m ${icon} \x1b[36m${msg.tool}\x1b[0m`);
        }
        break;
      }
      case 'workspace:chat':
        // Workspace chat messages go to terminal for visibility
        if (toolActivityCb && msg.text) {
          toolActivityCb(`\x1b[2m[ws-chat]\x1b[0m ${msg.text}`.slice(0, 200));
        }
        break;
      case 'workspace:plan_updated':
        if (toolActivityCb) {
          toolActivityCb(`📋 Plan updated (${msg.plan?.length || 0} steps)`);
        }
        break;
      case 'workspace:file_edited':
        if (toolActivityCb) {
          toolActivityCb(`\x1b[2m[ws]\x1b[0m 📝 ${msg.path}`);
        }
        break;

      case 'tool_activity': {
        if (toolActivityCb) {
          const now = new Date();
          const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
          if (msg.action === 'call') {
            toolActivityCb(`\x1b[2m${ts}\x1b[0m \x1b[36m→ ${msg.tool}\x1b[0m(${msg.args || ''})`);
          } else if (msg.action === 'result') {
            const icon = msg.error ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m';
            toolActivityCb(`\x1b[2m${ts}\x1b[0m ${icon} \x1b[36m${msg.tool}\x1b[0m (${msg.size} chars)`);
          }
        }
        break;
      }

      case 'error':
        hideThinking();
        _renderScheduled = false;
        if (currentAssistantEl && currentAssistantContent) {
          currentAssistantEl = null;
          currentAssistantContent = '';
        }
        addMessage({
          role: 'system',
          content: `Error: ${msg.message}`,
          timestamp: Date.now(),
        });
        break;

      case 'done':
        hideThinking();
        _renderScheduled = false;
        if (currentAssistantEl && currentAssistantContent) {
          const body = currentAssistantEl.querySelector('.cc-msg-body');
          if (body) {
            body.innerHTML = renderMarkdown(currentAssistantContent);
          }
          currentAssistantEl = null;
          currentAssistantContent = '';
        }
        // Refresh chat list (title may have updated)
        renderChatList();
        break;

      case 'queued':
        addMessage({
          role: 'system',
          content: `Queued (position ${msg.position})`,
          timestamp: Date.now(),
        });
        break;

      case 'queue_next':
        _renderScheduled = false;
        currentAssistantContent = '';
        currentAssistantEl = null;
        showThinking();
        break;

      case 'cancelled':
        _renderScheduled = false;
        hideThinking();
        addMessage({
          role: 'system',
          content: 'Cancelled.',
          timestamp: Date.now(),
        });
        break;
    }
  });

  conn.on('disconnected', () => {
    setConnState('offline');
    hideThinking();
    addMessage({
      role: 'system',
      content: 'Connection lost. Reconnecting…',
      timestamp: Date.now(),
    });
  });

  conn.connect();

  // ── Send handler ──
  function sendPrompt(): void {
    // Guard: don't send while already generating
    if (isGenerating) return;
    const text = inputEl.value.trim();
    if (!text && pendingImages.length === 0) return;

    // Intake-in-chat: "/build <description>" hands the prompt to the intake
    // agent (plan → review → approve → send) instead of the chat model.
    if (/^\/build\s+/i.test(text)) {
      const buildPrompt = text.replace(/^\/build\s+/i, '').trim();
      if (buildPrompt) {
        inputEl.value = '';
        autoGrow();
        updateSendButton();
        addMessage({ role: 'system', content: `🔨 Handing off to the intake agent to plan: "${buildPrompt}"`, timestamp: Date.now() });
        window.dispatchEvent(new CustomEvent('cc-build', { detail: { prompt: buildPrompt } }));
        switchTab('intake');
      }
      return;
    }

    // Build display content with image thumbnails
    let displayContent = text;
    if (pendingImages.length > 0) {
      const imgHtml = pendingImages.map((url) =>
        `<img class="cc-msg-image" src="${url}">`
      ).join('');
      displayContent = imgHtml + (text ? `<div>${escapeHtml(text)}</div>` : '');
    }

    // Add message with images shown inline
    const msgEl = document.createElement('div');
    msgEl.className = 'cc-msg cc-msg-user';
    msgEl.innerHTML = `
      <div class="cc-msg-label">You <span class="cc-msg-time">${formatTime()}</span></div>
      <div class="cc-msg-body">${pendingImages.length > 0 ? displayContent : escapeHtml(text)}</div>`;
    pruneMessages();
    messagesEl.appendChild(msgEl);
    scrollToBottom({ force: true, smooth: true });

    currentAssistantContent = '';
    currentAssistantEl = null;

    // Include chatId and images if we have them
    const payload: Record<string, unknown> = { type: 'prompt', text: text || 'Analyze this image.' };
    if (activeChatId) {
      payload.chatId = activeChatId;
    }
    if (pendingImages.length > 0) {
      payload.images = [...pendingImages];
    }

    conn.send(payload);
    if (!isGenerating) showThinking();

    // Clear state
    pendingImages.length = 0;
    renderImagePreview();
    inputEl.value = '';
    inputEl.style.height = 'auto';
    autoGrow();
    updateSendButton();
  }

  sendBtn.addEventListener('click', () => {
    if (isGenerating) {
      conn.send({ type: 'cancel' });
      return;
    }
    sendPrompt();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isGenerating) {
        conn.send({ type: 'cancel' });
        return;
      }
      sendPrompt();
    }
  });

  let toolActivityCb: ((line: string) => void) | null = null;
  let fileClickCb: ((path: string) => void) | null = null;
  let messageCb: ((msg: any) => void) | null = null;

  // Tap message listener for preview chat
  conn.on('message', (msg: any) => {
    if (messageCb) messageCb(msg);
  });

  return {
    setWorkDir(path: string) {
      conn.send({ type: 'set_workdir', path });
      contextBar.textContent = `\u{1F4C1} ${path}`;
    },
    startNewChat() {
      newChat();
    },
    onToolActivity(cb: (line: string) => void) {
      toolActivityCb = cb;
    },
    onFileClick(cb: (path: string) => void) {
      fileClickCb = cb;
    },
    onMessage(cb: (msg: any) => void) {
      messageCb = cb;
    },
    sendText(text: string) {
      const payload: Record<string, unknown> = { type: 'prompt', text };
      if (activeChatId) payload.chatId = activeChatId;
      conn.send(payload);
    },
    sendToChannel(channel: string, text: string) {
      conn.send({ type: 'prompt', text, channel });
    },
    dispose() {
      _renderScheduled = false;
      conn.disconnect();
      currentAssistantEl = null;
      currentAssistantContent = '';
      isGenerating = false;
      hideThinking();
    },
  };
}
