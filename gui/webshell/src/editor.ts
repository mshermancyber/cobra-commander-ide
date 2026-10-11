// ---------------------------------------------------------------------------
// Editor tab — file tree + multi-tab code editor + search/replace
// Syntax highlighting via transparent textarea over a code pre element.
// Fetches from API proxy at /api/v1/files/*
// ---------------------------------------------------------------------------

import theme from './theme.js';
import { getWorkspaceRoot } from './workspace-root.js';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

interface EditorTab {
  path: string;
  content: string;
  savedContent: string;
  isDirty: boolean;
}

// ── State ──

let workDir = getWorkspaceRoot();
const tabs: EditorTab[] = [];
let activeTabIdx = -1;

let treeEl: HTMLElement | null = null;
let tabBarEl: HTMLElement | null = null;
let editorWrapEl: HTMLElement | null = null;
let textareaEl: HTMLTextAreaElement | null = null;
let highlighterEl: HTMLElement | null = null;
let lineNumbersEl: HTMLElement | null = null;
let pathLabelEl: HTMLElement | null = null;
let saveBtnEl: HTMLButtonElement | null = null;
let searchPanelEl: HTMLElement | null = null;
let searchInputEl: HTMLInputElement | null = null;
let replaceInputEl: HTMLInputElement | null = null;
let searchCountEl: HTMLElement | null = null;
let wordWrapBtnEl: HTMLButtonElement | null = null;

let wordWrap = false;
let searchResults: Array<{ start: number; end: number }> = [];
let activeSearchIdx = -1;

// ── Syntax highlighting ──

interface TokenRule {
  pattern: RegExp;
  className: string;
}

function buildRules(ext: string): TokenRule[] {
  const rules: TokenRule[] = [];

  // Comments
  rules.push({ pattern: /\/\/.*$/gm, className: 'comment' });
  rules.push({ pattern: /\/\*[\s\S]*?\*\//g, className: 'comment' });

  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    rules.push({ pattern: /'(?:\\.|[^'\\])*'/g, className: 'string' });
    rules.push({ pattern: /"(?:\\.|[^"\\])*"/g, className: 'string' });
    rules.push({ pattern: /`(?:\\.|[^`\\])*`/g, className: 'string' });
    rules.push({ pattern: /\b(import|export|from|default|as|type|interface|enum|const|let|var|function|class|extends|implements|new|return|if|else|for|while|do|switch|case|break|continue|throw|try|catch|finally|async|await|yield|of|in|typeof|instanceof|void|delete|this|super|static|get|set|public|private|protected|readonly|abstract)\b/g, className: 'keyword' });
    rules.push({ pattern: /\b(true|false|null|undefined|NaN|Infinity)\b/g, className: 'literal' });
    rules.push({ pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, className: 'type' });
    rules.push({ pattern: /\b(\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, className: 'number' });
    rules.push({ pattern: /\/\/.*$/gm, className: 'comment' });
  } else if (ext === '.py') {
    rules.push({ pattern: /#.*$/gm, className: 'comment' });
    rules.push({ pattern: /'(?:\\.|[^'\\])*'/g, className: 'string' });
    rules.push({ pattern: /"(?:\\.|[^"\\])*"/g, className: 'string' });
    rules.push({ pattern: /f"(?:\\.|[^"\\])*"/g, className: 'string' });
    rules.push({ pattern: /\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|raise|with|yield|lambda|pass|break|continue|and|or|not|in|is|None|True|False|async|await|global|nonlocal|assert|del)\b/g, className: 'keyword' });
    rules.push({ pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, className: 'type' });
    rules.push({ pattern: /\b(\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, className: 'number' });
  } else if (ext === '.json') {
    rules.push({ pattern: /"(?:\\.|[^"\\])*"\s*:/g, className: 'key' });
    rules.push({ pattern: /"(?:\\.|[^"\\])*"/g, className: 'string' });
    rules.push({ pattern: /\b(true|false|null)\b/g, className: 'literal' });
    rules.push({ pattern: /\b(-?\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, className: 'number' });
  } else if (ext === '.html' || ext === '.htm') {
    rules.push({ pattern: /<!--[\s\S]*?-->/g, className: 'comment' });
    rules.push({ pattern: /"(?:\\.|[^"\\])*"/g, className: 'string' });
    rules.push({ pattern: /'(?:\\.|[^'\\])*'/g, className: 'string' });
    rules.push({ pattern: /<\/?[a-zA-Z][a-zA-Z0-9_-]*/g, className: 'keyword' });
    rules.push({ pattern: /\b[a-zA-Z-]+(?==)/g, className: 'attr' });
  } else if (ext === '.css' || ext === '.scss' || ext === '.less') {
    rules.push({ pattern: /\/\*[\s\S]*?\*\//g, className: 'comment' });
    rules.push({ pattern: /"(?:\\.|[^"\\])*"/g, className: 'string' });
    rules.push({ pattern: /'(?:\\.|[^'\\])*'/g, className: 'string' });
    rules.push({ pattern: /[.#@][a-zA-Z][a-zA-Z0-9_-]*/g, className: 'selector' });
    rules.push({ pattern: /\b[a-zA-Z-]+(?=\s*:)/g, className: 'attr' });
    rules.push({ pattern: /#[0-9a-fA-F]{3,8}\b/g, className: 'number' });
    rules.push({ pattern: /\b(\d+\.?\d*)(px|em|rem|%|vh|vw|ch|ex|cm|mm|in|pt|pc|deg|rad|s|ms|dpi)?\b/g, className: 'number' });
  } else if (ext === '.md' || ext === '.mdx') {
    rules.push({ pattern: /^#{1,6}\s.*$/gm, className: 'keyword' });
    rules.push({ pattern: /\*\*.*?\*\*/g, className: 'literal' });
    rules.push({ pattern: /`[^`]+`/g, className: 'string' });
    rules.push({ pattern: /\[.*?\]\(.*?\)/g, className: 'attr' });
  } else if (ext === '.sh' || ext === '.bash' || ext === '.zsh') {
    rules.push({ pattern: /#.*$/gm, className: 'comment' });
    rules.push({ pattern: /"(?:\\.|[^"\\])*"/g, className: 'string' });
    rules.push({ pattern: /'(?:\\.|[^'\\])*'/g, className: 'string' });
    rules.push({ pattern: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|export|local|source|echo|cd|ls|rm|mv|cp|mkdir|chmod|chown|grep|sed|awk|cat|curl|wget)\b/g, className: 'keyword' });
  } else if (ext === '.rs') {
    rules.push({ pattern: /\/\/.*$/gm, className: 'comment' });
    rules.push({ pattern: /\/\*[\s\S]*?\*\//g, className: 'comment' });
    rules.push({ pattern: /"(?:\\.|[^"\\])*"/g, className: 'string' });
    rules.push({ pattern: /\b(fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|where|for|in|if|else|match|loop|while|return|break|continue|async|await|move|ref|self|super|crate|unsafe|extern|type|as|dyn|static|true|false|Some|None|Ok|Err|Option|Result|Vec|String|Box)\b/g, className: 'keyword' });
    rules.push({ pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, className: 'type' });
    rules.push({ pattern: /\b(\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, className: 'number' });
  } else if (ext === '.go') {
    rules.push({ pattern: /\/\/.*$/gm, className: 'comment' });
    rules.push({ pattern: /\/\*[\s\S]*?\*\//g, className: 'comment' });
    rules.push({ pattern: /"(?:\\.|[^"\\])*"/g, className: 'string' });
    rules.push({ pattern: /`(?:\\.|[^`\\])*`/g, className: 'string' });
    rules.push({ pattern: /\b(func|var|const|type|struct|interface|map|chan|go|defer|return|if|else|for|range|switch|case|default|break|continue|package|import|nil|true|false|make|new|append|len|cap|select|fallthrough)\b/g, className: 'keyword' });
    rules.push({ pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, className: 'type' });
    rules.push({ pattern: /\b(\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, className: 'number' });
  } else if (ext === '.yaml' || ext === '.yml') {
    rules.push({ pattern: /#.*$/gm, className: 'comment' });
    rules.push({ pattern: /"(?:\\.|[^"\\])*"/g, className: 'string' });
    rules.push({ pattern: /'(?:\\.|[^'\\])*'/g, className: 'string' });
    rules.push({ pattern: /^[\w-]+(?=\s*:)/gm, className: 'key' });
    rules.push({ pattern: /\b(true|false|null|yes|no|on|off)\b/g, className: 'literal' });
    rules.push({ pattern: /\b(\d+\.?\d*)\b/g, className: 'number' });
  } else {
    // Generic fallback: strings + comments
    rules.push({ pattern: /"(?:\\.|[^"\\])*"/g, className: 'string' });
    rules.push({ pattern: /'(?:\\.|[^'\\])*'/g, className: 'string' });
    rules.push({ pattern: /\b(\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, className: 'number' });
  }

  return rules;
}

function getExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot > 0 ? path.slice(dot).toLowerCase() : '';
}

function highlightCode(code: string, ext: string): string {
  const escapeMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const escaped = code.replace(/[&<>"]/g, c => escapeMap[c]);
  if (!ext || code.length > 200_000) return escaped;

  const rules = buildRules(ext);
  const marks = new Array<{ pos: number; tag: string }>(code.length + 1);

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(code)) !== null) {
      let pos = m.index;
      let len = m[0].length;

      if (rule.className === 'key') {
        // JSON keys: only highlight the key part before :
        const colonIdx = m[0].indexOf(':');
        if (colonIdx > 0) len = colonIdx;
      }
      if (rule.className === 'attr' && ext === '.css') {
        // CSS property: only the property name before :
        const colonIdx = m[0].indexOf(':');
        if (colonIdx > 0) len = colonIdx;
      }

      if (!marks[pos]) marks[pos] = { pos, tag: '' };
      if (!marks[pos].tag.includes(`<span class="hl-${rule.className}">`)) {
        marks[pos].tag += `<span class="hl-${rule.className}">`;
      }
      const endPos = pos + len;
      if (!marks[endPos]) marks[endPos] = { pos: endPos, tag: '' };
      marks[endPos].tag = '</span>' + marks[endPos].tag;
    }
  }

  let result = '';
  let i = 0;
  while (i <= code.length) {
    if (marks[i]) result += marks[i].tag;
    if (i < code.length) result += escaped[i];
    i++;
  }
  return result;
}

// ── CSS ──

function injectEditorStyles(): void {
  if (document.getElementById('cc-editor-styles')) return;
  const style = document.createElement('style');
  style.id = 'cc-editor-styles';
  style.textContent = `
    .cc-editor-wrap {
      display: grid;
      grid-template-columns: 240px 1fr;
      height: 100%;
      overflow: hidden;
    }
    .cc-editor-tree {
      overflow-y: auto;
      overflow-x: hidden;
      background: ${theme.bgSecondary};
      border-right: 1px solid ${theme.border};
      padding: 8px 0;
      font-size: 13px;
    }
    .cc-editor-tree-header {
      padding: 8px 12px;
      font-size: 10px;
      font-weight: 600;
      color: ${theme.textMuted};
      text-transform: uppercase;
      letter-spacing: 0.06em;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .cc-editor-tree-refresh {
      background: none;
      border: none;
      color: ${theme.textMuted};
      cursor: pointer;
      font-size: 12px;
      padding: 2px 4px;
    }
    .cc-editor-tree-refresh:hover { color: ${theme.accent}; }
    .cc-tree-item {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 12px;
      cursor: pointer;
      color: ${theme.text};
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: background 0.1s;
    }
    .cc-tree-item:hover { background: rgba(255,255,255,0.04); }
    .cc-tree-item.active { background: rgba(0,255,65,0.08); color: ${theme.accent}; }
    .cc-tree-item .cc-tree-icon {
      width: 14px;
      text-align: center;
      flex-shrink: 0;
      font-size: 11px;
    }
    .cc-tree-item .cc-tree-name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cc-editor-main {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .cc-editor-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background: ${theme.bgSecondary};
      border-bottom: 1px solid ${theme.border};
      font-size: 12px;
      min-height: 32px;
      flex-shrink: 0;
    }
    .cc-editor-path {
      flex: 1;
      color: ${theme.textMuted};
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cc-editor-save-btn {
      padding: 3px 12px;
      background: ${theme.accent};
      color: ${theme.bg};
      border: none;
      border-radius: 4px;
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      opacity: 0.4;
      transition: opacity 0.15s;
      white-space: nowrap;
    }
    .cc-editor-save-btn.dirty { opacity: 1; }
    .cc-editor-save-btn:active { opacity: 0.8; }
    .cc-editor-toolbar-btn {
      padding: 3px 8px;
      background: none;
      color: ${theme.textMuted};
      border: 1px solid ${theme.border};
      border-radius: 4px;
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
      transition: color 0.12s, border-color 0.12s;
    }
    .cc-editor-toolbar-btn:hover { color: ${theme.text}; border-color: ${theme.textSecondary}; }
    .cc-editor-toolbar-btn.active { color: ${theme.accent}; border-color: ${theme.accent}; }

    /* Tab bar */
    .cc-editor-tab-bar {
      display: flex;
      align-items: stretch;
      background: ${theme.bg};
      border-bottom: 1px solid ${theme.border};
      overflow-x: auto;
      overflow-y: hidden;
      flex-shrink: 0;
      min-height: 32px;
    }
    .cc-editor-tab-bar::-webkit-scrollbar { height: 2px; }
    .cc-editor-tab {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 12px;
      font-size: 12px;
      color: ${theme.textMuted};
      background: transparent;
      border: none;
      border-right: 1px solid ${theme.border};
      cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
      transition: background 0.1s;
      flex-shrink: 0;
      max-width: 200px;
      overflow: hidden;
    }
    .cc-editor-tab:hover { background: rgba(255,255,255,0.03); }
    .cc-editor-tab.active { color: ${theme.text}; background: ${theme.bgSecondary}; }
    .cc-editor-tab.active .cc-editor-tab-name { color: ${theme.accent}; }
    .cc-editor-tab-name {
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
      direction: rtl;
      text-align: left;
    }
    .cc-editor-tab-dirty {
      color: ${theme.accentYellow};
      font-size: 14px;
      line-height: 1;
      flex-shrink: 0;
    }
    .cc-editor-tab-close {
      color: ${theme.textMuted};
      font-size: 14px;
      line-height: 1;
      flex-shrink: 0;
      padding: 0 2px;
      border-radius: 2px;
      transition: color 0.1s, background 0.1s;
    }
    .cc-editor-tab-close:hover { color: ${theme.accentRed}; background: rgba(255,77,77,0.15); }

    /* Editor body */
    .cc-editor-body {
      flex: 1;
      display: flex;
      overflow: hidden;
      position: relative;
    }
    .cc-editor-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      width: 100%;
      color: ${theme.textMuted};
      font-size: 14px;
      gap: 8px;
    }

    /* Search panel */
    .cc-editor-search-panel {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: ${theme.bgTertiary};
      border-bottom: 1px solid ${theme.border};
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .cc-editor-search-panel.open { display: flex; }
    .cc-editor-search-input {
      width: 200px;
      background: ${theme.inputAreaBg};
      color: ${theme.text};
      border: 1px solid ${theme.border};
      border-radius: 4px;
      padding: 4px 8px;
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }
    .cc-editor-search-input:focus { border-color: rgba(0,255,65,0.4); }
    .cc-editor-search-count {
      font-size: 11px;
      color: ${theme.textMuted};
      min-width: 50px;
    }
    .cc-editor-search-nav {
      display: flex;
      gap: 2px;
    }
    .cc-editor-search-nav-btn {
      background: none;
      border: 1px solid ${theme.border};
      color: ${theme.textMuted};
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
      padding: 2px 6px;
      font-family: inherit;
    }
    .cc-editor-search-nav-btn:hover { color: ${theme.text}; }
    .cc-editor-search-close {
      background: none;
      border: none;
      color: ${theme.textMuted};
      font-size: 15px;
      cursor: pointer;
      padding: 0 4px;
    }
    .cc-editor-search-close:hover { color: ${theme.accentRed}; }

    /* Editor viewport (line numbers + code) */
    .cc-editor-viewport {
      flex: 1;
      display: flex;
      overflow: hidden;
      position: relative;
    }
    .cc-editor-gutter {
      width: 52px;
      flex-shrink: 0;
      overflow: hidden;
      background: ${theme.bgSecondary};
      border-right: 1px solid ${theme.border};
      text-align: right;
      padding: 0 8px 0 4px;
      font-family: 'SF Mono', 'Menlo', 'Consolas', 'ui-monospace', monospace;
      font-size: 13px;
      line-height: 1.5;
      color: ${theme.textMuted};
      user-select: none;
      -webkit-user-select: none;
      white-space: pre;
      overflow-y: hidden;
    }
    .cc-editor-code-area {
      flex: 1;
      position: relative;
      overflow: auto;
    }
    .cc-editor-highlighter {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      min-height: 100%;
      padding: 12px 16px;
      font-family: 'SF Mono', 'Menlo', 'Consolas', 'ui-monospace', monospace;
      font-size: 13px;
      line-height: 1.5;
      tab-size: 2;
      white-space: pre;
      overflow: hidden;
      color: ${theme.text};
      background: ${theme.bg};
      pointer-events: none;
    }
    .cc-editor-textarea {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      padding: 12px 16px;
      font-family: 'SF Mono', 'Menlo', 'Consolas', 'ui-monospace', monospace;
      font-size: 13px;
      line-height: 1.5;
      tab-size: 2;
      color: transparent;
      caret-color: ${theme.text};
      background: transparent;
      border: none;
      outline: none;
      resize: none;
      overflow: auto;
      white-space: pre;
    }
    .cc-editor-textarea::placeholder { color: ${theme.textMuted}; }
    .cc-editor-textarea::selection {
      background: rgba(0,255,65,0.25);
      color: transparent;
    }

    /* Syntax highlighting classes */
    .hl-keyword { color: ${theme.accentPurple}; }
    .hl-string { color: ${theme.accentYellow}; }
    .hl-comment { color: ${theme.textMuted}; font-style: italic; }
    .hl-number { color: ${theme.accentOrange}; }
    .hl-literal { color: ${theme.accentOrange}; }
    .hl-type { color: ${theme.accent}; }
    .hl-key { color: ${theme.accent}; }
    .hl-attr { color: ${theme.accentYellow}; }
    .hl-selector { color: ${theme.accentPurple}; }

    .cc-editor-highlight-match {
      background: rgba(255,136,0,0.35);
      border-radius: 2px;
    }
    .cc-editor-highlight-active {
      background: rgba(0,255,65,0.3);
      border-radius: 2px;
    }

    /* Workdir bar */
    .cc-editor-workdir {
      padding: 6px 12px;
      background: ${theme.bg};
      border-bottom: 1px solid ${theme.border};
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cc-editor-workdir-input {
      flex: 1;
      background: ${theme.inputAreaBg};
      color: ${theme.text};
      border: 1px solid ${theme.border};
      border-radius: 4px;
      padding: 4px 8px;
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }
    .cc-editor-workdir-input:focus { border-color: rgba(0,255,65,0.4); }
    .cc-editor-workdir-btn {
      padding: 4px 10px;
      background: none;
      color: ${theme.textMuted};
      border: 1px solid ${theme.border};
      border-radius: 4px;
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .cc-editor-workdir-btn:hover { color: ${theme.accent}; border-color: ${theme.accent}; }

    @media (max-width: 768px) {
      .cc-editor-wrap { grid-template-columns: 1fr; }
      .cc-editor-tree { display: none; }
      .cc-editor-tab { max-width: 120px; font-size: 11px; }
      .cc-editor-gutter { width: 40px; font-size: 11px; }
      .cc-editor-search-input { width: 130px; }
    }
  `;
  document.head.appendChild(style);
}

// ── File API helpers ──

function normalizeNodes(nodes: any[], parentDir: string): FileNode[] {
  return nodes.map((n: any) => {
    const fullPath = n.path || `${parentDir}/${n.name}`;
    return {
      name: n.name,
      path: fullPath,
      type: (n.type === 'dir' ? 'directory' : n.type) as 'file' | 'directory',
      children: n.children ? normalizeNodes(n.children, fullPath) : undefined,
    };
  });
}

async function fetchTree(dir: string): Promise<FileNode[]> {
  try {
    const resp = await fetch(`/api/v1/files/tree?path=${encodeURIComponent(dir)}&depth=3`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const raw = data.tree || data.children || data || [];
    return normalizeNodes(raw, dir);
  } catch {
    return [];
  }
}

async function fetchFile(filePath: string): Promise<string> {
  try {
    const resp = await fetch(`/api/v1/files?path=${encodeURIComponent(filePath)}`);
    if (!resp.ok) return `// Error loading ${filePath}`;
    const data = await resp.json();
    return data.content || '';
  } catch {
    return `// Error loading ${filePath}`;
  }
}

async function saveFile(filePath: string, content: string): Promise<boolean> {
  try {
    const resp = await fetch('/api/v1/files', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ── File tree ──

function renderTree(nodes: FileNode[], container: HTMLElement, depth = 0): void {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const node of sorted) {
    const item = document.createElement('div');
    item.className = 'cc-tree-item';
    item.style.paddingLeft = `${12 + depth * 16}px`;

    const icon = document.createElement('span');
    icon.className = 'cc-tree-icon';
    if (node.type === 'directory') {
      icon.textContent = '▸';
    } else {
      const ext = getExtension(node.name);
      icon.textContent = fileIcon(ext);
    }

    const name = document.createElement('span');
    name.className = 'cc-tree-name';
    name.textContent = node.name;

    item.appendChild(icon);
    item.appendChild(name);
    container.appendChild(item);

    if (node.type === 'file') {
      item.addEventListener('click', () => openFileInTab(node.path));
    } else if (node.type === 'directory') {
      let expanded = false;
      const childContainer = document.createElement('div');
      childContainer.style.display = 'none';
      container.appendChild(childContainer);

      if (node.children && node.children.length > 0) {
        renderTree(node.children, childContainer, depth + 1);
      }

      item.addEventListener('click', async () => {
        expanded = !expanded;
        icon.textContent = expanded ? '▾' : '▸';
        if (expanded) {
          if (childContainer.children.length === 0) {
            const children = await fetchTree(node.path);
            renderTree(children, childContainer, depth + 1);
          }
          childContainer.style.display = '';
        } else {
          childContainer.style.display = 'none';
        }
      });
    }
  }
}

function fileIcon(ext: string): string {
  const map: Record<string, string> = {
    '.ts': '🟦', '.tsx': '⚛', '.js': '🟨', '.jsx': '⚛', '.mjs': '🟨',
    '.json': '{ }', '.html': '🌐', '.htm': '🌐', '.css': '🎨', '.scss': '🎨',
    '.md': '📝', '.mdx': '📝', '.py': '🐍', '.rs': '🦀', '.go': '🔵',
    '.sh': '⚡', '.bash': '⚡', '.yaml': '⚙', '.yml': '⚙',
    '.svg': '🖼', '.png': '🖼', '.jpg': '🖼', '.gif': '🖼',
    '.sql': '🗄', '.graphql': '◈', '.xml': '📋', '.toml': '⚙',
    '.env': '🔑', '.gitignore': '🙈', '.dockerfile': '🐳',
  };
  return map[ext] || '·';
}

async function loadTree(): Promise<void> {
  if (!treeEl) return;
  treeEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'cc-editor-tree-header';
  header.innerHTML = '<span>Files</span>';
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'cc-editor-tree-refresh';
  refreshBtn.textContent = '⟳';
  refreshBtn.addEventListener('click', loadTree);
  header.appendChild(refreshBtn);
  treeEl.appendChild(header);

  const nodes = await fetchTree(workDir);
  renderTree(nodes, treeEl);
}

// ── Tab management ──

function getTabIndex(path: string): number {
  return tabs.findIndex(t => t.path === path);
}

async function openFileInTab(filePath: string): Promise<void> {
  // Check if already open
  const existing = getTabIndex(filePath);
  if (existing >= 0) {
    activateTab(existing);
    highlightTreeItem(filePath);
    return;
  }

  // Check unsaved in active tab
  if (activeTabIdx >= 0 && tabs[activeTabIdx].isDirty) {
    if (!confirm(`Unsaved changes in ${tabs[activeTabIdx].path}. Discard?`)) return;
  }

  const content = await fetchFile(filePath);
  const tab: EditorTab = {
    path: filePath,
    content,
    savedContent: content,
    isDirty: false,
  };

  tabs.push(tab);
  activateTab(tabs.length - 1);
  renderTabBar();
  highlightTreeItem(filePath);
}

function activateTab(idx: number): void {
  if (idx < 0 || idx >= tabs.length) return;
  activeTabIdx = idx;
  const tab = tabs[idx];

  if (textareaEl) textareaEl.value = tab.content;
  if (pathLabelEl) pathLabelEl.textContent = tab.path;
  updateSaveBtn();
  updateLineNumbers();
  updateHighlighting();
  syncScroll();
  renderTabBar();
}

function closeTab(idx: number): void {
  if (idx < 0 || idx >= tabs.length) return;

  if (tabs[idx].isDirty) {
    if (!confirm(`Unsaved changes in ${tabs[idx].path}. Close anyway?`)) return;
  }

  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    activeTabIdx = -1;
    clearEditor();
  } else if (idx <= activeTabIdx) {
    activeTabIdx = Math.min(activeTabIdx, tabs.length - 1);
    activateTab(activeTabIdx);
  }
  renderTabBar();
}

function renderTabBar(): void {
  if (!tabBarEl) return;
  tabBarEl.innerHTML = '';

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const el = document.createElement('div');
    el.className = `cc-editor-tab${i === activeTabIdx ? ' active' : ''}`;

    const name = document.createElement('span');
    name.className = 'cc-editor-tab-name';
    const slash = tab.path.lastIndexOf('/');
    name.textContent = slash >= 0 ? tab.path.slice(slash + 1) : tab.path;
    name.title = tab.path;

    el.appendChild(name);

    if (tab.isDirty) {
      const dirty = document.createElement('span');
      dirty.className = 'cc-editor-tab-dirty';
      dirty.textContent = '●';
      el.appendChild(dirty);
    }

    const close = document.createElement('span');
    close.className = 'cc-editor-tab-close';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(i);
    });
    el.appendChild(close);

    el.addEventListener('click', () => activateTab(i));
    // Middle-click to close
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(i); }
    });

    tabBarEl.appendChild(el);
  }
}

function highlightTreeItem(filePath: string): void {
  document.querySelectorAll('.cc-tree-item.active').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.cc-tree-item').forEach(el => {
    const nameEl = el.querySelector('.cc-tree-name');
    if (nameEl && filePath.endsWith(nameEl.textContent || '')) {
      el.classList.add('active');
    }
  });
}

function clearEditor(): void {
  if (textareaEl) {
    textareaEl.value = '';
    textareaEl.placeholder = 'Select a file from the tree to start editing...';
  }
  if (highlighterEl) highlighterEl.innerHTML = '';
  if (lineNumbersEl) lineNumbersEl.textContent = '';
  if (pathLabelEl) pathLabelEl.textContent = 'No file open';
  if (saveBtnEl) saveBtnEl.classList.remove('dirty');
}

// ── Line numbers ──

function updateLineNumbers(): void {
  if (!lineNumbersEl || !textareaEl) return;
  const text = textareaEl.value;
  const count = text === '' ? 1 : text.split('\n').length;
  let nums = '';
  for (let i = 1; i <= count; i++) {
    nums += i + '\n';
  }
  lineNumbersEl.textContent = nums;
}

// ── Syntax highlighting ──

function updateHighlighting(): void {
  if (!highlighterEl || !textareaEl) return;
  if (activeTabIdx < 0) { highlighterEl.innerHTML = ''; return; }

  const text = textareaEl.value;
  const ext = getExtension(tabs[activeTabIdx].path);

  if (text.length > 200_000) {
    // Large files: just escape, no syntax highlighting
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    highlighterEl.innerHTML = applySearchHighlights(escaped);
    return;
  }

  const html = highlightCode(text, ext);
  highlighterEl.innerHTML = applySearchHighlights(html);
}

function applySearchHighlights(html: string): string {
  if (searchResults.length === 0) return html;

  // Apply search highlights by wrapping matches
  // We need to be careful not to match inside HTML tags
  // For simplicity, add markers after the fact
  // Since the HTML only has <span class="hl-..."> tags, we can do text-level matching
  // However this is complex — skip for now, the search panel will highlight in textarea via selection
  return html;
}

// ── Scroll sync ──

function syncScroll(): void {
  if (!textareaEl || !highlighterEl || !lineNumbersEl) return;
  highlighterEl.scrollTop = textareaEl.scrollTop;
  highlighterEl.scrollLeft = textareaEl.scrollLeft;
  lineNumbersEl.scrollTop = textareaEl.scrollTop;
}

// ── Search / Replace ──

function toggleSearch(showReplace: boolean): void {
  if (!searchPanelEl) return;
  const open = searchPanelEl.classList.toggle('open');
  if (open) {
    searchPanelEl.style.display = 'flex';
    if (searchInputEl) searchInputEl.focus();
    if (replaceInputEl) replaceInputEl.style.display = showReplace ? '' : 'none';
  } else {
    searchPanelEl.style.display = 'none';
    clearSearchHighlights();
  }
}

function doSearch(): void {
  if (!textareaEl || !searchInputEl) return;
  const query = searchInputEl.value;
  searchResults = [];
  activeSearchIdx = -1;

  if (!query) {
    if (searchCountEl) searchCountEl.textContent = '';
    clearSearchHighlights();
    return;
  }

  const text = textareaEl.value;
  let idx = 0;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  while ((idx = lowerText.indexOf(lowerQuery, idx)) !== -1) {
    searchResults.push({ start: idx, end: idx + query.length });
    idx++;
  }

  if (searchCountEl) {
    searchCountEl.textContent = searchResults.length > 0
      ? `${searchResults.length} match${searchResults.length > 1 ? 'es' : ''}`
      : 'No matches';
  }

  if (searchResults.length > 0) {
    activeSearchIdx = 0;
    selectSearchMatch(0);
  }
}

function selectSearchMatch(idx: number): void {
  if (!textareaEl || idx < 0 || idx >= searchResults.length) return;
  activeSearchIdx = idx;
  const m = searchResults[idx];
  textareaEl.focus();
  textareaEl.setSelectionRange(m.start, m.end);
  // Scroll the match into view
  const textBefore = textareaEl.value.substring(0, m.start);
  const lineNum = textBefore.split('\n').length;
  const lineHeight = 19.5; // 13px * 1.5
  textareaEl.scrollTop = Math.max(0, (lineNum - 5) * lineHeight);
  syncScroll();

  if (searchCountEl) {
    searchCountEl.textContent = `${idx + 1}/${searchResults.length}`;
  }
}

function nextSearchMatch(): void {
  if (searchResults.length === 0) return;
  const next = (activeSearchIdx + 1) % searchResults.length;
  selectSearchMatch(next);
}

function prevSearchMatch(): void {
  if (searchResults.length === 0) return;
  const prev = (activeSearchIdx - 1 + searchResults.length) % searchResults.length;
  selectSearchMatch(prev);
}

function doReplace(): void {
  if (!textareaEl || !replaceInputEl || activeSearchIdx < 0) return;
  const replaceText = replaceInputEl.value;
  const m = searchResults[activeSearchIdx];
  const text = textareaEl.value;
  textareaEl.value = text.substring(0, m.start) + replaceText + text.substring(m.end);
  markDirty();
  doSearch();
}

function doReplaceAll(): void {
  if (!textareaEl || !searchInputEl || !replaceInputEl) return;
  const query = searchInputEl.value;
  const replaceText = replaceInputEl.value;
  if (!query) return;

  const text = textareaEl.value;
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escapedQuery, 'gi');
  textareaEl.value = text.replace(regex, replaceText);
  markDirty();
  doSearch();
}

function clearSearchHighlights(): void {
  searchResults = [];
  activeSearchIdx = -1;
  if (searchCountEl) searchCountEl.textContent = '';
  updateHighlighting();
}

// ── Dirty state ──

function markDirty(): void {
  if (activeTabIdx < 0) return;
  const tab = tabs[activeTabIdx];
  tab.isDirty = tab.content !== textareaEl!.value;
  updateSaveBtn();
  renderTabBar();
  updateLineNumbers();
  updateHighlighting();
}

function updateSaveBtn(): void {
  if (!saveBtnEl || activeTabIdx < 0) {
    if (saveBtnEl) saveBtnEl.classList.remove('dirty');
    return;
  }
  if (tabs[activeTabIdx].isDirty) {
    saveBtnEl.classList.add('dirty');
  } else {
    saveBtnEl.classList.remove('dirty');
  }
}

// ── Main createEditor export ──

export function createEditor(container: HTMLElement): void {
  injectEditorStyles();

  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'cc-editor-wrap';

  // ── File tree panel ──
  const tree = document.createElement('div');
  tree.className = 'cc-editor-tree';
  treeEl = tree;

  // ── Main editor panel ──
  const main = document.createElement('div');
  main.className = 'cc-editor-main';

  // Working directory bar
  const wdBar = document.createElement('div');
  wdBar.className = 'cc-editor-workdir';

  const wdInput = document.createElement('input');
  wdInput.className = 'cc-editor-workdir-input';
  wdInput.type = 'text';
  wdInput.value = workDir;
  wdInput.placeholder = 'Working directory...';

  const wdBtn = document.createElement('button');
  wdBtn.className = 'cc-editor-workdir-btn';
  wdBtn.textContent = 'Open';
  wdBtn.addEventListener('click', () => {
    workDir = wdInput.value.trim() || getWorkspaceRoot();
    loadTree();
  });
  wdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      workDir = wdInput.value.trim() || getWorkspaceRoot();
      loadTree();
    }
  });

  wdBar.appendChild(wdInput);
  wdBar.appendChild(wdBtn);

  // ── Toolbar ──
  const toolbar = document.createElement('div');
  toolbar.className = 'cc-editor-toolbar';

  const pathLabel = document.createElement('span');
  pathLabel.className = 'cc-editor-path';
  pathLabel.textContent = 'No file open';
  pathLabelEl = pathLabel;

  const saveBtn = document.createElement('button');
  saveBtn.className = 'cc-editor-save-btn';
  saveBtn.textContent = 'Save';
  saveBtnEl = saveBtn;
  saveBtn.addEventListener('click', async () => {
    if (activeTabIdx < 0 || !textareaEl) return;
    const tab = tabs[activeTabIdx];
    const ok = await saveFile(tab.path, textareaEl.value);
    if (ok) {
      tab.content = textareaEl.value;
      tab.savedContent = textareaEl.value;
      tab.isDirty = false;
      updateSaveBtn();
      renderTabBar();
    } else {
      alert('Save failed');
    }
  });

  // Word wrap toggle
  const wwBtn = document.createElement('button');
  wwBtn.className = 'cc-editor-toolbar-btn';
  wwBtn.textContent = '↩';
  wwBtn.title = 'Toggle word wrap';
  wordWrapBtnEl = wwBtn;
  wwBtn.addEventListener('click', () => {
    wordWrap = !wordWrap;
    wwBtn.classList.toggle('active', wordWrap);
    if (textareaEl) {
      textareaEl.style.whiteSpace = wordWrap ? 'pre-wrap' : 'pre';
    }
    if (highlighterEl) {
      highlighterEl.style.whiteSpace = wordWrap ? 'pre-wrap' : 'pre';
    }
  });

  toolbar.appendChild(pathLabel);
  toolbar.appendChild(saveBtn);
  toolbar.appendChild(wwBtn);

  // ── Tab bar ──
  const tabBar = document.createElement('div');
  tabBar.className = 'cc-editor-tab-bar';
  tabBarEl = tabBar;

  // ── Search panel ──
  const searchPanel = document.createElement('div');
  searchPanel.className = 'cc-editor-search-panel';
  searchPanelEl = searchPanel;

  const sInput = document.createElement('input');
  sInput.className = 'cc-editor-search-input';
  sInput.type = 'text';
  sInput.placeholder = 'Find...';
  sInput.addEventListener('input', doSearch);
  sInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) prevSearchMatch();
      else nextSearchMatch();
    }
    if (e.key === 'Escape') toggleSearch(false);
  });
  searchInputEl = sInput;

  const rInput = document.createElement('input');
  rInput.className = 'cc-editor-search-input';
  rInput.type = 'text';
  rInput.placeholder = 'Replace...';
  rInput.style.display = 'none';
  rInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doReplace(); }
    if (e.key === 'Escape') toggleSearch(false);
  });
  replaceInputEl = rInput;

  const countEl = document.createElement('span');
  countEl.className = 'cc-editor-search-count';
  searchCountEl = countEl;

  const navDiv = document.createElement('div');
  navDiv.className = 'cc-editor-search-nav';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'cc-editor-search-nav-btn';
  prevBtn.textContent = '▲';
  prevBtn.title = 'Previous match';
  prevBtn.addEventListener('click', prevSearchMatch);

  const nextBtn = document.createElement('button');
  nextBtn.className = 'cc-editor-search-nav-btn';
  nextBtn.textContent = '▼';
  nextBtn.title = 'Next match';
  nextBtn.addEventListener('click', nextSearchMatch);

  navDiv.appendChild(prevBtn);
  navDiv.appendChild(nextBtn);

  const replaceBtn = document.createElement('button');
  replaceBtn.className = 'cc-editor-search-nav-btn';
  replaceBtn.textContent = 'Replace';
  replaceBtn.addEventListener('click', doReplace);

  const replaceAllBtn = document.createElement('button');
  replaceAllBtn.className = 'cc-editor-search-nav-btn';
  replaceAllBtn.textContent = 'All';
  replaceAllBtn.title = 'Replace all';
  replaceAllBtn.addEventListener('click', doReplaceAll);

  const closeSearchBtn = document.createElement('button');
  closeSearchBtn.className = 'cc-editor-search-close';
  closeSearchBtn.textContent = '×';
  closeSearchBtn.addEventListener('click', () => toggleSearch(false));

  searchPanel.appendChild(sInput);
  searchPanel.appendChild(rInput);
  searchPanel.appendChild(countEl);
  searchPanel.appendChild(navDiv);
  searchPanel.appendChild(replaceBtn);
  searchPanel.appendChild(replaceAllBtn);
  searchPanel.appendChild(closeSearchBtn);

  // ── Editor body ──
  const editorBody = document.createElement('div');
  editorBody.className = 'cc-editor-body';
  editorWrapEl = editorBody;

  // Empty state
  const empty = document.createElement('div');
  empty.className = 'cc-editor-empty';
  empty.innerHTML = '<span>📝</span> Select a file from the tree to start editing';
  empty.id = 'cc-editor-empty-state';

  // Viewport (gutter + code)
  const viewport = document.createElement('div');
  viewport.className = 'cc-editor-viewport';
  viewport.style.display = 'none';
  viewport.id = 'cc-editor-viewport';

  const gutter = document.createElement('div');
  gutter.className = 'cc-editor-gutter';
  lineNumbersEl = gutter;

  const codeArea = document.createElement('div');
  codeArea.className = 'cc-editor-code-area';

  const highlighter = document.createElement('pre');
  highlighter.className = 'cc-editor-highlighter';
  highlighterEl = highlighter;

  const textarea = document.createElement('textarea');
  textarea.className = 'cc-editor-textarea';
  textarea.placeholder = 'Select a file from the tree to start editing...';
  textarea.spellcheck = false;
  textareaEl = textarea;

  textarea.addEventListener('input', () => {
    markDirty();
    syncScroll();
  });

  textarea.addEventListener('scroll', syncScroll);

  // Keyboard shortcuts
  textarea.addEventListener('keydown', (e) => {
    // Tab for indentation
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      if (e.shiftKey) {
        // Un-indent
        const lineStart = textarea.value.lastIndexOf('\n', start - 1) + 1;
        const line = textarea.value.substring(lineStart, start);
        const match = line.match(/^ {1,2}/);
        if (match) {
          textarea.value = textarea.value.substring(0, lineStart) + textarea.value.substring(lineStart + match[0].length);
          textarea.selectionStart = textarea.selectionEnd = start - match[0].length;
          textarea.dispatchEvent(new Event('input'));
        }
      } else {
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        textarea.dispatchEvent(new Event('input'));
      }
      return;
    }

    // Ctrl+S: Save
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveBtn.click();
      return;
    }

    // Ctrl+F: Find
    if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (searchPanelEl) {
        const isOpen = searchPanelEl.classList.contains('open');
        if (!isOpen) {
          searchPanelEl.classList.add('open');
          searchPanelEl.style.display = 'flex';
          if (replaceInputEl) replaceInputEl.style.display = 'none';
          if (searchInputEl) { searchInputEl.focus(); searchInputEl.select(); }
        } else {
          if (searchInputEl) searchInputEl.focus();
        }
      }
      return;
    }

    // Ctrl+H: Replace
    if (e.key === 'h' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (searchPanelEl) {
        const isOpen = searchPanelEl.classList.contains('open');
        if (!isOpen || (replaceInputEl && replaceInputEl.style.display === 'none')) {
          searchPanelEl.classList.add('open');
          searchPanelEl.style.display = 'flex';
          if (replaceInputEl) replaceInputEl.style.display = '';
          if (searchInputEl) { searchInputEl.focus(); searchInputEl.select(); }
        }
      }
      return;
    }

    // Escape: close search
    if (e.key === 'Escape' && searchPanelEl && searchPanelEl.classList.contains('open')) {
      toggleSearch(false);
      return;
    }

    // Ctrl+W: close tab
    if (e.key === 'w' && (e.ctrlKey || e.metaKey) && activeTabIdx >= 0) {
      e.preventDefault();
      closeTab(activeTabIdx);
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab: next/prev tab
    if (e.key === 'Tab' && (e.ctrlKey || e.metaKey) && tabs.length > 1) {
      e.preventDefault();
      if (e.shiftKey) {
        const prev = activeTabIdx - 1;
        activateTab(prev < 0 ? tabs.length - 1 : prev);
      } else {
        activateTab((activeTabIdx + 1) % tabs.length);
      }
      return;
    }
  });

  // Mouse wheel on gutter syncs
  gutter.addEventListener('wheel', (e) => {
    if (textareaEl) {
      textareaEl.scrollTop += e.deltaY;
      syncScroll();
      e.preventDefault();
    }
  });

  codeArea.appendChild(highlighter);
  codeArea.appendChild(textarea);
  viewport.appendChild(gutter);
  viewport.appendChild(codeArea);
  editorBody.appendChild(empty);
  editorBody.appendChild(viewport);

  // Assemble main panel
  main.appendChild(wdBar);
  main.appendChild(toolbar);
  main.appendChild(tabBar);
  main.appendChild(searchPanel);
  main.appendChild(editorBody);

  wrap.appendChild(tree);
  wrap.appendChild(main);
  container.appendChild(wrap);

  // Initial tree load
  loadTree();
}

export function setEditorWorkDir(dir: string): void {
  workDir = dir;
  const wdInput = document.querySelector('.cc-editor-workdir-input') as HTMLInputElement;
  if (wdInput) wdInput.value = dir;
  loadTree();
}
