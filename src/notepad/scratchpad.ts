import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { join, relative, parse } from 'node:path';
import { randomUUID } from 'node:crypto';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface ScratchNote {
  id: string;
  title: string;
  content: string;           // Markdown content
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** File path context: which file(s) the note is associated with */
  contextFiles: string[];
  /** Project root this note belongs to */
  projectRoot: string;
  /** Whether to include this note's content in AI prompts */
  injectIntoContext: boolean;
}

export interface NoteCreateInput {
  title: string;
  content: string;
  tags?: string[];
  contextFiles?: string[];
  injectIntoContext?: boolean;
}

export interface NoteUpdateInput {
  title?: string;
  content?: string;
  tags?: string[];
  contextFiles?: string[];
  injectIntoContext?: boolean;
}

export interface NoteQuery {
  tag?: string;
  contextFile?: string;
  search?: string;           // Full-text search in title + content
  sortBy?: 'updatedAt' | 'createdAt' | 'title';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ContextInjection {
  noteId: string;
  title: string;
  snippet: string;           // Truncated content for prompt inclusion
  relevanceScore: number;    // How relevant this note is to current context
}

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const NOTES_DIRNAME = '.cobra-commander/notepad';
const NOTES_INDEX_FILE = 'index.json';
const MAX_CONTEXT_SNIPPET_LENGTH = 2000;

// ──────────────────────────────────────────────
// Tag auto-generation from file context
// ──────────────────────────────────────────────

const AUTO_TAG_RULES: Array<{
  tag: string;
  patterns: RegExp[];
}> = [
  { tag: 'typescript', patterns: [/\.tsx?$/i] },
  { tag: 'javascript', patterns: [/\.jsx?$/i] },
  { tag: 'python', patterns: [/\.py$/i] },
  { tag: 'rust', patterns: [/\.rs$/i] },
  { tag: 'go', patterns: [/\.go$/i] },
  { tag: 'java', patterns: [/\.java$/i] },
  { tag: 'css', patterns: [/\.css$/i, /\.scss$/i, /\.less$/i] },
  { tag: 'html', patterns: [/\.html?$/i] },
  { tag: 'markdown', patterns: [/\.md$/i] },
  { tag: 'test', patterns: [/\.test\./, /\.spec\./, /__tests__/] },
  { tag: 'config', patterns: [/\.json$/i, /\.ya?ml$/i, /\.toml$/i, /\.config\./] },
  { tag: 'docs', patterns: [/docs?\//, /readme/i, /contributing/i] },
  { tag: 'api', patterns: [/\/api\//, /\/routes\//, /controller/i, /handler/i] },
  { tag: 'database', patterns: [/\/db\//, /\/database\//, /migration/i, /schema/i, /model/i] },
  { tag: 'ui', patterns: [/component/i, /\.vue$/i, /\.svelte$/i] },
];

/**
 * Derive tags from associated file paths using pattern matching.
 */
export function autoTagFromFiles(filePaths: string[]): string[] {
  const tags = new Set<string>();
  for (const fp of filePaths) {
    for (const rule of AUTO_TAG_RULES) {
      if (rule.patterns.some((p) => p.test(fp))) {
        tags.add(rule.tag);
      }
    }
  }
  return Array.from(tags).sort();
}

// ──────────────────────────────────────────────
// Scratchpad Manager
// ──────────────────────────────────────────────

export class ScratchpadManager {
  private notesDir: string;
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.notesDir = join(projectRoot, NOTES_DIRNAME);
    this.ensureDir();
  }

  // ── file system helpers ──

  private ensureDir(): void {
    if (!existsSync(this.notesDir)) {
      mkdirSync(this.notesDir, { recursive: true });
    }
    const indexPath = join(this.notesDir, NOTES_INDEX_FILE);
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, '[]', 'utf-8');
    }
  }

  private readIndex(): ScratchNote[] {
    const indexPath = join(this.notesDir, NOTES_INDEX_FILE);
    try {
      const raw = readFileSync(indexPath, 'utf-8');
      return JSON.parse(raw) as ScratchNote[];
    } catch {
      return [];
    }
  }

  private writeIndex(notes: ScratchNote[]): void {
    const indexPath = join(this.notesDir, NOTES_INDEX_FILE);
    writeFileSync(indexPath, JSON.stringify(notes, null, 2), 'utf-8');
  }

  private noteFilePath(id: string): string {
    return join(this.notesDir, `${id}.md`);
  }

  private readNoteContent(id: string): string | null {
    const fp = this.noteFilePath(id);
    try {
      if (existsSync(fp)) {
        return readFileSync(fp, 'utf-8');
      }
    } catch {
      // corrupted file
    }
    return null;
  }

  private writeNoteContent(id: string, content: string): void {
    writeFileSync(this.noteFilePath(id), content, 'utf-8');
  }

  // ── CRUD ──

  /**
   * Create a new scratchpad note. Content is stored as a markdown file;
   * metadata is kept in the index.
   */
  create(input: NoteCreateInput): ScratchNote {
    const now = Date.now();
    const autoTags = input.contextFiles ? autoTagFromFiles(input.contextFiles) : [];
    const mergedTags = Array.from(new Set((input.tags ?? []).concat(autoTags))).sort();

    const note: ScratchNote = {
      id: randomUUID(),
      title: input.title,
      content: input.content,
      tags: mergedTags,
      createdAt: now,
      updatedAt: now,
      contextFiles: input.contextFiles ?? [],
      projectRoot: this.projectRoot,
      injectIntoContext: input.injectIntoContext ?? false,
    };

    const index = this.readIndex();
    index.push(note);
    this.writeIndex(index);
    this.writeNoteContent(note.id, input.content);

    return note;
  }

  /** Read a single note by ID. */
  read(id: string): ScratchNote | null {
    const index = this.readIndex();
    const entry = index.find((n) => n.id === id);
    if (!entry) return null;

    const content = this.readNoteContent(id);
    if (content === null) return null;

    return { ...entry, content };
  }

  /** Update note metadata and/or content. */
  update(id: string, input: NoteUpdateInput): ScratchNote | null {
    const index = this.readIndex();
    const idx = index.findIndex((n) => n.id === id);
    if (idx === -1) return null;

    const existing = index[idx];
    const now = Date.now();

    if (input.content !== undefined) {
      this.writeNoteContent(id, input.content);
    }

    const newTags = input.tags ?? existing.tags;
    const newContextFiles = input.contextFiles ?? existing.contextFiles;
    const autoTags = input.contextFiles ? autoTagFromFiles(newContextFiles) : [];
    const mergedTags = Array.from(new Set(newTags.concat(autoTags))).sort();

    const updated: ScratchNote = {
      ...existing,
      title: input.title ?? existing.title,
      content: input.content ?? existing.content,
      tags: mergedTags,
      contextFiles: newContextFiles,
      injectIntoContext: input.injectIntoContext ?? existing.injectIntoContext,
      updatedAt: now,
    };

    index[idx] = updated;
    this.writeIndex(index);

    return updated;
  }

  /** Delete a note by ID. */
  delete(id: string): boolean {
    const index = this.readIndex();
    const idx = index.findIndex((n) => n.id === id);
    if (idx === -1) return false;

    index.splice(idx, 1);
    this.writeIndex(index);

    const fp = this.noteFilePath(id);
    try {
      if (existsSync(fp)) unlinkSync(fp);
    } catch {
      // file missing, fine
    }

    return true;
  }

  // ── query ──

  /**
   * List notes with optional filtering and sorting.
   */
  list(query?: NoteQuery): ScratchNote[] {
    let notes = this.readIndex();
    const q = query ?? {};

    if (q.tag) {
      notes = notes.filter((n) => n.tags.includes(q.tag!));
    }

    if (q.contextFile) {
      notes = notes.filter((n) =>
        n.contextFiles.some((cf) => cf.includes(q.contextFile!)),
      );
    }

    if (q.search) {
      const lower = q.search.toLowerCase();
      notes = notes.filter((n) => {
        if (n.title.toLowerCase().includes(lower)) return true;
        const content = this.readNoteContent(n.id);
        return content ? content.toLowerCase().includes(lower) : false;
      });
    }

    const sortBy = q.sortBy ?? 'updatedAt';
    const sortDir = q.sortDir ?? 'desc';
    notes.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'title') {
        cmp = a.title.localeCompare(b.title);
      } else {
        cmp = (a[sortBy] as number) - (b[sortBy] as number);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    const offset = q.offset ?? 0;
    const limit = q.limit ?? notes.length;
    return notes.slice(offset, offset + limit);
  }

  /**
   * Return all notes that are set to be injected into AI context.
   */
  getContextInjections(currentFiles?: string[]): ContextInjection[] {
    const notes = this.readIndex().filter((n) => n.injectIntoContext);

    return notes.map((n) => {
      const content = this.readNoteContent(n.id) ?? '';
      const snippet =
        content.length > MAX_CONTEXT_SNIPPET_LENGTH
          ? content.slice(0, MAX_CONTEXT_SNIPPET_LENGTH) + '\n\n[truncated]'
          : content;

      // Compute relevance score: how many current files overlap with note's context files
      let relevanceScore = 0;
      if (currentFiles && n.contextFiles.length > 0) {
        const overlap = n.contextFiles.filter((cf) =>
          currentFiles.some((f) => f.includes(cf) || cf.includes(f)),
        ).length;
        relevanceScore = overlap / Math.max(n.contextFiles.length, 1);
      }

      return {
        noteId: n.id,
        title: n.title,
        snippet,
        relevanceScore,
      };
    });
  }

  /**
   * Build a compact context block that can be prepended to AI prompts.
   */
  buildContextBlock(currentFiles?: string[]): string {
    const injections = this.getContextInjections(currentFiles);
    if (injections.length === 0) return '';

    const sorted = injections.sort((a, b) => b.relevanceScore - a.relevanceScore);

    const lines: string[] = ['<!-- NOTEPAD CONTEXT INJECTION -->'];
    lines.push('> The user has the following scratchpad notes relevant to this task:');
    lines.push('');

    for (const inj of sorted) {
      lines.push(`### ${inj.title} (relevance: ${(inj.relevanceScore * 100).toFixed(0)}%)`);
      lines.push('');
      lines.push(inj.snippet);
      lines.push('');
    }

    lines.push('<!-- END NOTEPAD CONTEXT -->');
    return lines.join('\n');
  }

  // ── bulk ──

  /** Get total note count. */
  count(): number {
    return this.readIndex().length;
  }

  /** Get all unique tags across all notes. */
  allTags(): string[] {
    const notes = this.readIndex();
    const tags = new Set<string>();
    for (const n of notes) {
      for (const t of n.tags) tags.add(t);
    }
    return Array.from(tags).sort();
  }

  /** Export all notes as a single markdown document. */
  exportAll(): string {
    const notes = this.readIndex().sort((a, b) => b.updatedAt - a.updatedAt);
    const parts: string[] = ['# Scratchpad Export', `Exported: ${new Date().toISOString()}`, ''];

    for (const n of notes) {
      const content = this.readNoteContent(n.id) ?? '';
      parts.push(`## ${n.title}`);
      parts.push(`- **ID**: \`${n.id}\``);
      parts.push(`- **Tags**: ${n.tags.join(', ') || '(none)'}`);
      parts.push(`- **Created**: ${new Date(n.createdAt).toISOString()}`);
      parts.push(`- **Updated**: ${new Date(n.updatedAt).toISOString()}`);
      parts.push('');
      parts.push(content);
      parts.push('');
      parts.push('---');
      parts.push('');
    }

    return parts.join('\n');
  }

  /** Delete all notes (dangerous — intended for project cleanup). */
  deleteAll(): number {
    const notes = this.readIndex();
    for (const n of notes) {
      const fp = this.noteFilePath(n.id);
      try {
        if (existsSync(fp)) unlinkSync(fp);
      } catch {
        // skip
      }
    }
    this.writeIndex([]);
    return notes.length;
  }
}

// ──────────────────────────────────────────────
// Singleton factory
// ──────────────────────────────────────────────

const instances = new Map<string, ScratchpadManager>();

/**
 * Get or create a ScratchpadManager for the given project root.
 */
export function getScratchpadManager(projectRoot: string): ScratchpadManager {
  let mgr = instances.get(projectRoot);
  if (!mgr) {
    mgr = new ScratchpadManager(projectRoot);
    instances.set(projectRoot, mgr);
  }
  return mgr;
}
