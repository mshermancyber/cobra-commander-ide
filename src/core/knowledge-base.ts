import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface KnowledgeBaseEntry {
  id: string;
  source: string;
  title: string;
  content: string;
  chunks: ContentChunk[];
  embeddings?: number[][];
  metadata: Record<string, string>;
  ingestedAt: number;
  lastUpdated: number;
}

export interface ContentChunk {
  id: string;
  text: string;
  index: number;
  embedding?: number[];
  metadata: Record<string, string>;
}

export interface DocConnectorOptions {
  baseUrl?: string;
  apiKey?: string;
  rateLimitPerMin?: number;
  maxPages?: number;
  followLinks?: boolean;
  sameDomain?: boolean;
}

export interface CrawlResult {
  url: string;
  title: string;
  content: string;
  contentType: string;
  links: string[];
  crawledAt: number;
}

export interface ChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
}

export interface SearchResult {
  entryId: string;
  chunkId: string;
  score: number;
  content: string;
  title: string;
  source: string;
  metadata: Record<string, string>;
}

// ─── DocConnector Interface ────────────────────────────────────────────────

export interface DocConnector {
  readonly name: string;
  readonly sourceType: string;
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  listDocuments(): Promise<Array<{ id: string; title: string; updatedAt: number }>>;
  fetchDocument(id: string): Promise<{ title: string; content: string; metadata: Record<string, string> }>;
  fetchAll(): AsyncGenerator<{ title: string; content: string; metadata: Record<string, string> }>;
}

// ─── WebCrawler ─────────────────────────────────────────────────────────────

export class WebCrawler {
  private visited = new Set<string>();
  private queue: Array<{ url: string; depth: number }> = [];
  private results: CrawlResult[] = [];
  private rateLimiter: { lastFetch: number; minInterval: number };
  private userAgent: string;
  private maxDepth: number;
  private maxPages: number;
  private sameDomain: boolean;
  private baseDomain: string;
  private robotsCache = new Map<string, Set<string>>();

  constructor(options: DocConnectorOptions = {}) {
    this.maxDepth = 3;
    this.maxPages = options.maxPages || 100;
    this.sameDomain = options.sameDomain !== false;
    this.baseDomain = '';
    this.userAgent = 'CobraCommander/1.0 (knowledge-base-crawler)';
    this.rateLimiter = {
      lastFetch: 0,
      minInterval: 60_000 / (options.rateLimitPerMin || 30),
    };
  }

  /** Parse robots.txt and return disallowed paths for the given URL. */
  private async fetchRobotsTxt(origin: string): Promise<Set<string>> {
    if (this.robotsCache.has(origin)) return this.robotsCache.get(origin)!;

    try {
      const resp = await fetch(`${origin}/robots.txt`, {
        headers: { 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        this.robotsCache.set(origin, new Set());
        return new Set();
      }
      const text = await resp.text();
      const disallowed = new Set<string>();
      let inAgentBlock = false;

      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.toLowerCase() === 'user-agent: *' || trimmed.toLowerCase() === `user-agent: ${this.userAgent.toLowerCase()}`) {
          inAgentBlock = true;
        } else if (trimmed.startsWith('user-agent:')) {
          inAgentBlock = false;
        } else if (inAgentBlock && trimmed.toLowerCase().startsWith('disallow:')) {
          const path = trimmed.slice(9).trim();
          if (path) disallowed.add(path);
        }
      }

      this.robotsCache.set(origin, disallowed);
      return disallowed;
    } catch {
      const empty = new Set<string>();
      this.robotsCache.set(origin, empty);
      return empty;
    }
  }

  /** Check if a URL path is allowed by robots.txt. */
  async isAllowed(url: string): Promise<boolean> {
    try {
      const u = new URL(url);
      const disallowed = await this.fetchRobotsTxt(u.origin);
      for (const path of disallowed) {
        if (u.pathname.startsWith(path)) return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /** Rate-limited fetch helper. */
  private async rateLimitedFetch(url: string): Promise<Response> {
    const elapsed = Date.now() - this.rateLimiter.lastFetch;
    if (elapsed < this.rateLimiter.minInterval) {
      await new Promise(r => setTimeout(r, this.rateLimiter.minInterval - elapsed));
    }
    this.rateLimiter.lastFetch = Date.now();
    return fetch(url, {
      headers: { 'User-Agent': this.userAgent },
      signal: AbortSignal.timeout(15000),
    });
  }

  /** Extract links from HTML content. */
  private extractLinks(html: string, baseUrl: string): string[] {
    const links: string[] = [];
    const hrefRegex = /<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["']/gi;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
      try {
        const resolved = new URL(match[1], baseUrl).toString();
        if (resolved.startsWith('http')) links.push(resolved);
      } catch { /* skip bad URLs */ }
    }
    return [...new Set(links)];
  }

  /** Extract title from HTML. */
  private extractTitle(html: string): string {
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim() : 'Untitled';
  }

  /** Simple HTML-to-text extraction. */
  htmlToText(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Crawl starting from a URL. */
  async crawl(startUrl: string): Promise<CrawlResult[]> {
    const parsed = new URL(startUrl);
    this.baseDomain = parsed.hostname;
    this.visited.clear();
    this.queue = [{ url: startUrl, depth: 0 }];
    this.results = [];

    while (this.queue.length > 0 && this.results.length < this.maxPages) {
      const { url, depth } = this.queue.shift()!;

      if (this.visited.has(url)) continue;
      if (depth > this.maxDepth) continue;
      this.visited.add(url);

      // Check robots.txt
      if (!(await this.isAllowed(url))) continue;

      try {
        const resp = await this.rateLimitedFetch(url);
        if (!resp.ok) continue;

        const contentType = resp.headers.get('content-type') || '';
        const raw = await resp.text();

        let content = raw;
        let title = this.extractTitle(raw);
        const links: string[] = [];

        if (contentType.includes('text/html')) {
          content = this.htmlToText(raw);
          links.push(...this.extractLinks(raw, url));
        }

        this.results.push({
          url,
          title,
          content,
          contentType,
          links,
          crawledAt: Date.now(),
        });

        // Enqueue links
        if (depth < this.maxDepth) {
          for (const link of links) {
            try {
              const linkParsed = new URL(link);
              if (this.sameDomain && linkParsed.hostname !== this.baseDomain) continue;
              if (!this.visited.has(link)) {
                this.queue.push({ url: link, depth: depth + 1 });
              }
            } catch { /* skip */ }
          }
        }
      } catch {
        /* skip failed URL */
      }
    }

    return this.results;
  }

  getResults(): CrawlResult[] {
    return this.results;
  }
}

// ─── ContentChunker ─────────────────────────────────────────────────────────

const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  chunkSize: 512,
  chunkOverlap: 64,
  separators: ['\n\n', '\n', '. ', ' ', ''],
};

export class ContentChunker {
  private options: ChunkOptions;

  constructor(options?: Partial<ChunkOptions>) {
    this.options = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  }

  /** Recursively split text using separators. */
  private splitText(text: string, separators: string[], chunkSize: number): string[] {
    const separator = separators[0] || '';
    const nextSeparators = separators.slice(1);

    if (!separator) {
      // Force split by chunkSize
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
      }
      return chunks;
    }

    const parts = text.split(separator);
    const chunks: string[] = [];
    let current = '';

    for (const part of parts) {
      if (current.length + part.length + separator.length <= chunkSize) {
        current += (current ? separator : '') + part;
      } else {
        if (current) chunks.push(current.trim());
        // If the part itself is longer than chunkSize, recurse
        if (part.length > chunkSize) {
          chunks.push(...this.splitText(part, nextSeparators, chunkSize));
        } else {
          current = part;
        }
      }
    }
    if (current) chunks.push(current.trim());

    return chunks;
  }

  /** Chunk content with overlap. */
  chunk(content: string, metadata: Record<string, string> = {}): ContentChunk[] {
    const rawChunks = this.splitText(content, this.options.separators, this.options.chunkSize);
    const chunks: ContentChunk[] = [];

    for (let i = 0; i < rawChunks.length; i++) {
      const chunkText = rawChunks[i];
      if (!chunkText.trim()) continue;

      chunks.push({
        id: createHash('sha256').update(chunkText).digest('hex').slice(0, 16),
        text: chunkText,
        index: i,
        metadata: { ...metadata, chunkIndex: String(i), totalChunks: String(rawChunks.length) },
      });
    }

    return chunks;
  }

  /** Extract simple vector embedding using bag-of-words hashing (stand-in for real embeddings). */
  static async generateEmbedding(text: string, dims: number = 128): Promise<number[]> {
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const vec = new Array(dims).fill(0);
    for (const word of words) {
      const hash = createHash('sha256').update(word).digest();
      for (let i = 0; i < dims; i++) {
        vec[i] += (hash[i % hash.length] - 127.5) / 127.5;
      }
    }
    // Normalize
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (mag > 0) {
      for (let i = 0; i < dims; i++) vec[i] /= mag;
    }
    return vec;
  }
}

// ─── KnowledgeBase ──────────────────────────────────────────────────────────

export class KnowledgeBase {
  private entries: Map<string, KnowledgeBaseEntry> = new Map();
  private storageDir: string;
  private chunker: ContentChunker;
  private connector?: DocConnector;

  constructor(storageDir?: string) {
    this.storageDir = storageDir || join(homedir(), '.cobra-commander', 'knowledge-base');
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
    this.chunker = new ContentChunker();
    this.loadFromDisk();
  }

  /** Attach a document connector for external sync. */
  setConnector(connector: DocConnector): void {
    this.connector = connector;
  }

  /** Ingest a document into the knowledge base. */
  ingest(params: {
    source: string;
    title: string;
    content: string;
    metadata?: Record<string, string>;
    generateEmbeddings?: boolean;
  }): KnowledgeBaseEntry {
    const id = `kb-${randomUUID().slice(0, 12)}`;
    const metadata = params.metadata || {};
    const chunks = this.chunker.chunk(params.content, { source: params.source, title: params.title, ...metadata });

    const entry: KnowledgeBaseEntry = {
      id,
      source: params.source,
      title: params.title,
      content: params.content,
      chunks,
      metadata,
      ingestedAt: Date.now(),
      lastUpdated: Date.now(),
    };

    this.entries.set(id, entry);
    return entry;
  }

  /** Generate embeddings for an entry's chunks. */
  async generateEmbeddings(entryId: string): Promise<void> {
    const entry = this.entries.get(entryId);
    if (!entry) return;

    for (const chunk of entry.chunks) {
      chunk.embedding = await ContentChunker.generateEmbedding(chunk.text);
    }

    this.saveToDisk();
  }

  /** Search knowledge base using simple keyword + optional embedding cosine similarity. */
  search(query: string, topK: number = 10): SearchResult[] {
    const lowerQuery = query.toLowerCase();
    const results: SearchResult[] = [];

    for (const [, entry] of this.entries) {
      for (const chunk of entry.chunks) {
        // Simple TF scoring
        const words = lowerQuery.split(/\s+/).filter(Boolean);
        let score = 0;
        const chunkLower = chunk.text.toLowerCase();
        for (const word of words) {
          const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
          const matches = chunkLower.match(regex);
          if (matches) score += matches.length;
        }

        // Normalize by chunk length
        score = score / Math.max(chunk.text.length, 1) * 1000;

        if (score > 0) {
          results.push({
            entryId: entry.id,
            chunkId: chunk.id,
            score,
            content: chunk.text.slice(0, 500),
            title: entry.title,
            source: entry.source,
            metadata: { ...entry.metadata, ...chunk.metadata },
          });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /** Semantically search using embedding similarity (requires generated embeddings). */
  async semanticSearch(query: string, topK: number = 10): Promise<SearchResult[]> {
    const queryEmbedding = await ContentChunker.generateEmbedding(query);
    const results: SearchResult[] = [];

    for (const [, entry] of this.entries) {
      for (const chunk of entry.chunks) {
        if (!chunk.embedding) continue;
        const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);

        results.push({
          entryId: entry.id,
          chunkId: chunk.id,
          score: similarity,
          content: chunk.text.slice(0, 500),
          title: entry.title,
          source: entry.source,
          metadata: { ...entry.metadata, ...chunk.metadata },
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** Sync from connected data source. */
  async syncFromConnector(): Promise<{ added: number; updated: number }> {
    if (!this.connector) return { added: 0, updated: 0 };

    let added = 0;
    let updated = 0;

    const connected = await this.connector.connect();
    if (!connected) return { added: 0, updated: 0 };

    try {
      for await (const doc of this.connector.fetchAll()) {
        // Check if we already have this
        const existing = Array.from(this.entries.values()).find(
          e => e.source === doc.metadata.id || e.title === doc.title,
        );
        if (existing) {
          existing.content = doc.content;
          existing.chunks = this.chunker.chunk(doc.content, doc.metadata);
          existing.lastUpdated = Date.now();
          updated++;
        } else {
          this.ingest({
            source: doc.metadata.id || this.connector.name,
            title: doc.title,
            content: doc.content,
            metadata: doc.metadata,
          });
          added++;
        }
      }
    } finally {
      await this.connector.disconnect();
    }

    this.saveToDisk();
    return { added, updated };
  }

  /** Get all entries. */
  listEntries(): KnowledgeBaseEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => b.lastUpdated - a.lastUpdated);
  }

  /** Get a single entry. */
  getEntry(id: string): KnowledgeBaseEntry | undefined {
    return this.entries.get(id);
  }

  /** Delete an entry. */
  deleteEntry(id: string): boolean {
    const deleted = this.entries.delete(id);
    if (deleted) this.saveToDisk();
    return deleted;
  }

  /** List sources. */
  listSources(): Array<{ name: string; count: number }> {
    const sourceCounts = new Map<string, number>();
    for (const [, entry] of this.entries) {
      sourceCounts.set(entry.source, (sourceCounts.get(entry.source) || 0) + 1);
    }
    return Array.from(sourceCounts.entries()).map(([name, count]) => ({ name, count }));
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  private getIndexPath(): string {
    return join(this.storageDir, 'kb-index.json');
  }

  private saveToDisk(): void {
    const serializable = Array.from(this.entries.values()).map(e => ({
      ...e,
      chunks: e.chunks.map(c => ({ ...c, embedding: undefined })),
      embeddings: undefined,
    }));
    writeFileSync(this.getIndexPath(), JSON.stringify(serializable, null, 2));
  }

  private loadFromDisk(): void {
    const indexPath = this.getIndexPath();
    if (!existsSync(indexPath)) return;
    try {
      const entries: KnowledgeBaseEntry[] = JSON.parse(readFileSync(indexPath, 'utf-8'));
      for (const entry of entries) {
        this.entries.set(entry.id, entry);
      }
    } catch { /* corrupt index */ }
  }
}
