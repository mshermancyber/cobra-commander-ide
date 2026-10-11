import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getLanguageId } from './language-map.js';

interface LSPPosition {
  line: number;
  character: number;
}

interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

interface LSPLocation {
  uri: string;
  range: LSPRange;
}

interface LSPSymbolInformation {
  name: string;
  kind: number;
  location: LSPLocation;
  containerName?: string;
}

interface LSPDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: LSPDocumentSymbol[];
}

interface LSPHoverResult {
  contents: unknown;
  range?: LSPRange;
}

interface LSPDiagnostic {
  range: LSPRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

const SYMBOL_KINDS: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
  6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
  11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String',
  16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key',
  21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator',
  26: 'TypeParameter',
};

const SEVERITY_MAP: Record<number, string> = {
  1: 'error', 2: 'warning', 3: 'info', 4: 'hint',
};

export class LSPClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private buffer = '';
  private pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private openDocuments = new Map<string, { version: number; languageId: string }>();
  private diagnostics = new Map<string, LSPDiagnostic[]>();
  private initialized = false;
  private rootUri: string;

  constructor(
    private command: string,
    private args: string[],
    private rootDir: string,
  ) {
    this.rootUri = pathToFileURL(rootDir).href;
  }

  async start(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.rootDir,
    });

    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.stderr!.resume();

    this.process.on('exit', () => {
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('LSP server exited'));
      }
      this.pendingRequests.clear();
      this.initialized = false;
    });

    const initResult = await this.sendRequest('initialize', {
      processId: process.pid,
      rootUri: this.rootUri,
      workspaceFolders: [{ name: 'workspace', uri: this.rootUri }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { contentFormat: ['plaintext', 'markdown'] },
          documentSymbol: { dynamicRegistration: false },
          publishDiagnostics: { versionSupport: false },
        },
      },
    }) as Record<string, unknown>;

    this.sendNotification('initialized', {});
    this.initialized = true;

    return;
  }

  stop(): void {
    if (this.process) {
      this.sendNotification('shutdown', null);
      this.sendNotification('exit', null);
      setTimeout(() => this.process?.kill(), 2000);
    }
  }

  isReady(): boolean {
    return this.initialized && this.process !== null && !this.process.killed;
  }

  async openFile(filePath: string): Promise<void> {
    const uri = pathToFileURL(resolve(this.rootDir, filePath)).href;
    if (this.openDocuments.has(uri)) return;

    const absPath = resolve(this.rootDir, filePath);
    if (!existsSync(absPath)) return;

    const text = readFileSync(absPath, 'utf-8');
    const languageId = getLanguageId(filePath) || 'plaintext';

    this.openDocuments.set(uri, { version: 1, languageId });
    this.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  async definition(filePath: string, line: number, character: number): Promise<LSPLocation[]> {
    await this.openFile(filePath);
    const uri = pathToFileURL(resolve(this.rootDir, filePath)).href;

    const result = await this.sendRequest('textDocument/definition', {
      textDocument: { uri },
      position: { line: line - 1, character: character - 1 },
    });

    return normalizeLocations(result);
  }

  async references(filePath: string, line: number, character: number): Promise<LSPLocation[]> {
    await this.openFile(filePath);
    const uri = pathToFileURL(resolve(this.rootDir, filePath)).href;

    const result = await this.sendRequest('textDocument/references', {
      textDocument: { uri },
      position: { line: line - 1, character: character - 1 },
      context: { includeDeclaration: true },
    });

    return normalizeLocations(result);
  }

  async hover(filePath: string, line: number, character: number): Promise<string | null> {
    await this.openFile(filePath);
    const uri = pathToFileURL(resolve(this.rootDir, filePath)).href;

    const result = await this.sendRequest('textDocument/hover', {
      textDocument: { uri },
      position: { line: line - 1, character: character - 1 },
    }) as LSPHoverResult | null;

    if (!result) return null;
    return extractHoverContent(result.contents);
  }

  async documentSymbols(filePath: string): Promise<string> {
    await this.openFile(filePath);
    const uri = pathToFileURL(resolve(this.rootDir, filePath)).href;

    const result = await this.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri },
    }) as (LSPDocumentSymbol | LSPSymbolInformation)[] | null;

    if (!result || !Array.isArray(result)) return 'No symbols found.';
    return formatSymbols(result);
  }

  async workspaceSymbol(query: string): Promise<string> {
    const result = await this.sendRequest('workspace/symbol', {
      query,
    }) as LSPSymbolInformation[] | null;

    if (!result || !Array.isArray(result)) return 'No symbols found.';
    return result.map(s => {
      const loc = fileURLToPath(s.location.uri);
      const line = s.location.range.start.line + 1;
      const kind = SYMBOL_KINDS[s.kind] || 'Unknown';
      return `${kind} ${s.name} — ${loc}:${line}`;
    }).join('\n');
  }

  getDiagnostics(filePath?: string): string {
    if (filePath) {
      const uri = pathToFileURL(resolve(this.rootDir, filePath)).href;
      const diags = this.diagnostics.get(uri) || [];
      return formatDiagnostics(diags, uri);
    }
    const lines: string[] = [];
    for (const [uri, diags] of this.diagnostics) {
      if (diags.length > 0) {
        lines.push(formatDiagnostics(diags, uri));
      }
    }
    return lines.join('\n') || 'No diagnostics.';
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pendingRequests.set(id, { resolve, reject });

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.writeMessage(msg);

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request '${method}' timed out`));
        }
      }, 30000);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.writeMessage(msg);
  }

  private writeMessage(json: string): void {
    const content = Buffer.from(json, 'utf-8');
    const header = `Content-Length: ${content.length}\r\n\r\n`;
    this.process?.stdin?.write(header);
    this.process?.stdin?.write(content);
  }

  private processBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;

      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body);
        this.handleMessage(msg);
      } catch { /* ignore malformed */ }
    }
  }

  private handleMessage(msg: { id?: number; method?: string; result?: unknown; error?: unknown; params?: unknown }): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method === 'textDocument/publishDiagnostics') {
      const params = msg.params as { uri: string; diagnostics: LSPDiagnostic[] };
      this.diagnostics.set(params.uri, params.diagnostics);
      return;
    }

    if (msg.method === 'window/workDoneProgress/create') return;
    if (msg.method === 'workspace/configuration') {
      // respond with empty config
    }
  }
}

function normalizeLocations(result: unknown): LSPLocation[] {
  if (!result) return [];
  if (Array.isArray(result)) return result as LSPLocation[];
  if (typeof result === 'object' && 'uri' in (result as Record<string, unknown>)) {
    return [result as LSPLocation];
  }
  return [];
}

function extractHoverContent(contents: unknown): string {
  if (typeof contents === 'string') return contents;
  if (typeof contents === 'object' && contents !== null) {
    if ('value' in contents) return (contents as { value: string }).value;
    if ('kind' in contents && 'value' in contents) return (contents as { value: string }).value;
    if (Array.isArray(contents)) {
      return contents.map(c => typeof c === 'string' ? c : c.value || '').join('\n');
    }
  }
  return String(contents);
}

function formatSymbols(symbols: (LSPDocumentSymbol | LSPSymbolInformation)[], indent = 0): string {
  return symbols.map(s => {
    const prefix = '  '.repeat(indent);
    const kind = SYMBOL_KINDS[s.kind] || 'Unknown';
    const line = 'selectionRange' in s ? s.selectionRange.start.line + 1 : ('location' in s ? s.location.range.start.line + 1 : 0);
    let result = `${prefix}${kind} ${s.name}:${line}`;
    if ('children' in s && s.children?.length) {
      result += '\n' + formatSymbols(s.children, indent + 1);
    }
    return result;
  }).join('\n');
}

function formatDiagnostics(diags: LSPDiagnostic[], uri: string): string {
  const filePath = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
  return diags.map(d => {
    const severity = SEVERITY_MAP[d.severity || 1] || 'unknown';
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    return `${filePath}:${line}:${col} [${severity}] ${d.message}`;
  }).join('\n');
}

// Singleton management for language servers
const clients = new Map<string, LSPClient>();

export async function getOrCreateClient(rootDir: string, languageId: string): Promise<LSPClient | null> {
  const key = `${rootDir}:${languageId}`;
  if (clients.has(key)) {
    const client = clients.get(key)!;
    if (client.isReady()) return client;
    clients.delete(key);
  }

  const serverConfig = findServer(languageId);
  if (!serverConfig) return null;

  const client = new LSPClient(serverConfig.command, serverConfig.args, rootDir);
  try {
    await client.start();
    clients.set(key, client);
    return client;
  } catch {
    return null;
  }
}

export function shutdownAllClients(): void {
  for (const [, client] of clients) {
    client.stop();
  }
  clients.clear();
}

interface ServerConfig {
  command: string;
  args: string[];
}

function findServer(languageId: string): ServerConfig | null {
  switch (languageId) {
    case 'typescript':
    case 'typescriptreact':
    case 'javascript':
    case 'javascriptreact': {
      const tsserver = findBinary('typescript-language-server');
      if (tsserver) return { command: tsserver, args: ['--stdio'] };
      return null;
    }
    case 'python': {
      const pylsp = findBinary('pylsp') || findBinary('pyls');
      if (pylsp) return { command: pylsp, args: [] };
      const pyright = findBinary('pyright-langserver');
      if (pyright) return { command: pyright, args: ['--stdio'] };
      return null;
    }
    case 'go': {
      const gopls = findBinary('gopls');
      if (gopls) return { command: gopls, args: ['serve'] };
      return null;
    }
    case 'rust': {
      const rls = findBinary('rust-analyzer');
      if (rls) return { command: rls, args: [] };
      return null;
    }
    default:
      return null;
  }
}

function findBinary(name: string): string | null {
  try {
    const result = execFileSync('which', [name], { encoding: 'utf-8' }).trim();
    return result || null;
  } catch {
    return null;
  }
}
