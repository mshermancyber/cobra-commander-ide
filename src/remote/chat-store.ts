import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Chat persistence — JSON files at ~/.cobra-commander/chats/{username}/{id}.json
// ---------------------------------------------------------------------------

export interface StoredMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatFile {
  id: string;
  title: string;
  username: string;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface ChatMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

// ── Path helpers ──

function getChatDir(username: string): string {
  return join(homedir(), '.cobra-commander', 'chats', username);
}

function getChatPath(username: string, chatId: string): string {
  return join(getChatDir(username), `${chatId}.json`);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── Generate title from first user message ──

export function chatTitle(text: string): string {
  return text.replace(/\n/g, ' ').trim().slice(0, 50);
}

// ── CRUD ──

export function listChats(username: string, archived: boolean = false): ChatMeta[] {
  const dir = getChatDir(username);
  if (!existsSync(dir)) return [];

  const results: ChatMeta[] = [];
  const entries = readdirSync(dir).filter((f) => f.endsWith('.json'));

  for (const entry of entries) {
    try {
      const raw = readFileSync(join(dir, entry), 'utf-8');
      const chat: ChatFile = JSON.parse(raw);
      if (chat.archived === archived) {
        results.push({
          id: chat.id,
          title: chat.title,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          archived: chat.archived,
        });
      }
    } catch { /* skip invalid files */ }
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results;
}

export function getChat(username: string, chatId: string): ChatFile | null {
  const path = getChatPath(username, chatId);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ChatFile;
  } catch {
    return null;
  }
}

export function createChat(username: string, title?: string): ChatFile {
  const dir = getChatDir(username);
  ensureDir(dir);

  const now = Date.now();
  const chat: ChatFile = {
    id: randomUUID(),
    title: title || 'New Chat',
    username,
    messages: [],
    createdAt: now,
    updatedAt: now,
    archived: false,
  };

  writeFileSync(getChatPath(username, chat.id), JSON.stringify(chat, null, 2));
  return chat;
}

export function saveChat(chat: ChatFile): void {
  const dir = getChatDir(chat.username);
  ensureDir(dir);
  chat.updatedAt = Date.now();
  writeFileSync(getChatPath(chat.username, chat.id), JSON.stringify(chat, null, 2));
}

export function archiveChat(username: string, chatId: string): boolean {
  const chat = getChat(username, chatId);
  if (!chat) return false;
  chat.archived = true;
  saveChat(chat);
  return true;
}

export function unarchiveChat(username: string, chatId: string): boolean {
  const chat = getChat(username, chatId);
  if (!chat) return false;
  chat.archived = false;
  saveChat(chat);
  return true;
}

export function deleteChat(username: string, chatId: string): boolean {
  const path = getChatPath(username, chatId);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
