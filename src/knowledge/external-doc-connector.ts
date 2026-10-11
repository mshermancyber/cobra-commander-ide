/**
 * GAP-030: Knowledge Bases from External Docs
 *
 * Notion API client (blocks/pages), Confluence REST client, incremental sync
 * scheduler, and chunked embedding pipeline.
 *
 * Implements the DocConnector interface from core/knowledge-base.ts for
 * pluggable external documentation ingestion.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DocConnector, ContentChunk, ChunkOptions } from '../core/knowledge-base.js';
import { ContentChunker } from '../core/knowledge-base.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface NotionBlock {
  object: 'block';
  id: string;
  type: string;
  created_time: string;
  last_edited_time: string;
  has_children: boolean;
  [blockType: string]: unknown;
}

export interface NotionPage {
  object: 'page';
  id: string;
  created_time: string;
  last_edited_time: string;
  url: string;
  properties: Record<string, NotionProperty>;
  parent: { type: string; [key: string]: unknown };
}

export interface NotionProperty {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface NotionDatabaseQuery {
  database_id: string;
  filter?: Record<string, unknown>;
  sorts?: Array<{ property: string; direction: 'ascending' | 'descending' }>;
  start_cursor?: string;
  page_size?: number;
}

export interface ConfluencePage {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  body?: {
    storage?: { value: string; representation: string };
    view?: { value: string; representation: string };
  };
  _links?: { self: string; webui?: string };
  history?: {
    lastUpdated?: { when: string };
    createdDate?: string;
  };
  ancestors?: Array<{ id: string }>;
}

export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: string;
  _links?: { webui?: string };
}

export interface SyncSchedule {
  /** Unique schedule ID */
  id: string;
  /** Source connector name */
  connectorName: string;
  /** Cron-like interval: every N minutes */
  intervalMinutes: number;
  /** Whether the schedule is active */
  enabled: boolean;
  /** Last sync timestamp */
  lastSyncAt?: number;
  /** Next scheduled sync */
  nextSyncAt: number;
  /** Space/database to sync */
  target: string;
  /** Number of docs synced last run */
  lastDocCount: number;
  /** Whether to do full re-sync or incremental */
  fullSync: boolean;
}

export interface SyncResult {
  scheduleId: string;
  startedAt: number;
  completedAt: number;
  documentsAdded: number;
  documentsUpdated: number;
  documentsRemoved: number;
  errors: string[];
  cursorState?: string;
}

export interface EmbeddingPipelineConfig {
  /** Chunk size in characters */
  chunkSize: number;
  /** Chunk overlap */
  chunkOverlap: number;
  /** Embedding dimensions */
  embeddingDimensions: number;
  /** Batch size for embedding generation */
  batchSize: number;
  /** Max concurrent embedding requests */
  concurrency: number;
}

export interface DocumentChange {
  id: string;
  title: string;
  changeType: 'added' | 'modified' | 'removed';
  timestamp: number;
  content?: string;
  metadata?: Record<string, string>;
}

// ─── NotionApiClient ───────────────────────────────────────────────────────

export class NotionApiClient implements DocConnector {
  readonly name = 'notion';
  readonly sourceType = 'api';

  private apiKey: string;
  private baseUrl = 'https://api.notion.com/v1';
  private notionVersion = '2022-06-28';
  private rateLimitPerMin: number;
  private lastRequestTime = 0;
  private minRequestInterval: number;

  constructor(options: { apiKey: string; rateLimitPerMin?: number }) {
    this.apiKey = options.apiKey;
    this.rateLimitPerMin = options.rateLimitPerMin || 60;
    this.minRequestInterval = 60_000 / this.rateLimitPerMin;
  }

  async connect(): Promise<boolean> {
    // Verify API key by fetching a simple endpoint
    try {
      const resp = await this.request('/users/me');
      return resp.ok;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    // No persistent connection to close
  }

  /**
   * List all pages in a database.
   */
  async listDocuments(databaseId?: string): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
    if (!databaseId) return [];

    const pages: Array<{ id: string; title: string; updatedAt: number }> = [];
    let cursor: string | undefined;

    do {
      const body: NotionDatabaseQuery = {
        database_id: databaseId,
        page_size: 100,
      };
      if (cursor) body.start_cursor = cursor;

      const resp = await this.request(`/databases/${databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!resp.ok) break;

      const data = await resp.json() as {
        results: NotionPage[];
        has_more: boolean;
        next_cursor: string | null;
      };

      for (const page of data.results) {
        const title = this.extractPageTitle(page);
        const updatedAt = new Date(page.last_edited_time).getTime();
        pages.push({ id: page.id, title, updatedAt });
      }

      cursor = data.next_cursor ?? undefined;
    } while (cursor);

    return pages;
  }

  /**
   * Fetch a single page with all its content.
   */
  async fetchDocument(pageId: string): Promise<{ title: string; content: string; metadata: Record<string, string> }> {
    // Fetch page metadata
    const pageResp = await this.request(`/pages/${pageId}`);
    if (!pageResp.ok) throw new Error(`Failed to fetch page ${pageId}: ${pageResp.status}`);

    const page = await pageResp.json() as NotionPage;
    const title = this.extractPageTitle(page);

    // Fetch all blocks
    const blocks = await this.fetchAllBlocks(pageId);
    const content = this.blocksToMarkdown(blocks);

    return {
      title,
      content,
      metadata: {
        id: page.id,
        url: page.url,
        createdTime: page.created_time,
        lastEditedTime: page.last_edited_time,
        sourceType: 'notion',
      },
    };
  }

  /**
   * Fetch all documents (pages) from a database.
   */
  async *fetchAll(databaseId?: string): AsyncGenerator<{ title: string; content: string; metadata: Record<string, string> }> {
    if (!databaseId) return;

    const pages = await this.listDocuments(databaseId);
    for (const page of pages) {
      try {
        const doc = await this.fetchDocument(page.id);
        yield doc;
      } catch {
        // Skip failed pages
      }
    }
  }

  /**
   * Fetch all blocks for a page (including nested children).
   */
  async fetchAllBlocks(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;

    do {
      const url = `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
      const resp = await this.request(url);

      if (!resp.ok) break;

      const data = await resp.json() as {
        results: NotionBlock[];
        has_more: boolean;
        next_cursor: string | null;
      };

      for (const block of data.results) {
        blocks.push(block);

        // Recursively fetch nested blocks
        if (block.has_children) {
          const children = await this.fetchAllBlocks(block.id);
          blocks.push(...children);
        }
      }

      cursor = data.next_cursor ?? undefined;
    } while (cursor);

    return blocks;
  }

  // ── Helpers ──────────────────────────────────

  private extractPageTitle(page: NotionPage): string {
    for (const [, prop] of Object.entries(page.properties)) {
      if (prop.type === 'title' && Array.isArray(prop.title)) {
        return (prop.title as Array<{ plain_text?: string }>)
          .map(t => t.plain_text || '')
          .join(' ')
          .trim();
      }
    }
    return 'Untitled';
  }

  private blocksToMarkdown(blocks: NotionBlock[]): string {
    const lines: string[] = [];

    for (const block of blocks) {
      const text = this.blockToText(block);
      if (!text) continue;

      switch (block.type) {
        case 'heading_1':
          lines.push(`# ${text}`);
          break;
        case 'heading_2':
          lines.push(`## ${text}`);
          break;
        case 'heading_3':
          lines.push(`### ${text}`);
          break;
        case 'bulleted_list_item':
          lines.push(`- ${text}`);
          break;
        case 'numbered_list_item':
          lines.push(`1. ${text}`);
          break;
        case 'to_do':
          lines.push(`- [ ] ${text}`);
          break;
        case 'code':
          lines.push('```');
          lines.push(text);
          lines.push('```');
          break;
        case 'quote':
          lines.push(`> ${text}`);
          break;
        case 'callout':
          lines.push(`> **Note:** ${text}`);
          break;
        case 'divider':
          lines.push('---');
          break;
        default:
          lines.push(text);
      }
    }

    return lines.join('\n\n');
  }

  private blockToText(block: NotionBlock): string {
    const blockContent = block[block.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
    if (blockContent?.rich_text && Array.isArray(blockContent.rich_text)) {
      return blockContent.rich_text.map(t => t.plain_text || '').join('');
    }
    return '';
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    // Rate limit
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
    }
    this.lastRequestTime = Date.now();

    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Notion-Version': this.notionVersion,
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
  }
}

// ─── ConfluenceRestClient ──────────────────────────────────────────────────

export class ConfluenceRestClient implements DocConnector {
  readonly name = 'confluence';
  readonly sourceType = 'api';

  private baseUrl: string;
  private email: string;
  private apiToken: string;
  private authHeader: string;
  private rateLimitPerMin: number;
  private lastRequestTime = 0;
  private minRequestInterval: number;

  constructor(options: {
    baseUrl: string;
    email: string;
    apiToken: string;
    rateLimitPerMin?: number;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.email = options.email;
    this.apiToken = options.apiToken;
    this.authHeader = `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString('base64')}`;
    this.rateLimitPerMin = options.rateLimitPerMin || 30;
    this.minRequestInterval = 60_000 / this.rateLimitPerMin;
  }

  async connect(): Promise<boolean> {
    try {
      const resp = await this.request('/rest/api/space');
      return resp.ok;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    // No persistent connection
  }

  /**
   * List all pages in a space.
   */
  async listDocuments(spaceKey?: string): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
    if (!spaceKey) return [];

    const pages: Array<{ id: string; title: string; updatedAt: number }> = [];
    let start = 0;
    const limit = 50;

    while (true) {
      const resp = await this.request(
        `/rest/api/content?spaceKey=${spaceKey}&limit=${limit}&start=${start}&expand=version`,
      );
      if (!resp.ok) break;

      const data = await resp.json() as {
        results: ConfluencePage[];
        size: number;
      };

      for (const page of data.results) {
        const updatedAt = page.history?.lastUpdated?.when
          ? new Date(page.history.lastUpdated.when).getTime()
          : Date.now();
        pages.push({ id: page.id, title: page.title, updatedAt });
      }

      if (data.results.length < limit) break;
      start += limit;
    }

    return pages;
  }

  /**
   * List all spaces accessible to the user.
   */
  async listSpaces(): Promise<ConfluenceSpace[]> {
    const spaces: ConfluenceSpace[] = [];
    let start = 0;
    const limit = 50;

    while (true) {
      const resp = await this.request(`/rest/api/space?limit=${limit}&start=${start}`);
      if (!resp.ok) break;

      const data = await resp.json() as {
        results: ConfluenceSpace[];
        size: number;
      };

      spaces.push(...data.results);
      if (data.results.length < limit) break;
      start += limit;
    }

    return spaces;
  }

  /**
   * Fetch a single page with rendered content.
   */
  async fetchDocument(pageId: string): Promise<{ title: string; content: string; metadata: Record<string, string> }> {
    const resp = await this.request(
      `/rest/api/content/${pageId}?expand=body.storage,body.view,version,space,history,ancestors`,
    );
    if (!resp.ok) throw new Error(`Failed to fetch Confluence page ${pageId}: ${resp.status}`);

    const page = await resp.json() as ConfluencePage;

    // Get content: prefer storage format, fall back to view
    let htmlContent = page.body?.storage?.value || page.body?.view?.value || '';

    // Strip HTML to plain text
    const content = this.stripHtml(htmlContent);

    return {
      title: page.title,
      content,
      metadata: {
        id: page.id,
        spaceKey: page.spaceKey,
        version: String(page.version),
        url: page._links?.webui ? `${this.baseUrl}${page._links.webui}` : '',
        lastUpdated: page.history?.lastUpdated?.when || '',
        sourceType: 'confluence',
      },
    };
  }

  /**
   * Fetch all documents from a space.
   */
  async *fetchAll(spaceKey?: string): AsyncGenerator<{ title: string; content: string; metadata: Record<string, string> }> {
    if (!spaceKey) return;

    const pages = await this.listDocuments(spaceKey);
    for (const page of pages) {
      try {
        const doc = await this.fetchDocument(page.id);
        yield doc;
      } catch {
        // Skip failed pages
      }
    }
  }

  /**
   * Search Confluence content using CQL.
   */
  async searchCQL(cql: string, limit = 25): Promise<Array<{ title: string; content: string; metadata: Record<string, string> }>> {
    const resp = await this.request(
      `/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=body.storage`,
    );
    if (!resp.ok) return [];

    const data = await resp.json() as {
      results: ConfluencePage[];
    };

    return data.results.map(page => {
      const htmlContent = page.body?.storage?.value || '';
      return {
        title: page.title,
        content: this.stripHtml(htmlContent),
        metadata: {
          id: page.id,
          spaceKey: page.spaceKey || '',
          url: page._links?.webui ? `${this.baseUrl}${page._links.webui}` : '',
          sourceType: 'confluence',
        },
      };
    });
  }

  // ── Helpers ──────────────────────────────────

  private stripHtml(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
    }
    this.lastRequestTime = Date.now();

    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        ...(init?.headers || {}),
      },
    });
  }
}

// ─── IncrementalSyncScheduler ──────────────────────────────────────────────

export class IncrementalSyncScheduler {
  private schedules: Map<string, SyncSchedule> = new Map();
  private storagePath: string;
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private running = false;
  private stateDir: string;

  constructor(storageDir?: string) {
    this.stateDir = storageDir || join(process.cwd(), '.cobra-commander', 'sync-scheduler');
    this.storagePath = join(this.stateDir, 'schedules.json');
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
    this.loadSchedules();
  }

  /**
   * Add a sync schedule.
   */
  addSchedule(schedule: Omit<SyncSchedule, 'id' | 'nextSyncAt' | 'lastDocCount'> & { id?: string }): SyncSchedule {
    const id = schedule.id || `sync-${randomUUID().slice(0, 8)}`;
    const full: SyncSchedule = {
      id,
      ...schedule,
      nextSyncAt: Date.now() + schedule.intervalMinutes * 60_000,
      lastDocCount: 0,
    };

    this.schedules.set(id, full);
    this.saveSchedules();

    if (this.running && full.enabled) {
      this.startScheduleTimer(full);
    }

    return full;
  }

  /**
   * Remove a schedule.
   */
  removeSchedule(id: string): boolean {
    this.stopScheduleTimer(id);
    const removed = this.schedules.delete(id);
    if (removed) this.saveSchedules();
    return removed;
  }

  /**
   * Get a schedule by ID.
   */
  getSchedule(id: string): SyncSchedule | undefined {
    return this.schedules.get(id);
  }

  /**
   * List all schedules.
   */
  listSchedules(): SyncSchedule[] {
    return Array.from(this.schedules.values());
  }

  /**
   * Enable or disable a schedule.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const schedule = this.schedules.get(id);
    if (!schedule) return false;
    schedule.enabled = enabled;
    this.saveSchedules();

    if (this.running) {
      if (enabled) this.startScheduleTimer(schedule);
      else this.stopScheduleTimer(id);
    }

    return true;
  }

  /**
   * Start the scheduler — begin running all enabled schedules.
   */
  start(): void {
    this.running = true;
    for (const [, schedule] of this.schedules) {
      if (schedule.enabled) {
        this.startScheduleTimer(schedule);
      }
    }
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    this.running = false;
    for (const [id] of this.timers) {
      this.stopScheduleTimer(id);
    }
  }

  /**
   * Manually trigger a sync.
   */
  async triggerSync(
    id: string,
    connector: DocConnector,
  ): Promise<SyncResult> {
    const schedule = this.schedules.get(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);

    const result: SyncResult = {
      scheduleId: id,
      startedAt: Date.now(),
      completedAt: 0,
      documentsAdded: 0,
      documentsUpdated: 0,
      documentsRemoved: 0,
      errors: [],
    };

    try {
      const connected = await connector.connect();
      if (!connected) {
        result.errors.push('Failed to connect');
        return result;
      }

      try {
        for await (const doc of connector.fetchAll()) {
          // The caller is responsible for actual ingestion;
          // this scheduler just coordinates the sync timing
          result.documentsAdded++;
        }
      } finally {
        await connector.disconnect();
      }
    } catch (err) {
      result.errors.push((err as Error).message);
    }

    result.completedAt = Date.now();
    schedule.lastSyncAt = result.completedAt;
    schedule.lastDocCount = result.documentsAdded;
    schedule.nextSyncAt = Date.now() + schedule.intervalMinutes * 60_000;
    this.saveSchedules();

    return result;
  }

  /**
   * Get the last known changes since a cursor.
   */
  async getChanges(
    connector: DocConnector,
    since?: number,
  ): Promise<DocumentChange[]> {
    const changes: DocumentChange[] = [];
    const sinceTime = since || 0;

    try {
      const connected = await connector.connect();
      if (!connected) return changes;

      try {
        const docs = await connector.listDocuments();
        for (const doc of docs) {
          if (doc.updatedAt > sinceTime) {
            changes.push({
              id: doc.id,
              title: doc.title,
              changeType: 'modified',
              timestamp: doc.updatedAt,
            });
          }
        }
      } finally {
        await connector.disconnect();
      }
    } catch {
      // Connection error
    }

    return changes;
  }

  // ── Private ───────────────────────────────────

  private startScheduleTimer(schedule: SyncSchedule): void {
    this.stopScheduleTimer(schedule.id);

    const delay = Math.max(0, schedule.nextSyncAt - Date.now());
    const timer = setInterval(() => {
      if (!schedule.enabled) {
        this.stopScheduleTimer(schedule.id);
        return;
      }
      // Trigger is called externally with a connector
      schedule.nextSyncAt = Date.now() + schedule.intervalMinutes * 60_000;
    }, schedule.intervalMinutes * 60_000);

    // Set initial delay
    setTimeout(() => {
      if (schedule.enabled && this.running) {
        schedule.nextSyncAt = Date.now() + schedule.intervalMinutes * 60_000;
      }
    }, delay);

    this.timers.set(schedule.id, timer);
    if (timer.unref) timer.unref();
  }

  private stopScheduleTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }

  private loadSchedules(): void {
    if (!existsSync(this.storagePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.storagePath, 'utf-8'));
      for (const [, s] of Object.entries(data)) {
        const schedule = s as SyncSchedule;
        this.schedules.set(schedule.id, schedule);
      }
    } catch { /* corrupt file */ }
  }

  private saveSchedules(): void {
    const data: Record<string, SyncSchedule> = {};
    for (const [id, s] of this.schedules) data[id] = s;
    writeFileSync(this.storagePath, JSON.stringify(data, null, 2));
  }
}

// ─── ChunkedEmbeddingPipeline ──────────────────────────────────────────────

export class ChunkedEmbeddingPipeline {
  private config: EmbeddingPipelineConfig;
  private chunker: ContentChunker;
  private embeddingCache: Map<string, number[]> = new Map();
  private cacheDir: string;

  constructor(config?: Partial<EmbeddingPipelineConfig>, cacheDir?: string) {
    this.config = {
      chunkSize: config?.chunkSize || 512,
      chunkOverlap: config?.chunkOverlap || 64,
      embeddingDimensions: config?.embeddingDimensions || 128,
      batchSize: config?.batchSize || 32,
      concurrency: config?.concurrency || 4,
    };

    this.chunker = new ContentChunker({
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
    });

    this.cacheDir = cacheDir || join(process.cwd(), '.cobra-commander', 'embedding-cache');
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
    this.loadCache();
  }

  /**
   * Process a document through the chunking and embedding pipeline.
   * Returns chunks with embeddings attached.
   */
  async processDocument(
    content: string,
    metadata: Record<string, string> = {},
  ): Promise<ContentChunk[]> {
    // Step 1: Chunk
    const chunks = this.chunker.chunk(content, metadata);

    // Step 2: Generate embeddings in batches
    for (let i = 0; i < chunks.length; i += this.config.batchSize) {
      const batch = chunks.slice(i, i + this.config.batchSize);
      const batchTexts = batch.map(c => c.text);

      const embeddings = await this.generateEmbeddingsBatch(batchTexts);

      for (let j = 0; j < batch.length; j++) {
        batch[j].embedding = embeddings[j];
      }
    }

    this.saveCache();
    return chunks;
  }

  /**
   * Process multiple documents concurrently.
   */
  async processDocuments(
    documents: Array<{ content: string; metadata: Record<string, string> }>,
  ): Promise<ContentChunk[][]> {
    const results: ContentChunk[][] = [];

    // Process in concurrent batches
    for (let i = 0; i < documents.length; i += this.config.concurrency) {
      const batch = documents.slice(i, i + this.config.concurrency);
      const batchResults = await Promise.all(
        batch.map(doc => this.processDocument(doc.content, doc.metadata)),
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Generate an embedding for a single text.
   */
  async embedText(text: string): Promise<number[]> {
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const cached = this.embeddingCache.get(hash);
    if (cached) return cached;

    const embedding = await this.computeEmbedding(text);
    this.embeddingCache.set(hash, embedding);
    return embedding;
  }

  /**
   * Get the chunker instance.
   */
  getChunker(): ContentChunker {
    return this.chunker;
  }

  /**
   * Get pipeline configuration.
   */
  getConfig(): EmbeddingPipelineConfig {
    return { ...this.config };
  }

  /**
   * Clear the embedding cache.
   */
  clearCache(): void {
    this.embeddingCache.clear();
    this.saveCache();
  }

  // ── Private ───────────────────────────────────

  private async generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    // Check cache and compute in parallel
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const toCompute: Array<{ index: number; text: string }> = [];

    for (let i = 0; i < texts.length; i++) {
      const hash = createHash('sha256').update(texts[i]).digest('hex').slice(0, 16);
      const cached = this.embeddingCache.get(hash);
      if (cached) {
        results[i] = cached;
      } else {
        toCompute.push({ index: i, text: texts[i] });
      }
    }

    // Compute missing embeddings
    if (toCompute.length > 0) {
      const computed = await Promise.all(
        toCompute.map(item => this.computeEmbedding(item.text)),
      );

      for (let j = 0; j < toCompute.length; j++) {
        const { index, text } = toCompute[j];
        results[index] = computed[j];
        const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
        this.embeddingCache.set(hash, computed[j]);
      }
    }

    return results as number[][];
  }

  private async computeEmbedding(text: string): Promise<number[]> {
    const dims = this.config.embeddingDimensions;
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

  private loadCache(): void {
    const cachePath = join(this.cacheDir, 'embeddings.json');
    if (!existsSync(cachePath)) return;
    try {
      const data = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, number[]>;
      for (const [key, vec] of Object.entries(data)) {
        this.embeddingCache.set(key, vec);
      }
    } catch { /* corrupt cache */ }
  }

  private saveCache(): void {
    const cachePath = join(this.cacheDir, 'embeddings.json');
    const data: Record<string, number[]> = {};
    for (const [key, vec] of this.embeddingCache) {
      data[key] = vec;
    }
    writeFileSync(cachePath, JSON.stringify(data));
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let defaultPipeline: ChunkedEmbeddingPipeline | null = null;

export function getEmbeddingPipeline(): ChunkedEmbeddingPipeline {
  if (!defaultPipeline) defaultPipeline = new ChunkedEmbeddingPipeline();
  return defaultPipeline;
}

export function initEmbeddingPipeline(config?: Partial<EmbeddingPipelineConfig>): ChunkedEmbeddingPipeline {
  defaultPipeline = new ChunkedEmbeddingPipeline(config);
  return defaultPipeline;
}
