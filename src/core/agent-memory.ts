import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

// --- Original simple memory (kept for backward compatibility) ---

interface MemoryEntry {
  key: string;
  value: string;
  author: string;
  timestamp: number;
}

const memory = new Map<string, MemoryEntry>();

export function setMemory(key: string, value: string, author: string = 'system'): void {
  memory.set(key, { key, value, author, timestamp: Date.now() });
}

export function getMemory(key: string): string | null {
  return memory.get(key)?.value || null;
}

export function getAllMemory(): MemoryEntry[] {
  return Array.from(memory.values()).sort((a, b) => b.timestamp - a.timestamp);
}

export function formatMemoryForContext(): string {
  const entries = getAllMemory();
  if (entries.length === 0) return '';
  const lines = entries.map(e =>
    '- **' + e.key + '**: ' + e.value.slice(0, 200) + ' *(by ' + e.author + ')*'
  );
  return '\n## Agent Memory\n' + lines.join('\n');
}

export function clearMemory(): void {
  memory.clear();
}

// --- Typed Memory System ---

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface TypedMemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  links: string[];
  createdAt: number;
  updatedAt: number;
}

const LINK_PATTERN = /\[\[([^\]]+)\]\]/g;

function parseLinks(content: string): string[] {
  const links: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(LINK_PATTERN.source, 'g');
  while ((match = re.exec(content)) !== null) {
    const name = match[1].trim();
    if (name && !links.includes(name)) {
      links.push(name);
    }
  }
  return links;
}

function formatMemoryFile(entry: TypedMemoryEntry): string {
  const frontmatter = [
    '---',
    'name: ' + entry.name,
    'description: ' + entry.description,
    'metadata:',
    '  type: ' + entry.type,
    '  createdAt: ' + entry.createdAt,
    '  updatedAt: ' + entry.updatedAt,
    entry.links.length > 0 ? '  links: [' + entry.links.join(', ') + ']' : '',
    '---',
    '',
    entry.content,
  ].filter(Boolean).join('\n');
  return frontmatter;
}

function parseMemoryFile(filePath: string): TypedMemoryEntry | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    if (lines.length < 2 || lines[0].trim() !== '---') return null;
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { endIdx = i; break; }
    }
    if (endIdx === -1) return null;
    const frontmatterLines = lines.slice(1, endIdx);
    const content = lines.slice(endIdx + 1).join('\n').trim();
    let name = '';
    let description = '';
    let type: MemoryType = 'reference';
    let createdAt = Date.now();
    let updatedAt = Date.now();
    const links: string[] = [];
    for (const line of frontmatterLines) {
      const nameMatch = line.match(/^name:\s*(.+)$/);
      if (nameMatch) { name = nameMatch[1].trim(); continue; }
      const descMatch = line.match(/^description:\s*(.+)$/);
      if (descMatch) { description = descMatch[1].trim(); continue; }
      const typeMatch = line.match(/^\s+type:\s*(.+)$/);
      if (typeMatch) {
        const t = typeMatch[1].trim() as MemoryType;
        if (['user', 'feedback', 'project', 'reference'].includes(t)) { type = t; }
        continue;
      }
      const createdAtMatch = line.match(/^\s+createdAt:\s*(\d+)$/);
      if (createdAtMatch) { createdAt = parseInt(createdAtMatch[1], 10); continue; }
      const updatedAtMatch = line.match(/^\s+updatedAt:\s*(\d+)$/);
      if (updatedAtMatch) { updatedAt = parseInt(updatedAtMatch[1], 10); continue; }
      const linksMatch = line.match(/^\s+links:\s*\[(.*)\]$/);
      if (linksMatch) {
        const rawLinks = linksMatch[1].trim();
        if (rawLinks) { links.push(...rawLinks.split(',').map(l => l.trim()).filter(Boolean)); }
        continue;
      }
    }
    const contentLinks = parseLinks(content);
    for (const l of contentLinks) {
      if (!links.includes(l)) { links.push(l); }
    }
    return { name, description, type, content, links, createdAt, updatedAt };
  } catch {
    return null;
  }
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

export class TypedMemoryStore {
  private memoryDir: string;
  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir || join(homedir(), '.cobra-commander', 'memory');
    if (!existsSync(this.memoryDir)) { mkdirSync(this.memoryDir, { recursive: true }); }
  }
  save(entry: TypedMemoryEntry): void {
    const slug = toSlug(entry.name);
    const filePath = join(this.memoryDir, slug + '.md');
    const contentLinks = parseLinks(entry.content);
    const allLinks = Array.from(new Set(entry.links.concat(contentLinks)));
    const updatedEntry: TypedMemoryEntry = {
      ...entry, name: slug, links: allLinks,
      updatedAt: Date.now(), createdAt: entry.createdAt || Date.now(),
    };
    const content = formatMemoryFile(updatedEntry);
    writeFileSync(filePath, content, 'utf-8');
  }
  load(name: string): TypedMemoryEntry | null {
    const slug = toSlug(name);
    const filePath = join(this.memoryDir, slug + '.md');
    if (!existsSync(filePath)) return null;
    return parseMemoryFile(filePath);
  }
  list(type?: MemoryType): TypedMemoryEntry[] {
    const entries: TypedMemoryEntry[] = [];
    if (!existsSync(this.memoryDir)) return entries;
    const files = readdirSync(this.memoryDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const entry = parseMemoryFile(join(this.memoryDir, file));
      if (entry) { entries.push(entry); }
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    if (type) { return entries.filter(e => e.type === type); }
    return entries;
  }
  search(query: string): TypedMemoryEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.list().filter(entry =>
      entry.name.toLowerCase().includes(lowerQuery) ||
      entry.description.toLowerCase().includes(lowerQuery) ||
      entry.content.toLowerCase().includes(lowerQuery)
    );
  }
  delete(name: string): boolean {
    const slug = toSlug(name);
    const filePath = join(this.memoryDir, slug + '.md');
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  }
  updateIndex(): void {
    const entries = this.list();
    const lines: string[] = [
      '# Typed Memory Index', '',
      '> Auto-generated index of ' + entries.length + ' memory entries.', '',
      '| Name | Description | Type | Updated |',
      '|------|-------------|------|---------|',
    ];
    for (const entry of entries) {
      const date = new Date(entry.updatedAt).toISOString().slice(0, 10);
      lines.push('| ' + entry.name + ' | ' + entry.description + ' | ' + entry.type + ' | ' + date + ' |');
    }
    lines.push('');
    const indexPath = join(this.memoryDir, 'MEMORY.md');
    writeFileSync(indexPath, lines.join('\n'), 'utf-8');
  }
  getRelated(name: string): TypedMemoryEntry[] {
    const entry = this.load(name);
    if (!entry) return [];
    const related: TypedMemoryEntry[] = [];
    for (const linkName of entry.links) {
      const linked = this.load(linkName);
      if (linked) { related.push(linked); }
    }
    return related;
  }
}

// --- GAP-028: Cross-Session Memory Search ---

export interface SessionRecord {
  id: string;
  date: string;
  project: string;
  taskType: 'code-gen' | 'refactor' | 'debug' | 'review' | 'docs' | 'chat' | 'other';
  outcome: 'success' | 'partial' | 'failed' | 'in-progress';
  summary: string;
  messages: Array<{ role: string; content: string; timestamp: number }>;
  fileChanges: string[];
  duration: number;
  tags: string[];
  createdAt: number;
  lastAccessed: number;
}

export interface MemoryQuery {
  text?: string;
  project?: string;
  taskType?: SessionRecord['taskType'];
  outcome?: SessionRecord['outcome'];
  dateRange?: { from: number; to: number };
  tags?: string[];
  limit?: number;
  semantic?: boolean;
}

export interface MemorySearchResult {
  session: SessionRecord;
  score: number;
  matchedChunks: string[];
  matchType: 'fulltext' | 'semantic' | 'metadata';
}

export class SessionIndex {
  private sessions = new Map<string, SessionRecord>();
  private indexDir: string;
  private invertedIndex = new Map<string, Set<string>>();
  private projectIndex = new Map<string, Set<string>>();
  private taskTypeIndex = new Map<string, Set<string>>();

  constructor(indexDir?: string) {
    this.indexDir = indexDir || join(homedir(), '.cobra-commander', 'session-index');
    if (!existsSync(this.indexDir)) { mkdirSync(this.indexDir, { recursive: true }); }
    this.loadFromDisk();
  }

  index(session: SessionRecord): void {
    this.sessions.set(session.id, session);
    if (session.project) {
      if (!this.projectIndex.has(session.project)) { this.projectIndex.set(session.project, new Set()); }
      this.projectIndex.get(session.project)!.add(session.id);
    }
    if (!this.taskTypeIndex.has(session.taskType)) { this.taskTypeIndex.set(session.taskType, new Set()); }
    this.taskTypeIndex.get(session.taskType)!.add(session.id);
    const allText = session.summary + ' ' + session.messages.map(m => m.content).join(' ');
    const terms = this.tokenize(allText);
    for (const term of terms) {
      if (!this.invertedIndex.has(term)) { this.invertedIndex.set(term, new Set()); }
      this.invertedIndex.get(term)!.add(session.id);
    }
    this.persist();
  }

  remove(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    if (session.project && this.projectIndex.has(session.project)) {
      this.projectIndex.get(session.project)!.delete(sessionId);
    }
    if (this.taskTypeIndex.has(session.taskType)) {
      this.taskTypeIndex.get(session.taskType)!.delete(sessionId);
    }
    this.invertedIndex.forEach((ids) => { ids.delete(sessionId); });
    this.persist();
    return true;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  list(filter?: { project?: string; taskType?: SessionRecord['taskType'] }): SessionRecord[] {
    let results = Array.from(this.sessions.values());
    if (filter?.project) {
      const ids = this.projectIndex.get(filter.project);
      if (ids) results = results.filter(s => ids.has(s.id));
      else return [];
    }
    if (filter?.taskType) {
      const ids = this.taskTypeIndex.get(filter.taskType);
      if (ids) results = results.filter(s => ids.has(s.id));
      else return [];
    }
    return results.sort((a, b) => b.lastAccessed - a.lastAccessed);
  }

  private tokenize(text: string): string[] {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 1 && !['the', 'and', 'for', 'was', 'that', 'this', 'with', 'from'].includes(w));
  }

  private persist(): void {
    try {
      const data = {
        sessions: Array.from(this.sessions.values()),
        invertedIndex: Object.fromEntries(
          Array.from(this.invertedIndex.entries()).map(([k, v]) => [k, Array.from(v)]),
        ),
        projectIndex: Object.fromEntries(
          Array.from(this.projectIndex.entries()).map(([k, v]) => [k, Array.from(v)]),
        ),
        taskTypeIndex: Object.fromEntries(
          Array.from(this.taskTypeIndex.entries()).map(([k, v]) => [k, Array.from(v)]),
        ),
      };
      writeFileSync(join(this.indexDir, 'index.json'), JSON.stringify(data, null, 2));
    } catch { /* ignore */ }
  }

  private loadFromDisk(): void {
    const path = join(this.indexDir, 'index.json');
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      for (const s of raw.sessions || []) { this.sessions.set(s.id, s); }
      for (const [k, v] of Object.entries(raw.invertedIndex || {})) {
        this.invertedIndex.set(k, new Set(v as string[]));
      }
      for (const [k, v] of Object.entries(raw.projectIndex || {})) {
        this.projectIndex.set(k, new Set(v as string[]));
      }
      for (const [k, v] of Object.entries(raw.taskTypeIndex || {})) {
        this.taskTypeIndex.set(k, new Set(v as string[]));
      }
    } catch { /* ignore */ }
  }

  get count(): number { return this.sessions.size; }
}

export class MemorySearch {
  private sessionIndex: SessionIndex;
  private embeddingsCache = new Map<string, number[]>();

  constructor(sessionIndex: SessionIndex) {
    this.sessionIndex = sessionIndex;
  }

  search(query: MemoryQuery): MemorySearchResult[] {
    const results: MemorySearchResult[] = [];
    let candidates = this.sessionIndex.list();

    if (query.project) { candidates = candidates.filter(s => s.project === query.project); }
    if (query.taskType) { candidates = candidates.filter(s => s.taskType === query.taskType); }
    if (query.outcome) { candidates = candidates.filter(s => s.outcome === query.outcome); }
    if (query.dateRange) {
      candidates = candidates.filter(
        s => s.createdAt >= query.dateRange!.from && s.createdAt <= query.dateRange!.to
      );
    }
    if (query.tags && query.tags.length > 0) {
      candidates = candidates.filter(s => query.tags!.some(t => s.tags.includes(t)));
    }

    if (query.text) {
      const lowerQuery = query.text.toLowerCase();
      const queryTerms = lowerQuery.split(/\s+/).filter(Boolean);
      for (const session of candidates) {
        let score = 0;
        const matchedChunks: string[] = [];
        const summaryLower = session.summary.toLowerCase();
        for (const term of queryTerms) {
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escaped, 'gi');
          const matches = summaryLower.match(regex);
          if (matches) score += matches.length * 2;
        }
        if (score > 0) { matchedChunks.push(session.summary.slice(0, 200)); }
        for (const msg of session.messages) {
          const msgLower = msg.content.toLowerCase();
          for (const term of queryTerms) {
            if (msgLower.includes(term)) {
              score += 1;
              if (matchedChunks.length < 5) { matchedChunks.push(msg.content.slice(0, 150)); }
            }
          }
        }
        if (score > 0) {
          results.push({ session, score, matchedChunks, matchType: 'fulltext' });
        }
      }
    } else {
      for (const session of candidates) {
        results.push({ session, score: 1.0, matchedChunks: [session.summary.slice(0, 200)], matchType: 'metadata' });
      }
    }
    results.sort((a, b) => b.score - a.score);
    const limit = query.limit || 20;
    return results.slice(0, limit);
  }

  async semanticSearch(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const results = this.search({ ...query, semantic: false });
    if (!query.text) return results;
    const queryEmbedding = await this.generateEmbedding(query.text);
    for (const result of results) {
      const sessionEmbedding = await this.getOrCreateEmbedding(result.session.id);
      const similarity = this.cosineSimilarity(queryEmbedding, sessionEmbedding);
      result.score = result.score * 0.4 + similarity * 0.6;
      result.matchType = 'semantic';
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, query.limit || 20);
  }

  private async generateEmbedding(text: string, dims: number = 128): Promise<number[]> {
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const vec = new Array(dims).fill(0);
    for (const word of words) {
      const hash = createHash('sha256').update(word).digest();
      for (let i = 0; i < dims; i++) { vec[i] += (hash[i % hash.length] - 127.5) / 127.5; }
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (mag > 0) { for (let i = 0; i < dims; i++) vec[i] /= mag; }
    return vec;
  }

  private async getOrCreateEmbedding(sessionId: string): Promise<number[]> {
    if (this.embeddingsCache.has(sessionId)) { return this.embeddingsCache.get(sessionId)!; }
    const session = this.sessionIndex.get(sessionId);
    const text = session ? session.summary + ' ' + session.messages.map(m => m.content).join(' ') : '';
    const embedding = await this.generateEmbedding(text);
    this.embeddingsCache.set(sessionId, embedding);
    return embedding;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]; }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }
}

export class MemoryCompactor {
  private sessionIndex: SessionIndex;
  private compactionDir: string;
  private maxAgeDays: number;
  private maxSessions: number;

  constructor(sessionIndex: SessionIndex, options: { maxAgeDays?: number; maxSessions?: number; compactionDir?: string } = {}) {
    this.sessionIndex = sessionIndex;
    this.compactionDir = options.compactionDir || join(homedir(), '.cobra-commander', 'compacted');
    this.maxAgeDays = options.maxAgeDays || 90;
    this.maxSessions = options.maxSessions || 500;
    if (!existsSync(this.compactionDir)) { mkdirSync(this.compactionDir, { recursive: true }); }
  }

  compact(): { compacted: number; removed: number } {
    const allSessions = this.sessionIndex.list();
    allSessions.sort((a, b) => a.createdAt - b.createdAt);
    const cutoff = Date.now() - this.maxAgeDays * 86400000;
    let compacted = 0;
    let removed = 0;
    for (const session of allSessions) {
      if (session.createdAt < cutoff) {
        const summary = this.summarizeSession(session);
        const archivePath = join(this.compactionDir, session.id + '.json');
        try {
          writeFileSync(archivePath, JSON.stringify({ ...session, summary, compactedAt: Date.now() }, null, 2));
          this.sessionIndex.remove(session.id);
          compacted++;
        } catch { /* ignore */ }
      }
    }
    const remaining = this.sessionIndex.list();
    if (remaining.length > this.maxSessions) {
      const toRemove = remaining.slice(this.maxSessions);
      for (const session of toRemove) { this.sessionIndex.remove(session.id); removed++; }
    }
    return { compacted, removed };
  }

  summarizeSession(session: SessionRecord): string {
    const lines: string[] = [
      'Session: ' + session.id,
      'Date: ' + session.date,
      'Project: ' + (session.project || 'unknown'),
      'Task: ' + session.taskType,
      'Outcome: ' + session.outcome,
      'Duration: ' + Math.round(session.duration / 60000) + 'min',
      '', 'Summary:',
    ];
    const userMessages = session.messages.filter(m => m.role === 'user');
    for (let i = 0; i < Math.min(userMessages.length, 5); i++) {
      lines.push('- ' + userMessages[i].content.slice(0, 200));
    }
    if (session.fileChanges.length > 0) {
      lines.push('', 'Files changed: ' + session.fileChanges.length);
      for (const f of session.fileChanges.slice(0, 10)) { lines.push('  - ' + f); }
    }
    return lines.join('\n');
  }

  listArchives(): string[] {
    if (!existsSync(this.compactionDir)) return [];
    return readdirSync(this.compactionDir).filter(f => f.endsWith('.json')).map(f => join(this.compactionDir, f));
  }

  importArchive(archivePath: string): boolean {
    try {
      const session: SessionRecord = JSON.parse(readFileSync(archivePath, 'utf-8'));
      this.sessionIndex.index(session);
      return true;
    } catch { return false; }
  }
}
