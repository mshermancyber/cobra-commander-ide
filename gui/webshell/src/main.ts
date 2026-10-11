// ---------------------------------------------------------------------------
// Web Shell SPA — Main entry point
// ---------------------------------------------------------------------------

import { injectTheme } from './theme.js';
import {
  createLayout,
  toggleTerminal,
  isTerminalOpen,
  switchTab,
} from './layout.js';
import { createTerminal } from './terminal.js';
import { createChat } from './chat.js';
import { createEditor, setEditorWorkDir } from './editor.js';
import { createProjects } from './projects.js';
import { createPreview, previewFile, connectPreviewChat } from './preview.js';
import { createNotes } from './notes.js';
import { createSecurityPanel, setSecurityWorkDir } from './security.js';
import { createWorkersPanel } from './workers.js';
import { createIntakePanel } from './intake.js';
import { createDestroPanel } from './destro.js';
import { initWorkspaceRoot, setWorkspaceRoot } from './workspace-root.js';

function getWebSocketBase(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

function main(): void {
  injectTheme();

  const {
    terminalPane,
    chatPane,
    editorPane,
    projectsPane,
    previewPane,
    notesPane,
    securityPane,
    workersPane,
    intakePane,
    destroPane,
  } = createLayout();

  const loadingEl = document.getElementById('loading');
  if (loadingEl) loadingEl.style.display = 'none';

  const wsBase = getWebSocketBase();
  const term = createTerminal(terminalPane, wsBase);

  term.writeln('');
  term.write('$ ');

  const chat = createChat(chatPane, wsBase, () => {
    toggleTerminal();
    return isTerminalOpen();
  });

  chat.onToolActivity((line: string) => {
    term.writeln(line);
  });

  chat.onFileClick((path: string) => {
    previewFile(path);
    switchTab('preview');
  });

  createEditor(editorPane);
  createPreview(previewPane);
  connectPreviewChat(chat);

  createNotes(notesPane);

  // Projects — compact folder picker, opens chat on selection
  createProjects(projectsPane, (projectPath: string) => {
    setEditorWorkDir(projectPath);
    setSecurityWorkDir(projectPath);
    chat.setWorkDir(projectPath);
    chat.startNewChat();
    switchTab('chat');
  });

  // Security dashboard
  createSecurityPanel(securityPane);

  // Workers status panel
  createWorkersPanel(workersPane);

  // Intake agent panel
  createIntakePanel(intakePane);

  // Support agent panel
  createDestroPanel(destroPane);

  // The server owns the workspace root — adopt it once it answers.
  void initWorkspaceRoot().then((root) => {
    setWorkspaceRoot(root);
    setEditorWorkDir(root);
    setSecurityWorkDir(root);
    chat.setWorkDir(root);
  });
}

main();
