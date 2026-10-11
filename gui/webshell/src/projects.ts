// ---------------------------------------------------------------------------
// Projects — compact folder picker dropdown
// Open a folder, set as active workspace, start a new chat.
// ---------------------------------------------------------------------------

import theme from './theme.js';
import { getWorkspaceRoot } from './workspace-root.js';

interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

type OnProjectSelect = (projectPath: string) => void;

const PROJECTS_ROOT = '/data';

let onSelect: OnProjectSelect = () => {};
let _pickerEl: HTMLElement | null = null;
let _pathInputEl: HTMLInputElement | null = null;
let _openBtnEl: HTMLButtonElement | null = null;
let _activeProjectEl: HTMLElement | null = null;
let _activeProject = '';

function injectProjectStyles(): void {
  if (document.getElementById('cc-projects-styles')) return;
  const style = document.createElement('style');
  style.id = 'cc-projects-styles';
  style.textContent = `
    .cc-projects-wrap {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      background: ${theme.bg};
    }
    .cc-projects-picker-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px 20px;
      background: ${theme.bgSecondary};
      border-bottom: 1px solid ${theme.border};
    }
    .cc-projects-picker-label {
      font-size: 12px;
      font-weight: 600;
      color: ${theme.text};
      white-space: nowrap;
    }
    .cc-projects-path-input {
      flex: 1;
      background: ${theme.inputAreaBg};
      color: ${theme.text};
      border: 1px solid ${theme.border};
      border-radius: 6px;
      padding: 8px 12px;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 13px;
      outline: none;
      min-width: 0;
      cursor: pointer;
    }
    .cc-projects-path-input:focus {
      border-color: rgba(0,255,65,0.4);
    }
    .cc-projects-open-btn {
      min-width: 80px;
      min-height: 44px;
      padding: 8px 16px;
      background: ${theme.accent};
      color: ${theme.bg};
      border: none;
      border-radius: 6px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
      white-space: nowrap;
      -webkit-tap-highlight-color: transparent;
    }
    .cc-projects-open-btn:active { opacity: 0.8; }
    .cc-projects-open-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .cc-projects-picker {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      max-height: 360px;
      overflow-y: auto;
      background: ${theme.bgSecondary};
      border: 1px solid ${theme.border};
      border-radius: 0 0 8px 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      z-index: 100;
      display: none;
    }
    .cc-projects-picker.open { display: block; }
    .cc-projects-picker-breadcrumb {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 6px 10px;
      font-size: 11px;
      color: ${theme.textMuted};
      border-bottom: 1px solid ${theme.border};
      flex-wrap: wrap;
    }
    .cc-projects-picker-crumb {
      background: none;
      border: none;
      color: ${theme.accent};
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      padding: 1px 3px;
      border-radius: 3px;
    }
    .cc-projects-picker-crumb:hover { background: rgba(0,255,65,0.08); }
    .cc-projects-picker-crumb-sep { color: ${theme.textMuted}; font-size: 11px; }
    .cc-projects-picker-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      cursor: pointer;
      color: ${theme.text};
      font-size: 13px;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      font-family: inherit;
    }
    .cc-projects-picker-item:hover { background: rgba(255,255,255,0.04); }
    .cc-projects-picker-item.dir { color: ${theme.accent}; font-weight: 600; }
    .cc-projects-picker-icon { width: 18px; text-align: center; font-size: 14px; flex-shrink: 0; }
    .cc-projects-active-bar {
      padding: 10px 20px;
      font-size: 12px;
      color: ${theme.textMuted};
      background: ${theme.bg};
      border-bottom: 1px solid ${theme.border};
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cc-projects-active-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: ${theme.accent};
      flex-shrink: 0;
    }
    .cc-projects-active-path {
      color: ${theme.text};
      font-weight: 600;
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 12px;
    }
    .cc-projects-recent {
      padding: 16px 20px;
      flex: 1;
      overflow-y: auto;
    }
    .cc-projects-recent-title {
      font-size: 11px;
      font-weight: 600;
      color: ${theme.textMuted};
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 8px;
    }
    .cc-projects-recent-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      color: ${theme.text};
      font-size: 13px;
      background: none;
      border: 1px solid ${theme.border};
      border-radius: 6px;
      width: 100%;
      text-align: left;
      font-family: inherit;
      margin-bottom: 6px;
      transition: border-color 0.15s;
    }
    .cc-projects-recent-item:hover {
      border-color: ${theme.accent};
      color: ${theme.accent};
    }
    @media (max-width: 640px) {
      .cc-projects-picker-bar { padding: 12px; }
      .cc-projects-open-btn { min-width: 64px; padding: 8px 12px; }
    }
  `;
  document.head.appendChild(style);
}

async function fetchDir(dir: string): Promise<DirEntry[]> {
  try {
    const resp = await fetch(`/api/v1/files/tree?path=${encodeURIComponent(dir)}&depth=1`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const entries: DirEntry[] = data.tree || data.children || data || [];
    return entries
      .filter((e: any) => e.type === 'directory' || e.type === 'dir')
      .map((e: any) => ({ name: e.name, path: e.path || `${dir}/${e.name}`, type: 'directory' as const }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

let _pickerDir = PROJECTS_ROOT;
let _wrapEl: HTMLElement | null = null;

async function renderPicker(dir: string): Promise<void> {
  if (!_pickerEl) return;
  _pickerDir = dir;
  _pickerEl.innerHTML = '';

  // Breadcrumb
  const bc = document.createElement('div');
  bc.className = 'cc-projects-picker-breadcrumb';
  const parts = dir.split('/').filter(Boolean);
  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    acc += '/' + parts[i];
    const path = acc;
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'cc-projects-picker-crumb-sep';
      sep.textContent = '/';
      bc.appendChild(sep);
    }
    const crumb = document.createElement('button');
    crumb.className = 'cc-projects-picker-crumb';
    crumb.textContent = parts[i];
    crumb.addEventListener('click', (e) => { e.stopPropagation(); renderPicker(path); });
    bc.appendChild(crumb);
  }
  _pickerEl.appendChild(bc);

  // Directory entries
  const entries = await fetchDir(dir);
  for (const entry of entries) {
    const item = document.createElement('button');
    item.className = 'cc-projects-picker-item dir';

    const icon = document.createElement('span');
    icon.className = 'cc-projects-picker-icon';
    icon.textContent = '📂';

    const label = document.createElement('span');
    label.textContent = entry.name;

    item.appendChild(icon);
    item.appendChild(label);

    // Click navigates into the directory
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_pathInputEl) _pathInputEl.value = entry.path;
      renderPicker(entry.path);
    });

    _pickerEl.appendChild(item);
  }

  // "Open this directory" button at bottom
  const openBtn = document.createElement('button');
  openBtn.style.cssText = `
    width: 100%; padding: 8px 16px; background: none; border: none;
    border-top: 1px solid ${theme.border};
    color: ${theme.accent}; font-family: inherit; font-size: 13px;
    font-weight: 600; cursor: pointer; text-align: left;
  `;
  openBtn.textContent = `📂 Open "${dir}"`;
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectProject(dir);
  });
  _pickerEl.appendChild(openBtn);
}

function selectProject(projectPath: string): void {
  _activeProject = projectPath;
  updateActiveBar();
  if (_pickerEl) _pickerEl.classList.remove('open');
  onSelect(projectPath);
}

function updateActiveBar(): void {
  if (!_activeProjectEl) return;
  if (_activeProject) {
    _activeProjectEl.style.display = 'flex';
    const pathEl = _activeProjectEl.querySelector('.cc-projects-active-path');
    if (pathEl) pathEl.textContent = _activeProject;
  } else {
    _activeProjectEl.style.display = 'none';
  }
}

export function createProjects(
  container: HTMLElement,
  onProjectSelect: OnProjectSelect,
): void {
  injectProjectStyles();
  onSelect = onProjectSelect;

  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'cc-projects-wrap';
  _wrapEl = wrap;

  // Picker bar
  const pickerBar = document.createElement('div');
  pickerBar.className = 'cc-projects-picker-bar';
  pickerBar.style.position = 'relative';

  const label = document.createElement('span');
  label.className = 'cc-projects-picker-label';
  label.textContent = '📁';

  const pathInput = document.createElement('input');
  pathInput.className = 'cc-projects-path-input';
  pathInput.type = 'text';
  pathInput.value = PROJECTS_ROOT;
  pathInput.placeholder = '/data/your-project';
  _pathInputEl = pathInput;

  const openBtn = document.createElement('button');
  openBtn.className = 'cc-projects-open-btn';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', () => {
    const path = pathInput.value.trim() || PROJECTS_ROOT;
    selectProject(path);
  });
  _openBtnEl = openBtn;

  // Picker dropdown
  const picker = document.createElement('div');
  picker.className = 'cc-projects-picker';
  _pickerEl = picker;

  // Toggle picker on input click
  pathInput.addEventListener('click', () => {
    if (picker.classList.contains('open')) {
      picker.classList.remove('open');
    } else {
      const startDir = pathInput.value.trim() || PROJECTS_ROOT;
      renderPicker(startDir);
      picker.classList.add('open');
    }
  });

  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      picker.classList.remove('open');
      const path = pathInput.value.trim() || PROJECTS_ROOT;
      selectProject(path);
    }
  });

  // Close picker when clicking outside
  document.addEventListener('click', (e) => {
    if (!pickerBar.contains(e.target as Node)) {
      picker.classList.remove('open');
    }
  });

  pickerBar.appendChild(label);
  pickerBar.appendChild(pathInput);
  pickerBar.appendChild(openBtn);
  pickerBar.appendChild(picker);

  // Active project bar
  const activeBar = document.createElement('div');
  activeBar.className = 'cc-projects-active-bar';
  activeBar.style.display = 'none';
  activeBar.innerHTML = `
    <span class="cc-projects-active-dot"></span>
    Active: <span class="cc-projects-active-path"></span>
  `;
  _activeProjectEl = activeBar;

  // Recent / quick-access section
  const recentSection = document.createElement('div');
  recentSection.className = 'cc-projects-recent';

  const recentTitle = document.createElement('div');
  recentTitle.className = 'cc-projects-recent-title';
  recentTitle.textContent = 'Quick Access';

  recentSection.appendChild(recentTitle);

  // Common project directories
  const quickDirs = [getWorkspaceRoot(), '/tmp', '/home'];
  for (const dir of quickDirs) {
    const item = document.createElement('button');
    item.className = 'cc-projects-recent-item';
    item.innerHTML = `📂 ${dir}`;
    item.addEventListener('click', () => {
      if (_pathInputEl) _pathInputEl.value = dir;
      selectProject(dir);
    });
    recentSection.appendChild(item);
  }

  wrap.appendChild(pickerBar);
  wrap.appendChild(activeBar);
  wrap.appendChild(recentSection);
  container.appendChild(wrap);

  _activeProject = '';
  updateActiveBar();
}
