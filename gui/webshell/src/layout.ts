// ---------------------------------------------------------------------------
// Layout — sidebar + tabbed main area (Chat | Editor) + terminal drawer
// ---------------------------------------------------------------------------

import theme from './theme.js';

export interface LayoutElements {
  app: HTMLElement;
  terminalPane: HTMLElement;
  chatPane: HTMLElement;
  editorPane: HTMLElement;
  projectsPane: HTMLElement;
  previewPane: HTMLElement;
  notesPane: HTMLElement;
  securityPane: HTMLElement;
  workersPane: HTMLElement;
  intakePane: HTMLElement;
  destroPane: HTMLElement;
  headerEl: HTMLElement;
}

let _terminalOpen = false;
let _drawerEl: HTMLElement | null = null;
let _drawerBodyEl: HTMLElement | null = null;
let _sidebarEl: HTMLElement | null = null;
let _overlayEl: HTMLElement | null = null;
let _bottomNavEl: HTMLElement | null = null;
let _activeTab: 'chat' | 'editor' | 'projects' | 'preview' | 'notes' | 'security' | 'workers' | 'intake' | 'destro' = 'chat';
let _chatPane: HTMLElement | null = null;
let _editorPane: HTMLElement | null = null;
let _projectsPane: HTMLElement | null = null;
let _previewPane: HTMLElement | null = null;
let _notesPane: HTMLElement | null = null;
let _securityPane: HTMLElement | null = null;
let _workersPane: HTMLElement | null = null;
let _intakePane: HTMLElement | null = null;
let _destroPane: HTMLElement | null = null;
let _sidebarNavItems = new Map<string, HTMLElement>();

export function toggleTerminal(): void {
  if (!_drawerEl || !_drawerBodyEl) return;
  _terminalOpen = !_terminalOpen;
  if (_terminalOpen) {
    _drawerEl.style.height = '50vh';
    _drawerBodyEl.style.display = 'block';
  } else {
    _drawerEl.style.height = '0';
    _drawerBodyEl.style.display = 'none';
  }
}

export function isTerminalOpen(): boolean {
  return _terminalOpen;
}

export function switchTab(
  tab: 'chat' | 'editor' | 'projects' | 'preview' | 'notes' | 'security' | 'workers' | 'intake' | 'destro',
): void {
  _activeTab = tab;
  const panes = [
    _chatPane,
    _editorPane,
    _projectsPane,
    _previewPane,
    _notesPane,
    _securityPane,
    _workersPane,
    _intakePane,
    _destroPane,
  ];
  const tabs: Array<
    'chat' | 'editor' | 'projects' | 'preview' | 'notes' | 'security' | 'workers' | 'intake' | 'destro'
  > = ['chat', 'editor', 'projects', 'preview', 'notes', 'security', 'workers', 'intake', 'destro'];

  for (let i = 0; i < tabs.length; i++) {
    if (panes[i]) panes[i]!.style.display = tabs[i] === tab ? 'block' : 'none';
  }
  for (const [key, el] of _sidebarNavItems) {
    if (key === tab) el.classList.add('active');
    else el.classList.remove('active');
  }

  // Update bottom nav active state
  if (_bottomNavEl) {
    _bottomNavEl.querySelectorAll('.cc-bottom-nav-item').forEach((item) => {
      const navTab = (item as HTMLElement).dataset.tab;
      if (navTab === tab) item.classList.add('active');
      else item.classList.remove('active');
    });
  }
}

export function getActiveTab(): string {
  return _activeTab;
}

function toggleSidebar(): void {
  if (!_sidebarEl || !_overlayEl) return;
  const open = _sidebarEl.classList.toggle('open');
  _overlayEl.style.display = open ? 'block' : 'none';
}

export function createLayout(): LayoutElements {
  const app = document.getElementById('app')!;
  app.innerHTML = '';

  const style = document.createElement('style');
  style.id = 'cc-layout-styles';
  style.textContent = `
    .cc-layout {
      display: grid;
      grid-template-columns: 220px 1fr;
      grid-template-rows: 1fr;
      height: 100dvh;
      width: 100%;
      overflow: hidden;
      transition: grid-template-columns 0.2s ease;
    }
    .cc-layout.sidebar-collapsed {
      grid-template-columns: 48px 1fr;
    }
    .cc-sidebar {
      grid-column: 1;
      display: flex;
      flex-direction: column;
      background: ${theme.bgSecondary};
      border-right: 1px solid ${theme.border};
      overflow-y: auto;
      overflow-x: hidden;
      transition: width 0.2s ease;
    }
    .cc-layout.sidebar-collapsed .cc-sidebar-brand,
    .cc-layout.sidebar-collapsed .cc-sidebar-section,
    .cc-layout.sidebar-collapsed .cc-sidebar-info,
    .cc-layout.sidebar-collapsed .cc-sidebar-divider { display: none; }
    .cc-layout.sidebar-collapsed .cc-sidebar-item {
      padding: 10px 0;
      justify-content: center;
      gap: 0;
    }
    .cc-layout.sidebar-collapsed .cc-sidebar-item .label { display: none; }
    .cc-layout.sidebar-collapsed .cc-sidebar-item .icon { font-size: 16px; width: auto; }
    .cc-sidebar-collapse-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 8px 0;
      background: none;
      border: none;
      border-top: 1px solid ${theme.border};
      color: ${theme.textMuted};
      font-size: 14px;
      cursor: pointer;
      transition: color 0.15s;
    }
    .cc-sidebar-collapse-btn:hover { color: ${theme.accent}; }
    .cc-sidebar-brand {
      padding: 14px 14px 10px;
      font-size: 12px;
      font-weight: 700;
      color: ${theme.accent};
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-bottom: 1px solid ${theme.border};
    }
    .cc-sidebar-nav { padding: 6px 0; flex: 1; }
    .cc-sidebar-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 7px 14px;
      background: none;
      border: none;
      color: ${theme.text};
      font-family: inherit;
      font-size: 13px;
      cursor: pointer;
      text-align: left;
      transition: background 0.1s;
      -webkit-tap-highlight-color: transparent;
    }
    .cc-sidebar-item:hover { background: rgba(255,255,255,0.04); }
    .cc-sidebar-item:active { background: rgba(255,255,255,0.08); }
    .cc-sidebar-item .icon { width: 16px; text-align: center; color: ${theme.textMuted}; flex-shrink: 0; font-size: 13px; }
    .cc-sidebar-section {
      padding: 10px 14px 3px;
      font-size: 10px;
      font-weight: 600;
      color: ${theme.textMuted};
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .cc-sidebar-divider { height: 1px; background: ${theme.border}; margin: 4px 10px; }
    .cc-sidebar-info {
      padding: 5px 14px;
      font-size: 11px;
      color: ${theme.textMuted};
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .cc-sidebar-info-dot { width: 6px; height: 6px; border-radius: 50%; background: ${theme.accent}; flex-shrink: 0; }
    .cc-sidebar-footer { padding: 6px 0; border-top: 1px solid ${theme.border}; }

    .cc-sidebar-item.active {
      background: rgba(255,255,255,0.06);
      color: ${theme.accent};
    }
    .cc-sidebar-item.active .icon { color: ${theme.accent}; }

    /* ── Main area ── */
    .cc-main {
      grid-column: 2;
      display: grid;
      grid-template-rows: 1fr auto;
      overflow: hidden;
    }

    /* ── Content panes ── */
    .cc-content { grid-row: 1; overflow: hidden; }
    .cc-chat-pane, .cc-editor-pane, .cc-projects-pane, .cc-preview-pane,
    .cc-notes-pane, .cc-security-pane, .cc-workers-pane, .cc-intake-pane,
    .cc-destro-pane {
      height: 100%; overflow: hidden;
    }

    /* ── Terminal drawer ── */
    .cc-terminal-drawer {
      grid-row: 2;
      height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      transition: height 0.3s ease;
      border-top: 1px solid ${theme.border};
    }
    .cc-terminal-drawer-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 12px; height: 32px; min-height: 32px;
      background: ${theme.bgSecondary}; border-bottom: 1px solid ${theme.border};
      font-size: 11px; font-weight: 600; color: ${theme.textMuted};
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .cc-terminal-drawer-close {
      width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
      background: transparent; color: ${theme.textMuted}; border: none; border-radius: 4px;
      font-size: 14px; cursor: pointer; transition: color 0.15s;
    }
    .cc-terminal-drawer-close:active { color: ${theme.accent}; }
    .cc-terminal-drawer-body { flex: 1; overflow: hidden; display: none; background: ${theme.bg}; }

    /* ── Hamburger (mobile) ── */
    .cc-hamburger {
      display: none; position: fixed;
      top: max(6px, env(safe-area-inset-top, 6px));
      left: max(6px, env(safe-area-inset-left, 6px));
      z-index: 200; width: 34px; height: 34px;
      background: ${theme.bgSecondary}; border: 1px solid ${theme.border};
      border-radius: 6px; color: ${theme.textMuted}; font-size: 16px;
      cursor: pointer; align-items: center; justify-content: center;
    }
    .cc-sidebar-overlay {
      display: none; position: fixed; inset: 0; z-index: 149;
      background: rgba(0,0,0,0.5);
    }

    /* ── Bottom navigation (mobile) ── */
    .cc-bottom-nav {
      display: none;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 180;
      background: ${theme.bgSecondary};
      border-top: 1px solid ${theme.border};
      flex-direction: row;
      justify-content: space-around;
      align-items: center;
      padding-bottom: max(4px, env(safe-area-inset-bottom, 0px));
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      -webkit-user-select: none;
    }
    .cc-bottom-nav-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      min-width: 44px;
      min-height: 44px;
      padding: 4px 6px;
      background: none;
      border: none;
      color: ${theme.textMuted};
      font-family: inherit;
      font-size: 10px;
      cursor: pointer;
      transition: color 0.15s;
      -webkit-appearance: none;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .cc-bottom-nav-item .cc-bottom-nav-icon {
      font-size: 18px;
      line-height: 1;
    }
    .cc-bottom-nav-item .cc-bottom-nav-label {
      font-size: 10px;
      line-height: 1;
    }
    .cc-bottom-nav-item.active {
      color: ${theme.accent};
    }
    .cc-bottom-nav-item:active {
      color: ${theme.accent};
    }

    @media (max-width: 768px) {
      .cc-layout { grid-template-columns: 1fr; }
      .cc-sidebar {
        position: fixed; left: -230px; top: 0; bottom: 0;
        width: 220px; z-index: 150; transition: left 0.25s ease;
      }
      .cc-sidebar.open { left: 0; }
      .cc-main { grid-column: 1; }
      .cc-hamburger { display: flex; }
      .cc-bottom-nav { display: flex; }
      /* Push main content up to avoid bottom nav overlay */
      .cc-main {
        padding-bottom: 56px;
      }
    }
    @media (max-height: 500px) {
      .cc-terminal-drawer[style*="50vh"] { height: 35vh !important; }
    }
  `;
  document.head.appendChild(style);

  // ── Sidebar ──
  const sidebar = document.createElement('aside');
  sidebar.className = 'cc-sidebar';
  _sidebarEl = sidebar;

  const brand = document.createElement('div');
  brand.className = 'cc-sidebar-brand';
  brand.textContent = 'Cobra Commander';

  const nav = document.createElement('nav');
  nav.className = 'cc-sidebar-nav';

  function navItem(icon: string, label: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'cc-sidebar-item';
    btn.innerHTML = `<span class="icon">${icon}</span><span class="label">${label}</span>`;
    btn.addEventListener('click', () => {
      onClick();
      if (window.innerWidth <= 768) toggleSidebar();
    });
    return btn;
  }

  const chatNav = navItem('💬', 'Chat', () => switchTab('chat'));
  chatNav.classList.add('active');
  _sidebarNavItems.set('chat', chatNav);
  nav.appendChild(chatNav);

  const editorNav = navItem('📝', 'Editor', () => switchTab('editor'));
  _sidebarNavItems.set('editor', editorNav);
  nav.appendChild(editorNav);

  nav.appendChild(navItem('▸', 'Terminal', () => toggleTerminal()));

  const div1 = document.createElement('div');
  div1.className = 'cc-sidebar-divider';
  nav.appendChild(div1);

  const secLabel = document.createElement('div');
  secLabel.className = 'cc-sidebar-section';
  secLabel.textContent = 'Tools';
  nav.appendChild(secLabel);

  const intakeNav = navItem('📥', 'New Request', () => switchTab('intake'));
  _sidebarNavItems.set('intake', intakeNav);
  nav.appendChild(intakeNav);

  const destroNav = navItem('🔧', 'Destro', () => switchTab('destro'));
  _sidebarNavItems.set('destro', destroNav);
  nav.appendChild(destroNav);

  const securityNav = navItem('🛡', 'Security', () => switchTab('security'));
  _sidebarNavItems.set('security', securityNav);
  nav.appendChild(securityNav);

  const workersNav = navItem('⚙', 'Workers', () => switchTab('workers'));
  _sidebarNavItems.set('workers', workersNav);
  nav.appendChild(workersNav);

  const projectsNav = navItem('📁', 'Projects', () => switchTab('projects'));
  _sidebarNavItems.set('projects', projectsNav);
  nav.appendChild(projectsNav);

  const previewNav = navItem('👁', 'Preview', () => switchTab('preview'));
  _sidebarNavItems.set('preview', previewNav);
  nav.appendChild(previewNav);

  const notesNav = navItem('📋', 'Notes', () => switchTab('notes'));
  _sidebarNavItems.set('notes', notesNav);
  nav.appendChild(notesNav);

  const div2 = document.createElement('div');
  div2.className = 'cc-sidebar-divider';
  nav.appendChild(div2);

  const connLabel = document.createElement('div');
  connLabel.className = 'cc-sidebar-section';
  connLabel.textContent = 'Connection';
  nav.appendChild(connLabel);

  const modelInfo = document.createElement('div');
  modelInfo.className = 'cc-sidebar-info';
  modelInfo.innerHTML = `<span class="cc-sidebar-info-dot"></span>Head of Engineering`;
  nav.appendChild(modelInfo);

  const footer = document.createElement('div');
  footer.className = 'cc-sidebar-footer';
  footer.appendChild(navItem('⏻', 'Logout', async () => {
    try { await fetch('/auth/logout', { method: 'POST' }); } catch {}
    window.location.href = '/';
  }));

  // Collapse button
  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'cc-sidebar-collapse-btn';
  collapseBtn.innerHTML = '«';
  collapseBtn.title = 'Collapse sidebar';
  collapseBtn.addEventListener('click', () => {
    const layoutEl = document.querySelector('.cc-layout') as HTMLElement;
    if (!layoutEl) return;
    const collapsed = layoutEl.classList.toggle('sidebar-collapsed');
    collapseBtn.innerHTML = collapsed ? '»' : '«';
    collapseBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  });

  sidebar.appendChild(brand);
  sidebar.appendChild(nav);
  sidebar.appendChild(collapseBtn);
  sidebar.appendChild(footer);

  // ── Overlay + hamburger ──
  const overlay = document.createElement('div');
  overlay.className = 'cc-sidebar-overlay';
  overlay.addEventListener('click', toggleSidebar);
  _overlayEl = overlay;

  const hamburger = document.createElement('button');
  hamburger.className = 'cc-hamburger';
  hamburger.innerHTML = '☰';
  hamburger.addEventListener('click', toggleSidebar);

  // ── Bottom navigation (mobile) ──
  const bottomNav = document.createElement('nav');
  bottomNav.className = 'cc-bottom-nav';
  _bottomNavEl = bottomNav;

  function bottomNavItem(
    icon: string,
    label: string,
    tab: string,
    onClick: () => void,
  ): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'cc-bottom-nav-item';
    btn.dataset.tab = tab;
    btn.innerHTML = `<span class="cc-bottom-nav-icon">${icon}</span><span class="cc-bottom-nav-label">${label}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  bottomNav.appendChild(bottomNavItem('📥', 'Intake', 'intake', () => switchTab('intake')));
  bottomNav.appendChild(bottomNavItem('🔧', 'Destro', 'destro', () => switchTab('destro')));
  bottomNav.appendChild(bottomNavItem('💬', 'Chat', 'chat', () => switchTab('chat')));
  bottomNav.appendChild(bottomNavItem('📝', 'Editor', 'editor', () => switchTab('editor')));
  bottomNav.appendChild(bottomNavItem('▸', 'Term', 'terminal', toggleTerminal));
  bottomNav.appendChild(bottomNavItem('🛡', 'Sec', 'security', () => switchTab('security')));

  // Highlight initial active
  const chatBottom = bottomNav.querySelector('[data-tab="chat"]');
  if (chatBottom) chatBottom.classList.add('active');

  // ── Main content ──
  const main = document.createElement('div');
  main.className = 'cc-main';

  // Content container
  const content = document.createElement('div');
  content.className = 'cc-content';

  const chatPane = document.createElement('div');
  chatPane.className = 'cc-chat-pane';
  _chatPane = chatPane;

  const editorPane = document.createElement('div');
  editorPane.className = 'cc-editor-pane';
  editorPane.style.display = 'none';
  _editorPane = editorPane;

  const projectsPane = document.createElement('div');
  projectsPane.className = 'cc-projects-pane';
  projectsPane.style.display = 'none';
  _projectsPane = projectsPane;

  const previewPane = document.createElement('div');
  previewPane.className = 'cc-preview-pane';
  previewPane.style.display = 'none';
  _previewPane = previewPane;

  const notesPane = document.createElement('div');
  notesPane.className = 'cc-notes-pane';
  notesPane.style.display = 'none';
  _notesPane = notesPane;

  const securityPane = document.createElement('div');
  securityPane.className = 'cc-security-pane';
  securityPane.style.display = 'none';
  _securityPane = securityPane;

  const workersPane = document.createElement('div');
  workersPane.className = 'cc-workers-pane';
  workersPane.style.display = 'none';
  _workersPane = workersPane;

  const intakePane = document.createElement('div');
  intakePane.className = 'cc-intake-pane';
  intakePane.style.display = 'none';
  _intakePane = intakePane;

  const destroPane = document.createElement('div');
  destroPane.className = 'cc-destro-pane';
  destroPane.style.display = 'none';
  _destroPane = destroPane;

  content.appendChild(chatPane);
  content.appendChild(editorPane);
  content.appendChild(projectsPane);
  content.appendChild(previewPane);
  content.appendChild(notesPane);
  content.appendChild(securityPane);
  content.appendChild(workersPane);
  content.appendChild(intakePane);
  content.appendChild(destroPane);

  // Terminal drawer
  const drawerEl = document.createElement('div');
  drawerEl.className = 'cc-terminal-drawer';
  const drawerHeader = document.createElement('div');
  drawerHeader.className = 'cc-terminal-drawer-header';
  const drawerLabel = document.createElement('span');
  drawerLabel.textContent = 'Terminal';
  const drawerCloseBtn = document.createElement('button');
  drawerCloseBtn.className = 'cc-terminal-drawer-close';
  drawerCloseBtn.innerHTML = '&#x2715;';
  drawerCloseBtn.addEventListener('click', () => { if (_terminalOpen) toggleTerminal(); });
  drawerHeader.appendChild(drawerLabel);
  drawerHeader.appendChild(drawerCloseBtn);
  const drawerBody = document.createElement('div');
  drawerBody.className = 'cc-terminal-drawer-body';
  drawerEl.appendChild(drawerHeader);
  drawerEl.appendChild(drawerBody);
  _drawerEl = drawerEl;
  _drawerBodyEl = drawerBody;

  main.appendChild(content);
  main.appendChild(drawerEl);

  // ── Assemble ──
  const layout = document.createElement('div');
  layout.className = 'cc-layout';
  layout.appendChild(sidebar);
  layout.appendChild(main);

  app.appendChild(layout);
  app.appendChild(overlay);
  app.appendChild(hamburger);
  app.appendChild(bottomNav);

  return {
    app,
    terminalPane: drawerBody,
    chatPane,
    editorPane,
    projectsPane,
    previewPane,
    notesPane,
    securityPane,
    workersPane,
    intakePane,
    destroPane,
    headerEl: brand,
  };
}
