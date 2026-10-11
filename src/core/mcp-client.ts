import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import type { ToolDefinition } from './types.js';
import { validateUrl } from './url-validator.js';

interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface MCPServerState {
  config: MCPServerConfig;
  process: ChildProcess | null;
  ws: WebSocket | null;
  sseReader: ReadableStreamDefaultReader<Uint8Array> | null;
  ssePostUrl: string | null;
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
  connected: boolean;
  transport: 'stdio' | 'websocket' | 'sse';
  resourceSubscriptions: Map<string, (data: unknown) => void>;
}

interface JSONRPCRequest {
  jsonrpc: '2.0';
  method: string;
  id: number;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class MCPClient {
  private servers: Map<string, MCPServerState> = new Map();
  private nextId = 1;
  private pendingResponses: Map<number, { resolve: (value: JSONRPCResponse) => void; reject: (err: Error) => void }> = new Map();
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
    this.loadConfig();
  }

  private loadConfig(): void {
    const configPath = join(this.workDir, '.cobra-commander', 'mcp.json');
    if (!existsSync(configPath)) return;

    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      const servers: MCPServerConfig[] = raw.servers || [];
      for (const s of servers) {
        if (s.name && s.command) {
          this.servers.set(s.name, {
            config: s,
            process: null,
            ws: null,
            sseReader: null,
            ssePostUrl: null,
            tools: [],
            resources: [],
            prompts: [],
            connected: false,
            transport: 'stdio',
            resourceSubscriptions: new Map(),
          });
        }
      }
    } catch {
      // Invalid config, ignore
    }
  }

  async connect(serverName?: string): Promise<void> {
    if (serverName) {
      const server = this.servers.get(serverName);
      if (!server) throw new Error(`MCP server "${serverName}" not found in config`);
      if (server.connected) return;
      await this.connectServer(server);
    } else {
      // Connect all enabled servers
      for (const [, server] of this.servers) {
        if (server.config.enabled && !server.connected) {
          try {
            await this.connectServer(server);
          } catch (err) {
            // Continue connecting others even if one fails
            console.error(`  Failed to connect MCP server "${server.config.name}": ${(err as Error).message}`);
          }
        }
      }
    }
  }

  /**
   * Connect to an MCP server via WebSocket transport.
   */
  async connectWebSocket(url: string, serverName?: string): Promise<void> {
    const name = serverName || `ws-${url.replace(/[^a-zA-Z0-9]/g, '_')}`;

    // Create or update server state
    let server = this.servers.get(name);
    if (!server) {
      server = {
        config: { name, command: '', args: [], enabled: true },
        process: null,
        ws: null,
        sseReader: null,
        ssePostUrl: null,
        tools: [],
        resources: [],
        prompts: [],
        connected: false,
        transport: 'websocket',
        resourceSubscriptions: new Map(),
      };
      this.servers.set(name, server);
    }

    if (server.connected) return;

    const ws = new WebSocket(url);

    server.ws = ws;
    server.transport = 'websocket';

    ws.on('open', async () => {
      // Send initialize request
      try {
        const initResponse = await this.sendRequestWS(ws, {
          jsonrpc: '2.0',
          method: 'initialize',
          id: this.nextId++,
          params: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'cobra-commander', version: '0.1.0' },
          },
        });

        if (initResponse.error) {
          ws.close();
          throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
        }

        // Fetch tools
        await this.fetchToolsForServer(server, ws);

        // Fetch resources
        await this.fetchResourcesForServer(server, ws);

        // Fetch prompts
        await this.fetchPromptsForServer(server, ws);

        server.connected = true;
      } catch (err) {
        ws.close();
        throw err;
      }
    });

    ws.on('message', (data: Buffer) => {
      try {
        const response: JSONRPCResponse = JSON.parse(data.toString());
        const pending = this.pendingResponses.get(response.id);
        if (pending) {
          this.pendingResponses.delete(response.id);
          pending.resolve(response);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      server.connected = false;
      server.ws = null;
      // Reject any pending requests
      for (const [, pending] of this.pendingResponses) {
        pending.reject(new Error(`MCP server "${name}" WebSocket disconnected`));
      }
      this.pendingResponses.clear();

      // Auto-reconnect after 5 seconds
      setTimeout(() => {
        if (!server.connected) {
          this.connectWebSocket(url, name).catch(() => {
            // Silently fail reconnect
          });
        }
      }, 5000);
    });

    ws.on('error', (err) => {
      server.connected = false;
      server.ws = null;
      throw err;
    });
  }

  /**
   * Connect to an MCP server via SSE transport.
   */
  async connectSSE(url: string, serverName?: string): Promise<void> {
    const name = serverName || `sse-${url.replace(/[^a-zA-Z0-9]/g, '_')}`;

    let server = this.servers.get(name);
    if (!server) {
      server = {
        config: { name, command: '', args: [], enabled: true },
        process: null,
        ws: null,
        sseReader: null,
        ssePostUrl: null,
        tools: [],
        resources: [],
        prompts: [],
        connected: false,
        transport: 'sse',
        resourceSubscriptions: new Map(),
      };
      this.servers.set(name, server);
    }

    if (server.connected) return;

    // SSRF prevention: validate URL before fetch
    if (!validateUrl(url)) {
      throw new Error(`SSRF blocked: URL ${url} points to a private or unsafe network address`);
    }

    // Fetch the SSE stream
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    server.sseReader = reader;
    server.transport = 'sse';

    // Parse SSE events
    const decoder = new TextDecoder();
    let buffer = '';
    let lastEventId = '';

    const readLoop = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        let dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
          } else if (line.startsWith('id: ')) {
            lastEventId = line.slice(4).trim();
          } else if (line === '') {
            // Empty line = end of event
            if (dataLines.length > 0) {
              const data = dataLines.join('\n');
              dataLines = [];

              if (eventType === 'endpoint') {
                // SSE endpoint notification — contains POST URL for sending requests
                server!.ssePostUrl = data;
              } else if (eventType === 'message' || !eventType) {
                // JSON-RPC response
                try {
                  const response: JSONRPCResponse = JSON.parse(data);
                  const pending = this.pendingResponses.get(response.id);
                  if (pending) {
                    this.pendingResponses.delete(response.id);
                    pending.resolve(response);
                  }
                } catch {
                  // Ignore malformed messages
                }
              }
            }
            eventType = '';
          }
        }
      }
    };

    readLoop().catch(() => {
      server.connected = false;
      server.sseReader = null;
    });

    // Send initialize request via POST
    const initResponse = await this.sendRequestSSE(server, {
      jsonrpc: '2.0',
      method: 'initialize',
      id: this.nextId++,
      params: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'cobra-commander', version: '0.1.0' },
      },
    });

    if (initResponse.error) {
      reader.cancel();
      throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
    }

    // Fetch tools
    await this.fetchToolsForServer(server, null);

    // Fetch resources
    await this.fetchResourcesForServer(server, null);

    // Fetch prompts
    await this.fetchPromptsForServer(server, null);

    server.connected = true;
  }

  private async fetchToolsForServer(server: MCPServerState, ws: WebSocket | null): Promise<void> {
    const toolsResponse = await (ws
      ? this.sendRequestWS(ws, {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: this.nextId++,
        })
      : this.sendRequestSSE(server, {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: this.nextId++,
        }));

    if (toolsResponse.error) return;

    const result = toolsResponse.result as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> } | undefined;
    if (result?.tools) {
      server.tools = result.tools.map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || {},
        serverName: server.config.name,
      }));
    }
  }

  private async fetchResourcesForServer(server: MCPServerState, ws: WebSocket | null): Promise<void> {
    const resourcesResponse = await (ws
      ? this.sendRequestWS(ws, {
          jsonrpc: '2.0',
          method: 'resources/list',
          id: this.nextId++,
        })
      : this.sendRequestSSE(server, {
          jsonrpc: '2.0',
          method: 'resources/list',
          id: this.nextId++,
        }));

    if (resourcesResponse.error) return;

    const result = resourcesResponse.result as { resources?: MCPResource[] } | undefined;
    if (result?.resources) {
      server.resources = result.resources;
    }
  }

  private async fetchPromptsForServer(server: MCPServerState, ws: WebSocket | null): Promise<void> {
    const promptsResponse = await (ws
      ? this.sendRequestWS(ws, {
          jsonrpc: '2.0',
          method: 'prompts/list',
          id: this.nextId++,
        })
      : this.sendRequestSSE(server, {
          jsonrpc: '2.0',
          method: 'prompts/list',
          id: this.nextId++,
        }));

    if (promptsResponse.error) return;

    const result = promptsResponse.result as { prompts?: MCPPrompt[] } | undefined;
    if (result?.prompts) {
      server.prompts = result.prompts;
    }
  }

  private async connectServer(server: MCPServerState): Promise<void> {
    const { command, args } = server.config;

    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    server.process = proc;
    server.transport = 'stdio';

    // Handle stdout — read JSON-RPC responses
    const rl = createInterface({ input: proc.stdout! });
    let buffer = '';

    rl.on('line', (line: string) => {
      buffer += line;
      // Try to parse complete JSON objects
      try {
        const response: JSONRPCResponse = JSON.parse(buffer);
        buffer = '';
        const pending = this.pendingResponses.get(response.id);
        if (pending) {
          this.pendingResponses.delete(response.id);
          pending.resolve(response);
        }
      } catch {
        // Incomplete JSON, keep buffering
      }
    });

    // Handle stderr for debugging
    proc.stderr?.on('data', (_data: Buffer) => {
      // MCP servers may log to stderr, just ignore by default
    });

    // Handle process exit
    proc.on('exit', (code) => {
      server.connected = false;
      server.process = null;
      // Reject any pending requests
      for (const [, pending] of this.pendingResponses) {
        pending.reject(new Error(`MCP server "${server.config.name}" exited with code ${code}`));
      }
      this.pendingResponses.clear();
    });

    proc.on('error', (err) => {
      server.connected = false;
      server.process = null;
      throw err;
    });

    // Send initialize request
    const initResponse = await this.sendRequest(server, {
      jsonrpc: '2.0',
      method: 'initialize',
      id: this.nextId++,
      params: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'cobra-commander', version: '0.1.0' },
      },
    });

    if (initResponse.error) {
      proc.kill();
      throw new Error(`MCP initialize failed: ${initResponse.error.message}`);
    }

    // Send tools/list request
    const toolsResponse = await this.sendRequest(server, {
      jsonrpc: '2.0',
      method: 'tools/list',
      id: this.nextId++,
    });

    if (toolsResponse.error) {
      proc.kill();
      throw new Error(`MCP tools/list failed: ${toolsResponse.error.message}`);
    }

    // Parse tools
    const result = toolsResponse.result as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> } | undefined;
    if (result?.tools) {
      server.tools = result.tools.map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || {},
        serverName: server.config.name,
      }));
    }

    // Fetch resources
    try {
      const resourcesResponse = await this.sendRequest(server, {
        jsonrpc: '2.0',
        method: 'resources/list',
        id: this.nextId++,
      });
      if (!resourcesResponse.error) {
        const resResult = resourcesResponse.result as { resources?: MCPResource[] } | undefined;
        if (resResult?.resources) {
          server.resources = resResult.resources;
        }
      }
    } catch {
      // Resources are optional
    }

    // Fetch prompts
    try {
      const promptsResponse = await this.sendRequest(server, {
        jsonrpc: '2.0',
        method: 'prompts/list',
        id: this.nextId++,
      });
      if (!promptsResponse.error) {
        const promResult = promptsResponse.result as { prompts?: MCPPrompt[] } | undefined;
        if (promResult?.prompts) {
          server.prompts = promResult.prompts;
        }
      }
    } catch {
      // Prompts are optional
    }

    server.connected = true;
  }

  async disconnect(serverName?: string): Promise<void> {
    if (serverName) {
      const server = this.servers.get(serverName);
      if (server) {
        if (server.process) {
          server.process.kill();
        }
        if (server.ws) {
          server.ws.close();
        }
        if (server.sseReader) {
          await server.sseReader.cancel().catch(() => {});
        }
        server.connected = false;
        server.process = null;
        server.ws = null;
        server.sseReader = null;
        server.ssePostUrl = null;
        server.tools = [];
        server.resources = [];
        server.prompts = [];
      }
    } else {
      for (const [, server] of this.servers) {
        if (server.process) {
          server.process.kill();
        }
        if (server.ws) {
          server.ws.close();
        }
        if (server.sseReader) {
          await server.sseReader.cancel().catch(() => {});
        }
        server.connected = false;
        server.process = null;
        server.ws = null;
        server.sseReader = null;
        server.ssePostUrl = null;
        server.tools = [];
        server.resources = [];
        server.prompts = [];
      }
    }
  }

  getAvailableTools(): MCPTool[] {
    const tools: MCPTool[] = [];
    for (const [, server] of this.servers) {
      if (server.connected) {
        tools.push(...server.tools);
      }
    }
    return tools;
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`MCP server "${serverName}" not found`);
    if (!server.connected) throw new Error(`MCP server "${serverName}" is not connected`);

    const response = await this.sendRequestByTransport(server, {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: this.nextId++,
      params: {
        name: toolName,
        arguments: args,
      },
    });

    if (response.error) {
      throw new Error(`MCP tool call failed: ${response.error.message}`);
    }

    const result = response.result as { content?: Array<{ type: string; text?: string }> } | undefined;
    if (result?.content) {
      return result.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!)
        .join('\n');
    }

    return '(no output)';
  }

  listServers(): { name: string; status: string; toolCount: number; resourceCount: number; promptCount: number }[] {
    const result: { name: string; status: string; toolCount: number; resourceCount: number; promptCount: number }[] = [];
    for (const [name, server] of this.servers) {
      result.push({
        name,
        status: server.connected ? 'connected' : (server.config.enabled ? 'enabled' : 'disabled'),
        toolCount: server.tools.length,
        resourceCount: server.resources.length,
        promptCount: server.prompts.length,
      });
    }
    return result;
  }

  // --- MCP Resources ---

  async listResources(): Promise<MCPResource[]> {
    const allResources: MCPResource[] = [];
    for (const [, server] of this.servers) {
      if (server.connected) {
        allResources.push(...server.resources);
      }
    }
    return allResources;
  }

  async readResource(uri: string): Promise<{ contents: string; mimeType?: string }> {
    // Find which server has this resource
    for (const [, server] of this.servers) {
      if (server.connected && server.resources.some(r => r.uri === uri)) {
        const response = await this.sendRequestByTransport(server, {
          jsonrpc: '2.0',
          method: 'resources/read',
          id: this.nextId++,
          params: { uri },
        });

        if (response.error) {
          throw new Error(`MCP resources/read failed: ${response.error.message}`);
        }

        const result = response.result as { contents?: Array<{ text?: string; blob?: string; mimeType?: string }> } | undefined;
        if (result?.contents && result.contents.length > 0) {
          const content = result.contents[0];
          return {
            contents: content.text || content.blob || '',
            mimeType: content.mimeType,
          };
        }

        throw new Error('Resource returned no contents');
      }
    }
    throw new Error(`Resource "${uri}" not found on any connected server`);
  }

  subscribeResource(uri: string, callback: (data: unknown) => void): void {
    for (const [, server] of this.servers) {
      if (server.connected && server.resources.some(r => r.uri === uri)) {
        server.resourceSubscriptions.set(uri, callback);

        // Send subscribe request (fire-and-forget)
        this.sendRequestByTransport(server, {
          jsonrpc: '2.0',
          method: 'resources/subscribe',
          id: this.nextId++,
          params: { uri },
        }).catch(() => {
          // Ignore subscribe errors
        });

        return;
      }
    }
    throw new Error(`Resource "${uri}" not found on any connected server`);
  }

  // --- MCP Prompts ---

  async listPrompts(): Promise<MCPPrompt[]> {
    const allPrompts: MCPPrompt[] = [];
    for (const [, server] of this.servers) {
      if (server.connected) {
        allPrompts.push(...server.prompts);
      }
    }
    return allPrompts;
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<{ messages: Array<{ role: string; content: string }> }> {
    for (const [, server] of this.servers) {
      if (server.connected && server.prompts.some(p => p.name === name)) {
        const params: Record<string, unknown> = { name };
        if (args) {
          params.arguments = args;
        }

        const response = await this.sendRequestByTransport(server, {
          jsonrpc: '2.0',
          method: 'prompts/get',
          id: this.nextId++,
          params,
        });

        if (response.error) {
          throw new Error(`MCP prompts/get failed: ${response.error.message}`);
        }

        const result = response.result as { messages?: Array<{ role: string; content: string }> } | undefined;
        if (result?.messages) {
          return { messages: result.messages };
        }

        throw new Error('Prompt returned no messages');
      }
    }
    throw new Error(`Prompt "${name}" not found on any connected server`);
  }

  // --- Server Discovery ---

  // ============================================================================
  // IMP-002: Visual server management & UI data
  // ============================================================================

  /**
   * Generate UI-friendly server management data.
   * Includes server metadata, health status, tool/resource/prompt counts,
   * and connection info suitable for rendering in a management dashboard.
   */
  getServerManagementData(): Array<{
    name: string;
    displayName: string;
    status: 'connected' | 'disconnected' | 'error' | 'connecting';
    transport: 'stdio' | 'websocket' | 'sse';
    toolCount: number;
    resourceCount: number;
    promptCount: number;
    capabilities: string[];
    uptime?: number;
    version?: string;
    icon?: string;
    toolCategories: Record<string, number>;
    tools: Array<{ name: string; description: string; schema: Record<string, unknown> }>;
    resources: Array<{ uri: string; name: string; description?: string }>;
    prompts: Array<{ name: string; description?: string }>;
  }> {
    const result: ReturnType<typeof this.getServerManagementData> = [];

    for (const [name, server] of this.servers) {
      // Categorize tools
      const categories: Record<string, number> = {};
      for (const tool of server.tools) {
        const category = this.categorizeTool(tool.name, tool.description);
        categories[category] = (categories[category] || 0) + 1;
      }

      result.push({
        name,
        displayName: server.config.name || name,
        status: server.connected ? 'connected'
          : (server.config.enabled ? 'disconnected' : 'error'),
        transport: server.transport,
        toolCount: server.tools.length,
        resourceCount: server.resources.length,
        promptCount: server.prompts.length,
        capabilities: this.inferCapabilities(server),
        toolCategories: categories,
        tools: server.tools.map(t => ({
          name: t.name,
          description: t.description,
          schema: t.inputSchema,
        })),
        resources: server.resources.map(r => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
        })),
        prompts: server.prompts.map(p => ({
          name: p.name,
          description: p.description,
        })),
      });
    }

    return result;
  }

  /**
   * Generate discovery-ready tool catalog suitable for rendering in a
   * tool marketplace or selection UI.
   */
  getToolCatalog(): Array<{
    serverName: string;
    toolName: string;
    description: string;
    category: string;
    schema: Record<string, unknown>;
  }> {
    const catalog: ReturnType<typeof this.getToolCatalog> = [];

    for (const [, server] of this.servers) {
      if (!server.connected) continue;
      for (const tool of server.tools) {
        catalog.push({
          serverName: server.config.name,
          toolName: tool.name,
          description: tool.description,
          category: this.categorizeTool(tool.name, tool.description),
          schema: tool.inputSchema,
        });
      }
    }

    return catalog;
  }

  /**
   * Generate a resource browser tree suitable for a tree-view UI.
   */
  getResourceTree(): Array<{
    server: string;
    uri: string;
    name: string;
    description?: string;
    children?: Array<{ uri: string; name: string }>;
  }> {
    const tree: ReturnType<typeof this.getResourceTree> = [];

    for (const [, server] of this.servers) {
      if (!server.connected) continue;
      for (const resource of server.resources) {
        tree.push({
          server: server.config.name,
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          children: [], // resources can have sub-resources
        });
      }
    }

    return tree;
  }

  /**
   * Get a summary dashboard for the management UI.
   */
  getDashboardSummary(): {
    totalServers: number;
    connectedServers: number;
    totalTools: number;
    totalResources: number;
    totalPrompts: number;
    serversByTransport: Record<string, number>;
    toolCategories: Record<string, number>;
    healthStatus: 'healthy' | 'degraded' | 'unhealthy';
  } {
    let totalServers = 0;
    let connectedServers = 0;
    let totalTools = 0;
    let totalResources = 0;
    let totalPrompts = 0;
    const serversByTransport: Record<string, number> = {};
    const toolCategories: Record<string, number> = {};

    for (const [, server] of this.servers) {
      totalServers++;
      if (server.connected) connectedServers++;

      const transport = server.transport || 'stdio';
      serversByTransport[transport] = (serversByTransport[transport] || 0) + 1;

      totalTools += server.tools.length;
      totalResources += server.resources.length;
      totalPrompts += server.prompts.length;

      for (const tool of server.tools) {
        const cat = this.categorizeTool(tool.name, tool.description);
        toolCategories[cat] = (toolCategories[cat] || 0) + 1;
      }
    }

    const healthStatus: 'healthy' | 'degraded' | 'unhealthy' =
      totalServers === 0 ? 'unhealthy'
        : connectedServers === totalServers ? 'healthy'
        : connectedServers > 0 ? 'degraded'
        : 'unhealthy';

    return {
      totalServers,
      connectedServers,
      totalTools,
      totalResources,
      totalPrompts,
      serversByTransport,
      toolCategories,
      healthStatus,
    };
  }

  /**
   * Categorize a tool based on its name and description.
   */
  private categorizeTool(name: string, description: string): string {
    const lower = (name + ' ' + description).toLowerCase();
    if (lower.includes('file') || lower.includes('read') || lower.includes('write') || lower.includes('edit')) return 'file-operations';
    if (lower.includes('search') || lower.includes('find') || lower.includes('grep')) return 'search';
    if (lower.includes('git') || lower.includes('commit') || lower.includes('branch')) return 'version-control';
    if (lower.includes('test') || lower.includes('run') || lower.includes('exec')) return 'execution';
    if (lower.includes('scan') || lower.includes('security') || lower.includes('audit')) return 'security';
    if (lower.includes('deploy') || lower.includes('build') || lower.includes('ci')) return 'devops';
    if (lower.includes('db') || lower.includes('sql') || lower.includes('database')) return 'database';
    if (lower.includes('api') || lower.includes('http') || lower.includes('fetch')) return 'api';
    if (lower.includes('config') || lower.includes('setting') || lower.includes('env')) return 'configuration';
    if (lower.includes('notify') || lower.includes('slack') || lower.includes('email')) return 'notification';
    return 'general';
  }

  /**
   * Infer capabilities from server state.
   */
  private inferCapabilities(server: MCPServerState): string[] {
    const caps: string[] = [];
    if (server.tools.length > 0) caps.push('tools');
    if (server.resources.length > 0) caps.push('resources');
    if (server.prompts.length > 0) caps.push('prompts');

    // Check specific capabilities from tools
    for (const tool of server.tools) {
      if (tool.name.includes('subscribe') || tool.name.includes('watch')) {
        if (!caps.includes('subscriptions')) caps.push('subscriptions');
      }
      if (tool.name.includes('log') || tool.name.includes('level')) {
        if (!caps.includes('logging')) caps.push('logging');
      }
    }

    if (server.resourceSubscriptions.size > 0) caps.push('resource-subscriptions');
    if (server.transport === 'websocket') caps.push('websocket');
    if (server.transport === 'sse') caps.push('sse-streaming');

    return caps;
  }

  /**
   * Generate a visual adjacency matrix for the server topology.
   * Shows inter-server relationships (which servers reference tools/resources from others).
   */
  getTopologyData(): {
    nodes: Array<{ id: string; label: string; status: string; toolCount: number }>;
    edges: Array<{ from: string; to: string; relation: string }>;
  } {
    const nodes: ReturnType<typeof this.getTopologyData>['nodes'] = [];
    const edges: ReturnType<typeof this.getTopologyData>['edges'] = [];

    for (const [name, server] of this.servers) {
      nodes.push({
        id: name,
        label: server.config.name,
        status: server.connected ? 'online' : 'offline',
        toolCount: server.tools.length,
      });
    }

    // Add edges for servers that depend on each other (discovery-based)
    // If a server's tools mention another server, create an edge
    for (const [name, server] of this.servers) {
      for (const tool of server.tools) {
        const desc = (tool.description || '').toLowerCase();
        for (const [otherName] of this.servers) {
          if (otherName !== name && desc.includes(otherName.toLowerCase())) {
            edges.push({ from: name, to: otherName, relation: 'references' });
          }
        }
      }
    }

    return { nodes, edges };
  }

  discoverServers(): Array<{ name: string; command: string; args: string[]; source: string }> {
    const found: Array<{ name: string; command: string; args: string[]; source: string }> = [];
    const seen = new Set<string>();

    // 1. .cobra-commander/mcp.json (current format)
    const cobraMcpPath = join(this.workDir, '.cobra-commander', 'mcp.json');
    if (existsSync(cobraMcpPath)) {
      try {
        const raw = JSON.parse(readFileSync(cobraMcpPath, 'utf-8'));
        const servers: MCPServerConfig[] = raw.servers || [];
        for (const s of servers) {
          if (s.name && s.command && !seen.has(s.name)) {
            seen.add(s.name);
            found.push({ name: s.name, command: s.command, args: s.args || [], source: '.cobra-commander/mcp.json' });
          }
        }
      } catch { /* ignore */ }
    }

    // 2. .cursor/mcp.json (Cursor format)
    const cursorPath = join(this.workDir, '.cursor', 'mcp.json');
    if (existsSync(cursorPath)) {
      try {
        const raw = JSON.parse(readFileSync(cursorPath, 'utf-8'));
        // Cursor format: { "mcpServers": { "name": { "command": "...", "args": [...] } } }
        const servers = raw.mcpServers || {};
        for (const [name, config] of Object.entries(servers)) {
          const cfg = config as { command?: string; args?: string[] };
          if (cfg.command && !seen.has(name)) {
            seen.add(name);
            found.push({ name, command: cfg.command, args: cfg.args || [], source: '.cursor/mcp.json' });
          }
        }
      } catch { /* ignore */ }
    }

    // 3. .vscode/mcp.json (VS Code format)
    const vscodePath = join(this.workDir, '.vscode', 'mcp.json');
    if (existsSync(vscodePath)) {
      try {
        const raw = JSON.parse(readFileSync(vscodePath, 'utf-8'));
        // VS Code format: { "servers": { "name": { "command": "...", "args": [...] } } }
        const servers = raw.servers || {};
        for (const [name, config] of Object.entries(servers)) {
          const cfg = config as { command?: string; args?: string[] };
          if (cfg.command && !seen.has(name)) {
            seen.add(name);
            found.push({ name, command: cfg.command, args: cfg.args || [], source: '.vscode/mcp.json' });
          }
        }
      } catch { /* ignore */ }
    }

    // 4. ~/.config/claude/claude_desktop_config.json (Claude Desktop format)
    const claudeConfigPath = join(homedir(), '.config', 'claude', 'claude_desktop_config.json');
    if (existsSync(claudeConfigPath)) {
      try {
        const raw = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
        // Claude Desktop format: { "mcpServers": { "name": { "command": "...", "args": [...] } } }
        const servers = raw.mcpServers || {};
        for (const [name, config] of Object.entries(servers)) {
          const cfg = config as { command?: string; args?: string[] };
          if (cfg.command && !seen.has(name)) {
            seen.add(name);
            found.push({ name, command: cfg.command, args: cfg.args || [], source: '~/.config/claude/claude_desktop_config.json' });
          }
        }
      } catch { /* ignore */ }
    }

    return found;
  }

  /**
   * Add a discovered server to the managed list.
   */
  addDiscoveredServer(name: string, command: string, args: string[], source: string): void {
    if (!this.servers.has(name)) {
      this.servers.set(name, {
        config: { name, command, args, enabled: true },
        process: null,
        ws: null,
        sseReader: null,
        ssePostUrl: null,
        tools: [],
        resources: [],
        prompts: [],
        connected: false,
        transport: 'stdio',
        resourceSubscriptions: new Map(),
      });
    }
  }

  // --- Internal request routing ---

  private sendRequestByTransport(server: MCPServerState, request: JSONRPCRequest): Promise<JSONRPCResponse> {
    if (server.transport === 'websocket' && server.ws) {
      return this.sendRequestWS(server.ws, request);
    }
    if (server.transport === 'sse') {
      return this.sendRequestSSE(server, request);
    }
    return this.sendRequest(server, request);
  }

  private sendRequest(server: MCPServerState, request: JSONRPCRequest): Promise<JSONRPCResponse> {
    return new Promise((resolve, reject) => {
      if (!server.process || !server.process.stdin) {
        reject(new Error('MCP server process not available'));
        return;
      }

      const timeout = setTimeout(() => {
        this.pendingResponses.delete(request.id);
        reject(new Error(`MCP request timed out for "${request.method}"`));
      }, 30000);

      this.pendingResponses.set(request.id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      const message = JSON.stringify(request) + '\n';
      server.process.stdin.write(message);
    });
  }

  private sendRequestWS(ws: WebSocket, request: JSONRPCRequest): Promise<JSONRPCResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(request.id);
        reject(new Error(`MCP request timed out for "${request.method}"`));
      }, 30000);

      this.pendingResponses.set(request.id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      ws.send(JSON.stringify(request));
    });
  }

  private async sendRequestSSE(server: MCPServerState, request: JSONRPCRequest): Promise<JSONRPCResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(request.id);
        reject(new Error(`MCP request timed out for "${request.method}"`));
      }, 30000);

      this.pendingResponses.set(request.id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      // Send via POST to the SSE endpoint URL
      const postUrl = server.ssePostUrl || server.config.command;
      if (!postUrl) {
        clearTimeout(timeout);
        this.pendingResponses.delete(request.id);
        reject(new Error('No SSE POST URL available'));
        return;
      }

      fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }).catch((err) => {
        clearTimeout(timeout);
        this.pendingResponses.delete(request.id);
        reject(err);
      });
    });
  }
}

export function mcpToolsToToolDefinitions(mcpTools: MCPTool[]): ToolDefinition[] {
  return mcpTools.map(t => ({
    name: `mcp_${t.serverName}_${t.name}`,
    description: `[MCP:${t.serverName}] ${t.description}`,
    input_schema: t.inputSchema as Record<string, unknown>,
  }));
}
