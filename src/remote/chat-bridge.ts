import { WebSocket } from 'ws';
import { getIntakeProvider } from '../core/intake-config.js';
import type { ToolDefinition } from '../core/types.js';

const API_BASE = apiBaseUrl();
const API_TOKEN = process.env.API_TOKEN || '';

async function apiCall(method: string, path: string, body?: unknown): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  return res.json();
}
import {
  createChat,
  getChat,
  saveChat,
  chatTitle,
} from './chat-store.js';
import type { StoredMessage } from './chat-store.js';
import { installRoot } from '../core/env-file.js';
import { apiBaseUrl } from '../core/net-defaults.js';

const CC_HOME = installRoot();

function buildSystemPrompt(): string {
  return `You are the Intake Agent for Cobra Commander, a multi-model IDE platform.
You are the ONLY interface between the human CTO and the engineering department.

## YOUR ROLE
- Receive work requests from the CTO
- Expand them into structured requirements and dispatch to the orchestrator — in ONE shot, no approval needed
- Report on task status when asked
- You are the front desk. All communication flows through you.

## WHEN CTO GIVES YOU WORK
1. Call dispatch_work immediately with the CTO's prompt. This expands requirements AND sends to the orchestrator automatically.
2. Report back: "Sent to engineering — {project name}, task {id}." Include 2-3 key requirements from the summary.
3. Done. Do NOT ask the CTO to approve, review, or confirm. The CTO trusts you to expand correctly.

## RULES
- Be concise. 1-3 sentences for most responses.
- NEVER ask "does this look good?" or "should I send this?" — just send it.
- For status checks, call check_task_status.
- For project questions, call list_all_projects or get_project_info.
- You do NOT write code, spawn workers, run commands, or access the filesystem.
- If the CTO asks for something that needs code changes, dispatch it. That's the orchestrator's problem.

## WHAT YOU ARE NOT
- You are NOT the Head of Engineering. You don't manage workers.
- You are NOT a developer. You don't write code.
- You are NOT an orchestrator. You don't break down tasks.
- You receive, expand, dispatch, report. That's it.`;
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface QueueEntry {
  text: string;
  images?: string[];
  chatId?: string;
}

interface ChatSession {
  id: string;
  channel: string;
  ws: WebSocket;
  cancelled: boolean;
  activeRequest: boolean;
  messages: Message[];
  queue: QueueEntry[];
  workDir: string;
  username: string;
  chatId: string | null;
}

const sessions = new Map<string, Map<string, ChatSession>>();

function sendWs(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendChannel(session: ChatSession, data: Record<string, unknown>): void {
  sendWs(session.ws, { ...data, channel: session.channel });
}

export async function handleChatConnection(
  ws: WebSocket,
  sessionId: string,
  workDir: string,
  username: string,
): Promise<void> {
  const channels = new Map<string, ChatSession>();

  function getChannel(channel: string): ChatSession {
    let session = channels.get(channel);
    if (!session) {
      session = {
        id: sessionId,
        channel,
        ws,
        cancelled: false,
        activeRequest: false,
        messages: [],
        queue: [],
        workDir,
        username,
        chatId: null,
      };
      channels.set(channel, session);
    }
    return session;
  }

  getChannel('main');
  sessions.set(sessionId, channels);
  sendWs(ws, { type: 'connected', sessionId });

  async function processChannelQueue(session: ChatSession): Promise<void> {
    while (session.queue.length > 0 && !session.cancelled) {
      const entry = session.queue.shift()!;
      session.activeRequest = true;
      session.cancelled = false;
      sendChannel(session, { type: 'queue_next', text: entry.text });
      try {
        await handlePrompt(session, entry.text, session.workDir, entry.chatId, entry.images);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        sendChannel(session, { type: 'error', message });
      } finally {
        session.activeRequest = false;
      }
    }
  }

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'prompt' && typeof msg.text === 'string') {
        const channel = typeof msg.channel === 'string' ? msg.channel : 'main';
        const session = getChannel(channel);
        const chatId = typeof msg.chatId === 'string' ? msg.chatId : undefined;
        const images = Array.isArray(msg.images) ? msg.images.filter((i: unknown) => typeof i === 'string') : undefined;

        if (session.activeRequest) {
          session.queue.push({ text: msg.text, images, chatId });
          sendChannel(session, { type: 'queued', position: session.queue.length, text: msg.text });
          return;
        }

        session.cancelled = false;
        session.activeRequest = true;

        try {
          await handlePrompt(session, msg.text, session.workDir, chatId, images);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          sendChannel(session, { type: 'error', message });
        } finally {
          session.activeRequest = false;
          processChannelQueue(session);
        }
      }

      if (msg.type === 'cancel') {
        const channel = typeof msg.channel === 'string' ? msg.channel : 'main';
        const session = channels.get(channel);
        if (session) {
          session.cancelled = true;
          session.queue = [];
          sendChannel(session, { type: 'cancelled' });
        }
      }

      if (msg.type === 'set_workdir' && typeof msg.path === 'string') {
        for (const session of channels.values()) {
          session.workDir = msg.path;
          session.messages = [];
          session.chatId = null;
        }
        sendWs(ws, { type: 'workdir_changed', path: msg.path });
      }

      if (msg.type === 'clear') {
        const channel = typeof msg.channel === 'string' ? msg.channel : 'main';
        const session = channels.get(channel);
        if (session) {
          session.messages = [];
          session.queue = [];
          sendChannel(session, { type: 'cleared' });
        }
      }
    } catch { /* ignore invalid messages */ }
  });

  ws.on('close', () => {
    for (const session of channels.values()) {
      session.cancelled = true;
    }
    sessions.delete(sessionId);
  });

  ws.on('error', () => {
    for (const session of channels.values()) {
      session.cancelled = true;
    }
    sessions.delete(sessionId);
  });
}

function buildIntakeTools(): ToolDefinition[] {
  return [
    {
      name: 'dispatch_work',
      description: 'Expand a CTO prompt into structured requirements and immediately send to the orchestrator for implementation. One shot — no approval needed. ALWAYS call this when the CTO gives you a work request.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The CTO\'s work request' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'check_task_status',
      description: 'Check the status of tasks in the engineering department.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['all', 'pending', 'active', 'completed', 'failed'], description: 'Filter by status (default: all)' },
        },
      },
    },
    {
      name: 'list_all_projects',
      description: 'List all known projects in the system.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'get_project_info',
      description: 'Get detailed information about a specific project.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name to look up' },
        },
        required: ['name'],
      },
    },
  ];
}

async function executeIntakeTool(
  name: string,
  input: Record<string, unknown>,
  _workDir: string,
): Promise<{ content: string; is_error: boolean }> {
  try {
    switch (name) {
      case 'dispatch_work': {
        const prompt = input.prompt as string;

        const request = await apiCall('POST', '/api/v1/intake/expand', { prompt });
        if (!request.requirements || request.requirements.startsWith('ERROR')) {
          return { content: `Expansion failed: ${request.requirements || 'unknown error'}`, is_error: true };
        }

        await apiCall('POST', `/api/v1/intake/requests/${request.id}/approve`);
        const sent = await apiCall('POST', `/api/v1/intake/requests/${request.id}/send`);

        const keyReqs = (request.requirements.match(/^\d+\..+$/gm) || []).slice(0, 5).join('\n');

        return {
          content: `Dispatched to orchestrator.\nTask ID: ${sent.taskId || 'pending'}\nProject: ${request.projectName}\nPath: ${request.projectPath}\nPorts: ${request.ports ? `${request.ports.frontend}/${request.ports.backend}` : 'N/A'}\n\nKey requirements:\n${keyReqs || 'See full requirements doc.'}`,
          is_error: false,
        };
      }

      case 'check_task_status': {
        const tasks = await apiCall('GET', '/api/v1/tasks');
        const taskList = Array.isArray(tasks) ? tasks : tasks.tasks || [];
        let result = `${taskList.length} tasks:\n`;
        const statusFilter = input.status as string | undefined;
        for (const t of taskList.slice(0, 10)) {
          if (statusFilter && statusFilter !== 'all' && t.status !== statusFilter) continue;
          result += `- ${t.id}: ${(t.task || t.description || '').slice(0, 60)}... [${t.status}]${t.error ? ` ERROR: ${t.error.slice(0, 50)}` : ''}\n`;
        }
        return { content: result, is_error: false };
      }

      case 'list_all_projects': {
        const data = await apiCall('GET', '/api/v1/intake/projects');
        const projects = data.projects || [];
        if (projects.length === 0) return { content: 'No projects registered.', is_error: false };
        let result = `${projects.length} projects:\n`;
        for (const p of projects) {
          result += `- ${p.projectName} → ${p.folderPath}\n`;
        }
        return { content: result, is_error: false };
      }

      case 'get_project_info': {
        const projectName = input.name as string;
        const data = await apiCall('GET', `/api/v1/intake/projects/${encodeURIComponent(projectName)}`);
        if (data.error) return { content: `Project "${projectName}" not found.`, is_error: true };
        return { content: JSON.stringify(data, null, 2).slice(0, 2000), is_error: false };
      }

      default:
        return { content: `Unknown tool: ${name}`, is_error: true };
    }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
  }
}

async function handlePrompt(
  session: ChatSession,
  text: string,
  workDir: string,
  chatId?: string,
  _images?: string[],
): Promise<void> {
  const isMain = session.channel === 'main';
  const resolvedChatId = isMain ? (chatId || session.chatId) : null;

  if (isMain) {
    if (!resolvedChatId) {
      const newChat = createChat(session.username, chatTitle(text));
      session.chatId = newChat.id;
      sendChannel(session, { type: 'chat_info', chatId: newChat.id, title: newChat.title });
    } else if (resolvedChatId !== session.chatId) {
      session.chatId = resolvedChatId;
      const existing = getChat(session.username, resolvedChatId);
      if (existing) {
        session.messages = existing.messages.map((m) => ({ ...m }));
        sendChannel(session, { type: 'chat_info', chatId: existing.id, title: existing.title });
      }
    }
  }

  const persistMessages = (): void => {
    if (!isMain || !session.chatId) return;
    const chat = getChat(session.username, session.chatId);
    if (chat) {
      chat.messages = session.messages.map((m) => {
        if (Array.isArray(m.content)) {
          const t = (m.content as Array<{ type: string; text?: string }>)
            .map((p) => p.text || '[image]')
            .join(' ');
          return { ...m, content: t };
        }
        return { ...m, content: m.content ?? null };
      }) as StoredMessage[];
      if (chat.title === 'New Chat') {
        const firstUser = session.messages.find((m) => m.role === 'user');
        if (firstUser && typeof firstUser.content === 'string') {
          chat.title = chatTitle(firstUser.content);
          sendChannel(session, { type: 'chat_info', chatId: chat.id, title: chat.title });
        }
      }
      saveChat(chat);
    }
  };

  let provider;
  try {
    provider = await getIntakeProvider();
  } catch (err) {
    sendChannel(session, { type: 'error', message: `Intake provider error: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  session.messages.push({ role: 'user', content: text });

  const tools = buildIntakeTools();
  const maxTurns = 20;
  let turns = 0;
  let sentAck = false;

  while (turns < maxTurns) {
    if (session.cancelled) { persistMessages(); return; }
    turns++;
    console.log(`[intake-chat] channel=${session.channel} turn=${turns} user=${session.username}`);

    let response;
    try {
      response = await provider.chat(buildSystemPrompt(), session.messages, tools, 8192);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[intake-chat] API error: ${msg}`);
      sendChannel(session, { type: 'error', message: `API error: ${msg}` });
      persistMessages();
      return;
    }

    if (session.cancelled) { persistMessages(); return; }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      let finalText = response.text || '';
      if (finalText.includes('DSML')) {
        finalText = finalText.replace(/<[｜|]+DSML[｜|]+[^>]*>[\s\S]*/g, '').trim();
        if (!finalText) finalText = 'Done.';
      }
      if (finalText) {
        sendChannel(session, { type: 'text', content: finalText });
      }
      session.messages.push({ role: 'assistant', content: finalText });
      sendChannel(session, { type: 'done' });
      persistMessages();
      break;
    }

    if (response.text && !sentAck) {
      sentAck = true;
      sendChannel(session, { type: 'text', content: response.text });
    }

    for (const tc of response.toolCalls) {
      sendWs(session.ws, {
        type: 'tool_activity',
        action: 'call',
        tool: tc.name,
        args: JSON.stringify(tc.input).substring(0, 80),
      });
    }

    session.messages.push({
      role: 'assistant',
      content: response.text || null,
      tool_calls: response.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      })),
    });

    for (const tc of response.toolCalls) {
      if (session.cancelled) { persistMessages(); return; }

      const result = await executeIntakeTool(tc.name, tc.input, workDir);
      console.log(`[intake-chat] tool_result: ${tc.name} → ${result.content.substring(0, 120)}`);
      sendWs(session.ws, {
        type: 'tool_activity',
        action: 'result',
        tool: tc.name,
        size: result.content.length,
        error: result.is_error,
      });

      session.messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result.content,
      });
    }
  }

  if (turns >= maxTurns) {
    sendChannel(session, { type: 'error', message: 'Max turns reached.' });
  }
  persistMessages();
}

export function getActiveChatCount(): number {
  let count = 0;
  for (const channels of sessions.values()) {
    count += channels.size;
  }
  return count;
}

export function shutdownAllChat(): void {
  for (const [id, channels] of sessions) {
    for (const session of channels.values()) {
      session.cancelled = true;
    }
    try {
      const mainSession = channels.get('main');
      if (mainSession) mainSession.ws.close();
    } catch { /* ignore */ }
    sessions.delete(id);
  }
}
