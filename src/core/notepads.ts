import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Notepad {
  id: string;
  title: string;
  content: string;
  tags: string[];
  project?: string;
  pinned: boolean;
  global: boolean;
  createdAt: number;
  updatedAt: number;
  author: string;
}

export interface NotepadSearchResult {
  notepad: Notepad;
  score: number;
  matchedIn: 'title' | 'content' | 'tags';
}

export interface NotepadStoreOptions {
  storeDir?: string;
  autoSaveMs?: number;
}

// ─── NotepadManager ─────────────────────────────────────────────────────────

export class NotepadManager {
  private notepads = new Map<string, Notepad>();
  private storeDir: string;
  private autoSaveTimer?: ReturnType<typeof setInterval>;
  private dirty = new Set<string>();

  constructor(options: NotepadStoreOptions = {}) {
    this.storeDir = options.storeDir || join(homedir(), '.cobra-commander', 'notepads');
    if (!existsSync(this.storeDir)) {
      mkdirSync(this.storeDir, { recursive: true });
    }
    this.loadAll();
  }

  /** Create a new notepad. */
  create(params: {
    title: string;
    content?: string;
    tags?: string[];
    project?: string;
    pinned?: boolean;
    global?: boolean;
    author?: string;
  }): Notepad {
    const now = Date.now();
    const notepad: Notepad = {
      id: `np-${randomUUID().slice(0, 12)}`,
      title: params.title,
      content: params.content || '',
      tags: params.tags || [],
      project: params.project,
      pinned: params.pinned || false,
      global: params.global || false,
      createdAt: now,
      updatedAt: now,
      author: params.author || 'system',
    };

    this.notepads.set(notepad.id, notepad);
    this.save(notepad);
    return notepad;
  }

  /** Read a notepad by ID. */
  get(id: string): Notepad | undefined {
    return this.notepads.get(id);
  }

  /** Update a notepad's content. */
  update(id: string, updates: Partial<Pick<Notepad, 'title' | 'content' | 'tags' | 'pinned' | 'global' | 'project'>>): Notepad | null {
    const notepad = this.notepads.get(id);
    if (!notepad) return null;

    if (updates.title !== undefined) notepad.title = updates.title;
    if (updates.content !== undefined) notepad.content = updates.content;
    if (updates.tags !== undefined) notepad.tags = updates.tags;
    if (updates.pinned !== undefined) notepad.pinned = updates.pinned;
    if (updates.global !== undefined) notepad.global = updates.global;
    if (updates.project !== undefined) notepad.project = updates.project;
    notepad.updatedAt = Date.now();

    this.markDirty(id);
    this.save(notepad);
    return notepad;
  }

  /** Delete a notepad. */
  delete(id: string): boolean {
    const notepad = this.notepads.get(id);
    if (!notepad) return false;

    this.notepads.delete(id);
    this.dirty.delete(id);

    const filePath = join(this.storeDir, `${id}.json`);
    if (existsSync(filePath)) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
    return true;
  }

  /** List all notepads, optionally filtered. */
  list(options?: {
    project?: string;
    tags?: string[];
    pinned?: boolean;
    global?: boolean;
  }): Notepad[] {
    let results = Array.from(this.notepads.values());

    if (options?.project) {
      results = results.filter(n => n.project === options.project);
    }
    if (options?.tags && options.tags.length > 0) {
      results = results.filter(n => options.tags!.some(t => n.tags.includes(t)));
    }
    if (options?.pinned !== undefined) {
      results = results.filter(n => n.pinned === options.pinned);
    }
    if (options?.global !== undefined) {
      results = results.filter(n => n.global === options.global);
    }

    // Sort: pinned first, then by updatedAt descending
    results.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.updatedAt - a.updatedAt;
    });

    return results;
  }

  /** Toggle pin status. */
  togglePin(id: string): Notepad | null {
    const notepad = this.notepads.get(id);
    if (!notepad) return null;
    return this.update(id, { pinned: !notepad.pinned });
  }

  /** Auto-save a notepad (mark as dirty for deferred save). */
  autoSave(id: string, content: string): void {
    const notepad = this.notepads.get(id);
    if (!notepad) return;

    notepad.content = content;
    notepad.updatedAt = Date.now();
    this.markDirty(id);
  }

  /** Mark a notepad as needing persistence. */
  private markDirty(id: string): void {
    this.dirty.add(id);
  }

  /** Flush all dirty notepads to disk. */
  flush(): void {
    for (const id of this.dirty) {
      const notepad = this.notepads.get(id);
      if (notepad) this.save(notepad);
    }
    this.dirty.clear();
  }

  /** Enable periodic auto-save. */
  enableAutoSave(intervalMs: number = 30000): void {
    this.disableAutoSave();
    this.autoSaveTimer = setInterval(() => this.flush(), intervalMs);
  }

  /** Disable periodic auto-save. */
  disableAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
    }
  }

  /** Export all notepads (for backup). */
  exportAll(): string {
    return JSON.stringify(this.list(), null, 2);
  }

  /** Import notepads (from backup). */
  importAll(json: string): number {
    try {
      const data: Notepad[] = JSON.parse(json);
      let count = 0;
      for (const np of data) {
        if (!this.notepads.has(np.id)) {
          this.notepads.set(np.id, np);
          this.save(np);
          count++;
        }
      }
      return count;
    } catch {
      return 0;
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  private save(notepad: Notepad): void {
    const filePath = join(this.storeDir, `${notepad.id}.json`);
    try {
      writeFileSync(filePath, JSON.stringify(notepad, null, 2));
    } catch { /* ignore save errors */ }
  }

  private loadAll(): void {
    if (!existsSync(this.storeDir)) return;

    const files = readdirSync(this.storeDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const notepad: Notepad = JSON.parse(readFileSync(join(this.storeDir, file), 'utf-8'));
        this.notepads.set(notepad.id, notepad);
      } catch { /* skip corrupt files */ }
    }
  }
}

// ─── NotepadSearch ──────────────────────────────────────────────────────────

export class NotepadSearch {
  private manager: NotepadManager;

  constructor(manager: NotepadManager) {
    this.manager = manager;
  }

  /** Search notepads by query string. */
  search(query: string, options?: {
    project?: string;
    tags?: string[];
    maxResults?: number;
  }): NotepadSearchResult[] {
    const lowerQuery = query.toLowerCase();
    const queryTerms = lowerQuery.split(/\s+/).filter(Boolean);
    const results: NotepadSearchResult[] = [];

    const candidates = this.manager.list({
      project: options?.project,
      tags: options?.tags,
    });

    for (const notepad of candidates) {
      let score = 0;
      let matchedIn: NotepadSearchResult['matchedIn'] = 'content';

      // Title match (weighted higher)
      if (notepad.title.toLowerCase().includes(lowerQuery)) {
        score += 10;
        matchedIn = 'title';
      }

      // Content match
      for (const term of queryTerms) {
        const contentLower = notepad.content.toLowerCase();
        const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const matches = contentLower.match(regex);
        if (matches) score += matches.length;
      }

      // Tag match
      const tagMatch = notepad.tags.some(t => t.toLowerCase().includes(lowerQuery));
      if (tagMatch) {
        score += 5;
        if (matchedIn === 'content') matchedIn = 'tags';
      }

      if (score > 0) {
        results.push({ notepad, score, matchedIn });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options?.maxResults || 20);
  }

  /** Search by tag only. */
  searchByTag(tag: string): Notepad[] {
    return this.manager.list({ tags: [tag] });
  }

  /** Full-text search with snippet extraction. */
  searchWithSnippets(query: string, snippetLength: number = 120): Array<{
    notepad: Notepad;
    snippet: string;
    score: number;
  }> {
    const results = this.search(query);
    return results.map(r => {
      const lowerQuery = query.toLowerCase();
      const content = r.notepad.content;
      const idx = content.toLowerCase().indexOf(lowerQuery);

      let snippet = '';
      if (idx >= 0) {
        const start = Math.max(0, idx - snippetLength / 2);
        const end = Math.min(content.length, idx + query.length + snippetLength / 2);
        snippet = (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
      } else {
        snippet = content.slice(0, snippetLength);
      }

      return {
        notepad: r.notepad,
        snippet,
        score: r.score,
      };
    });
  }
}
