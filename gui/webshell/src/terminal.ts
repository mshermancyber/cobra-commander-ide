// ---------------------------------------------------------------------------
// xterm.js Terminal with WebSocket PTY bridge
// Mobile-polished: min 12px font, SF Mono, auto-resize on keyboard
// ---------------------------------------------------------------------------

import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { WSConnection } from './connection.js';
import { KeyboardToolbar } from './virtual-keyboard.js';
import theme from './theme.js';

import 'xterm/css/xterm.css';

const MIN_FONT_SIZE = 12;

function computeFontSize(): number {
  const base = 14;
  // On small screens (< 400px viewport width), reduce slightly
  if (window.innerWidth < 400) return Math.max(MIN_FONT_SIZE, 12);
  return base;
}

export function createTerminal(container: HTMLElement, wsBase: string): Terminal {
  const fontSize = computeFontSize();

  const term = new Terminal({
    theme: {
      background: theme.bg,
      foreground: theme.text,
      cursor: theme.accent,
      cursorAccent: theme.bg,
      selectionBackground: '#264f78',
      black: '#484f58',
      red: theme.accentRed,
      green: theme.accentGreen,
      yellow: theme.accentYellow,
      blue: theme.accent,
      magenta: theme.accentPurple,
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ff7b72',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc',
    },
    fontFamily: '"SF Mono", "Menlo", "Consolas", "ui-monospace", "SFMono-Regular", monospace',
    fontSize,
    lineHeight: 1.3,
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 10_000,
    tabStopWidth: 2,
  });

  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();

  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  term.open(container);

  // Fit to container
  setTimeout(() => fitAddon.fit(), 50);

  // Auto-fit on container resize
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
  });
  resizeObserver.observe(container);

  // Auto-fit when soft keyboard changes viewport
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      setTimeout(() => fitAddon.fit(), 100);
    });
  }

  // ── Virtual keyboard toolbar ──
  const kbToolbar = new KeyboardToolbar({
    onKey: (key: string) => {
      // Send special keys via terminal input
      const dataMap: Record<string, string> = {
        'Control': '\x1b[1;5~',  // Ctrl + nothing special; just send escape
        'Alt': '\x1b\x1b',       // Alt is often escape in terminals
        'Escape': '\x1b',
        'Tab': '\t',
        'ArrowUp': '\x1b[A',
        'ArrowDown': '\x1b[B',
        '|': '|',
        '~': '~',
      };
      const data = dataMap[key] || key;
      if (conn.isConnected) {
        conn.send({ type: 'input', data });
      } else {
        term.write(data);
      }
    },
  });

  // Cleanup toolbar on terminal disposal
  const originalDispose = term.dispose.bind(term);
  term.dispose = () => {
    kbToolbar.destroy();
    resizeObserver.disconnect();
    originalDispose();
  };

  // ── WebSocket connection ──
  const wsUrl = `${wsBase.replace(/\/+$/, '')}/ws/terminal`;
  const conn = new WSConnection(wsUrl);

  conn.on('connected', () => {
    term.writeln('\x1b[2m● Terminal connected\x1b[0m');
  });

  conn.on('message', (msg: any) => {
    if (msg.type === 'output' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (msg.type === 'exit') {
      const code = msg.code ?? -1;
      term.writeln(`\r\n\x1b[33m● Process exited with code ${code}\x1b[0m`);
    } else if (msg.type === 'connected') {
      const sid = msg.sessionId || '';
      term.writeln(`\x1b[2m● Session: ${sid.slice(0, 8)}...\x1b[0m`);
    }
  });

  conn.on('disconnected', () => {
    term.writeln('\r\n\x1b[31m● Connection lost. Reconnecting...\x1b[0m');
  });

  // Send input
  term.onData((data) => {
    conn.send({ type: 'input', data });
  });

  // Send resize
  term.onResize(({ cols, rows }) => {
    conn.send({ type: 'resize', cols, rows });
  });

  conn.connect();

  return term;
}
