import { readFileSync, writeFileSync, existsSync, mkdirSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DocSyncConfig {
  /** Notion integration token */
  notionToken?: string;
  /** Notion database IDs to sync */
  notionDatabaseIds?: string[];
  /** Confluence base URL (e.g., https://your-domain.atlassian.net) */
  confluenceBaseUrl?: string;
  /** Confluence user email */
  confluenceEmail?: string;
  /** Confluence API token */
  confluenceApiToken?: string;
  /** Confluence space keys to sync */
  confluenceSpaceKeys?: string[];
  /** Polling interval in seconds for Confluence (default 300 = 5 min) */
  pollingIntervalSec?: number;
  /** Local markdown file directory for bidirectional sync */
  localDocDir?: string;
  /** Enable Notion webhook listener */
  notionWebhookEnabled?: boolean;
  /** Notion webhook secret for verifying payloads */
  notionWebhookSecret?: string;
  /** Maximum pages per sync */
  pageLimit?: number;
}

export interface SyncedDoc {
  id: string;
  source: 'notion' | 'confluence' | 'local';
  title: string;
  url?: string;
  content: string;
  markdown: string;
  lastModified: Date;
  lastSynced: Date;
  parentId?: string;
  parentTitle?: string;
  children: string[];
  metadata: Record<string, string>;
}

export interface NotionBlock {
  id: string;
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface ConfluencePageTree {
  id: string;
  title: string;
  url: string;
  children: ConfluencePageTree[];
  version: number;
  lastModified: Date;
}

export interface SyncChange {
  docId: string;
  source: SyncedDoc['source'];
  changeType: 'created' | 'updated' | 'deleted';
  title: string;
  timestamp: number;
  oldHash?: string;
  newHash?: string;
}

export interface DocViewerState {
  currentDoc: SyncedDoc | null;
  sidebarVisible: boolean;
  sidebarDocs: Array<{ id: string; title: string; source: SyncedDoc['source'] }>;
  searchQuery: string;
  searchResults: Array<{ id: string; title: string; snippet: string }>;
}

// ─── Notion Block ↔ Markdown Engine ───────────────────────────────────────

const NOTION_BLOCK_HANDLERS: Record<string, (block: NotionBlock) => string> = {
  paragraph: (b) => richTextToString(b.paragraph?.rich_text || []) + '\n\n',
  heading_1: (b) => '# ' + richTextToString(b.heading_1?.rich_text || []) + '\n\n',
  heading_2: (b) => '## ' + richTextToString(b.heading_2?.rich_text || []) + '\n\n',
  heading_3: (b) => '### ' + richTextToString(b.heading_3?.rich_text || []) + '\n\n',
  bulleted_list_item: (b) => '- ' + richTextToString(b.bulleted_list_item?.rich_text || []) + '\n',
  numbered_list_item: (b) => '1. ' + richTextToString(b.numbered_list_item?.rich_text || []) + '\n',
  to_do: (b) => {
    const checked = b.to_do?.checked ? 'x' : ' ';
    return '- [' + checked + '] ' + richTextToString(b.to_do?.rich_text || []) + '\n';
  },
  code: (b) => {
    const lang = b.code?.language || '';
    const text = richTextToString(b.code?.rich_text || []);
    return '```' + lang + '\n' + text + '\n```\n\n';
  },
  quote: (b) => '> ' + richTextToString(b.quote?.rich_text || []) + '\n\n',
  divider: () => '---\n\n',
  image: (b) => {
    const img = (b.image || {}) as Record<string, unknown>;
    const file = (img.file || {}) as Record<string, unknown>;
    const external = (img.external || {}) as Record<string, unknown>;
    const url = (file['url'] || external['url'] || '') as string;
    const caption = richTextToString((img.caption as unknown[]) || []);
    return '![' + caption + '](' + url + ')\n\n';
  },
  callout: (b) => {
    const callout = (b.callout || {}) as Record<string, unknown>;
    const iconObj = (callout.icon || {}) as Record<string, unknown>;
    const icon = (iconObj['emoji'] || '💡') as string;
    const text = richTextToString((callout['rich_text'] as unknown[]) || []);
    return '> ' + icon + ' ' + text + '\n\n';
  },
  bookmark: (b) => {
    const url = (b.bookmark as Record<string, unknown>)?.url || '';
    const caption = richTextToString(((b.bookmark as Record<string, unknown>)?.caption as unknown[]) || []);
    return '[' + (caption || url) + '](' + url + ')\n\n';
  },
  equation: (b) => '$$\n' + ((b.equation as Record<string, unknown>)?.expression || '') + '\n$$\n\n',
  table: (b) => notionTableToMarkdown(b),
};

function notionTableToMarkdown(block: NotionBlock): string {
  const table = block.table as Record<string, unknown> | undefined;
  if (!table) return '';
  const rows = (table.children as NotionBlock[][]) || [];
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((cell) => {
      const cellContent = (cell as Record<string, unknown>);
      const cellType = cellContent.type as string;
      const cellData = cellContent[cellType] as Record<string, unknown> | undefined;
      return richTextToString((cellData?.rich_text as unknown[]) || []);
    });
    lines.push('| ' + cells.join(' | ') + ' |');
    if (i === 0) {
      lines.push('|' + cells.map(() => ' --- ').join('|') + '|');
    }
  }
  return lines.join('\n') + '\n\n';
}

export function notionBlocksToMarkdown(blocks: NotionBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const handler = NOTION_BLOCK_HANDLERS[block.type];
    if (handler) {
      parts.push(handler(block));
    } else {
      // Generic fallback: try to extract any rich_text
      for (const key of Object.keys(block)) {
        if (key === 'id' || key === 'type' || key === 'created_time' || key === 'last_edited_time') continue;
        const val = block[key] as Record<string, unknown> | undefined;
        if (val?.rich_text) {
          parts.push(richTextToString(val.rich_text as unknown[]) + '\n\n');
          break;
        }
      }
    }
  }
  return parts.join('').trim();
}

/**
 * Parse markdown back into Notion block representations.
 * This is an approximation — real Notion blocks require API calls.
 */
export function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.split('\n');
  const blocks: NotionBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    // Code fence
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        id: randomUUID(),
        type: 'code',
        code: { rich_text: [{ type: 'text', text: { content: codeLines.join('\n') } }], language: lang },
      });
      continue;
    }

    // Headings
    if (line.startsWith('### ')) {
      blocks.push(makeTextBlock('heading_3', line.slice(4)));
    } else if (line.startsWith('## ')) {
      blocks.push(makeTextBlock('heading_2', line.slice(3)));
    } else if (line.startsWith('# ')) {
      blocks.push(makeTextBlock('heading_1', line.slice(2)));
    } else if (line.startsWith('- [ ] ') || line.startsWith('- [x] ') || line.startsWith('- [X] ')) {
      const checked = line[3] !== ' ';
      blocks.push({
        id: randomUUID(), type: 'to_do',
        to_do: { rich_text: [{ type: 'text', text: { content: line.slice(6) } }], checked },
      });
    } else if (line.startsWith('- ')) {
      blocks.push(makeTextBlock('bulleted_list_item', line.slice(2)));
    } else if (/^\d+\.\s/.test(line)) {
      blocks.push(makeTextBlock('numbered_list_item', line.replace(/^\d+\.\s/, '')));
    } else if (line.startsWith('> ')) {
      blocks.push(makeTextBlock('quote', line.slice(2)));
    } else if (line.startsWith('---')) {
      blocks.push({ id: randomUUID(), type: 'divider', divider: {} });
    } else if (line.startsWith('![')) {
      const match = line.match(/!\[(.*)\]\((.*)\)/);
      if (match) {
        blocks.push({
          id: randomUUID(), type: 'image',
          image: { external: { url: match[2] }, caption: [{ type: 'text', text: { content: match[1] } }] },
        });
      }
    } else {
      blocks.push(makeTextBlock('paragraph', line));
    }
    i++;
  }

  return blocks;
}

function makeTextBlock(type: string, content: string): NotionBlock {
  const block: NotionBlock = { id: randomUUID(), type };
  (block as Record<string, unknown>)[type] = {
    rich_text: [{ type: 'text', text: { content } }],
  };
  return block;
}

function richTextToString(richText: unknown[]): string {
  return richText.map((rt: unknown) => {
    const item = rt as Record<string, unknown>;
    const text = (item.plain_text || (item.text as Record<string, unknown>)?.content || '') as string;
    const annotations = item.annotations as Record<string, boolean> | undefined;
    let result = text;
    if (annotations?.bold) result = '**' + result + '**';
    if (annotations?.italic) result = '*' + result + '*';
    if (annotations?.code) result = '`' + result + '`';
    if (annotations?.strikethrough) result = '~~' + result + '~~';
    if (item.href) result = '[' + result + '](' + item.href + ')';
    return result;
  }).join('');
}

// ─── Confluence Page Tree Importer ────────────────────────────────────────

export class ConfluencePageTreeImporter {
  private baseUrl: string;
  private email: string;
  private apiToken: string;

  constructor(baseUrl: string, email: string, apiToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.email = email;
    this.apiToken = apiToken;
  }

  private headers(): Record<string, string> {
    const auth = Buffer.from(this.email + ':' + this.apiToken).toString('base64');
    return {
      Authorization: 'Basic ' + auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** Fetch the full page tree for a space. */
  async fetchPageTree(spaceKey: string): Promise<ConfluencePageTree[]> {
    const allPages = await this.fetchAllPages(spaceKey);
    return this.buildTree(allPages);
  }

  /** Fetch all pages in a space with parent info. */
  async fetchAllPages(spaceKey: string, limit: number = 500): Promise<Array<{
    id: string; title: string; url: string; parentId?: string; version: number; lastModified: Date;
  }>> {
    const pages: Array<{
      id: string; title: string; url: string; parentId?: string; version: number; lastModified: Date;
    }> = [];
    let start = 0;
    let totalFetched = 0;

    while (totalFetched < limit) {
      const url = `${this.baseUrl}/wiki/rest/api/content?spaceKey=${spaceKey}&limit=50&start=${start}&expand=version,ancestors`;
      const resp = await fetch(url, { headers: this.headers() });
      if (!resp.ok) throw new Error(`Confluence API error (${resp.status})`);

      const data = await resp.json() as {
        results: Array<{
          id: string; title: string;
          _links: { webui: string };
          version: { number: number; when: string };
          ancestors: Array<{ id: string }>;
        }>;
      };
      if (data.results.length === 0) break;

      for (const page of data.results) {
        pages.push({
          id: page.id,
          title: page.title,
          url: this.baseUrl + '/wiki' + (page._links.webui || ''),
          parentId: page.ancestors?.length ? page.ancestors[page.ancestors.length - 1].id : undefined,
          version: page.version.number,
          lastModified: new Date(page.version.when),
        });
        totalFetched++;
      }

      start += data.results.length;
      if (data.results.length < 50) break;
    }

    return pages;
  }

  /** Fetch a single page's body as storage HTML and convert to markdown. */
  async fetchPageContent(pageId: string): Promise<string> {
    const url = `${this.baseUrl}/wiki/rest/api/content/${pageId}?expand=body.storage`;
    const resp = await fetch(url, { headers: this.headers() });
    if (!resp.ok) throw new Error(`Confluence page error (${resp.status})`);

    const data = await resp.json() as {
      body: { storage: { value: string } };
    };
    const html = data.body?.storage?.value || '';
    return this.storageHtmlToMarkdown(html);
  }

  /** Build a tree from flat page list. */
  buildTree(pages: Array<{
    id: string; title: string; url: string; parentId?: string; version: number; lastModified: Date;
  }>): ConfluencePageTree[] {
    const byId = new Map<string, ConfluencePageTree>();
    const roots: ConfluencePageTree[] = [];

    for (const p of pages) {
      byId.set(p.id, {
        id: p.id, title: p.title, url: p.url,
        children: [], version: p.version, lastModified: p.lastModified,
      });
    }

    for (const p of pages) {
      const node = byId.get(p.id)!;
      if (p.parentId && byId.has(p.parentId)) {
        byId.get(p.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  /** Render tree as indented text (for sidebar display). */
  renderTree(tree: ConfluencePageTree[], indent: number = 0): string {
    let result = '';
    for (const node of tree) {
      const prefix = '  '.repeat(indent);
      result += `${prefix}${node.children.length > 0 ? '▸' : '▪'} ${node.title} [v${node.version}]\n`;
      if (node.children.length > 0) {
        result += this.renderTree(node.children, indent + 1);
      }
    }
    return result;
  }

  /** Simple Confluence storage → markdown. */
  storageHtmlToMarkdown(html: string): string {
    return html
      .replace(/<h1[^>]*>/gi, '# ').replace(/<\/h1>/gi, '\n\n')
      .replace(/<h2[^>]*>/gi, '## ').replace(/<\/h2>/gi, '\n\n')
      .replace(/<h3[^>]*>/gi, '### ').replace(/<\/h3>/gi, '\n\n')
      .replace(/<h4[^>]*>/gi, '#### ').replace(/<\/h4>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '').replace(/<\/p>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<strong[^>]*>/gi, '**').replace(/<\/strong>/gi, '**')
      .replace(/<em[^>]*>/gi, '*').replace(/<\/em>/gi, '*')
      .replace(/<code[^>]*>/gi, '`').replace(/<\/code>/gi, '`')
      .replace(/<pre[^>]*>/gi, '```\n').replace(/<\/pre>/gi, '\n```\n')
      .replace(/<ul[^>]*>/gi, '').replace(/<\/ul>/gi, '')
      .replace(/<ol[^>]*>/gi, '').replace(/<\/ol>/gi, '')
      .replace(/<li[^>]*>/gi, '- ').replace(/<\/li>/gi, '\n')
      .replace(/<a\s+href="([^"]*)"[^>]*>/gi, '[$1](').replace(/<\/a>/gi, ')')
      .replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)')
      .replace(/<ac:structured-macro[^>]*>.*?<\/ac:structured-macro>/gis, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n').trim();
  }
}

// ─── Change Detection: Webhooks + Polling ─────────────────────────────────

export class DocChangeDetector extends EventEmitter {
  private pollingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private knownHashes = new Map<string, string>();
  private knownVersions = new Map<string, number>();
  private notionWebhookSecret?: string;

  constructor(notionWebhookSecret?: string) {
    super();
    this.notionWebhookSecret = notionWebhookSecret;
  }

  /** Process a Notion webhook payload for real-time changes. */
  processNotionWebhook(payload: {
    id: string;
    data: { object: string; id: string };
    type: string;
    created_time: string;
  }): SyncChange | null {
    if (payload.type === 'page.created') {
      return {
        docId: payload.data.id,
        source: 'notion',
        changeType: 'created',
        title: 'New page',
        timestamp: new Date(payload.created_time).getTime(),
      };
    }
    if (payload.type === 'page.updated') {
      return {
        docId: payload.data.id,
        source: 'notion',
        changeType: 'updated',
        title: 'Updated page',
        timestamp: new Date(payload.created_time).getTime(),
      };
    }
    if (payload.type === 'page.deleted') {
      return {
        docId: payload.data.id,
        source: 'notion',
        changeType: 'deleted',
        title: 'Deleted page',
        timestamp: new Date(payload.created_time).getTime(),
      };
    }
    return null;
  }

  /** Start polling Confluence for changes by checking version numbers. */
  startConfluencePolling(
    spaceKey: string,
    intervalSec: number,
    pageVersionProvider: () => Promise<Array<{ id: string; version: number; title: string }>>,
  ): void {
    const key = `confluence:${spaceKey}`;
    this.stopPolling(key);

    const timer = setInterval(async () => {
      try {
        const pages = await pageVersionProvider();
        for (const page of pages) {
          const known = this.knownVersions.get(page.id);
          if (known === undefined) {
            this.knownVersions.set(page.id, page.version);
            continue;
          }
          if (page.version > known) {
            this.knownVersions.set(page.id, page.version);
            this.emit('change', {
              docId: page.id,
              source: 'confluence',
              changeType: 'updated',
              title: page.title,
              timestamp: Date.now(),
            } as SyncChange);
          }
        }
      } catch {
        // Polling continues on error
      }
    }, intervalSec * 1000);

    this.pollingTimers.set(key, timer);
  }

  /** Watch local markdown files for changes. */
  watchLocal(dir: string): void {
    try {
      const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.md')) return;
        const fullPath = join(dir, filename);
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const hash = this.hashContent(content);
          const oldHash = this.knownHashes.get(fullPath);

          if (oldHash && oldHash !== hash) {
            this.emit('change', {
              docId: fullPath,
              source: 'local',
              changeType: 'updated',
              title: basename(filename, '.md'),
              timestamp: Date.now(),
              oldHash,
              newHash: hash,
            } as SyncChange);
          } else if (!oldHash) {
            this.emit('change', {
              docId: fullPath,
              source: 'local',
              changeType: 'created',
              title: basename(filename, '.md'),
              timestamp: Date.now(),
              newHash: hash,
            } as SyncChange);
          }
          this.knownHashes.set(fullPath, hash);
        } catch {
          // File may have been deleted
        }
      });
    } catch {
      // Directory may not exist yet
    }
  }

  /** Stop a specific polling timer. */
  stopPolling(key: string): void {
    const existing = this.pollingTimers.get(key);
    if (existing) {
      clearInterval(existing);
      this.pollingTimers.delete(key);
    }
  }

  /** Stop all polling and watchers. */
  stopAll(): void {
    for (const [key] of this.pollingTimers) this.stopPolling(key);
    this.removeAllListeners();
  }

  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }
}

// ─── Embedded Doc Viewer (IDE Sidebar) ────────────────────────────────────

export class DocViewer {
  state: DocViewerState;

  constructor() {
    this.state = {
      currentDoc: null,
      sidebarVisible: true,
      sidebarDocs: [],
      searchQuery: '',
      searchResults: [],
    };
  }

  /** Load documents into the sidebar listing. */
  loadSidebar(docs: SyncedDoc[]): void {
    this.state.sidebarDocs = docs.map(d => ({
      id: d.id,
      title: d.title,
      source: d.source,
    }));
  }

  /** Open a specific document in the viewer. */
  openDoc(doc: SyncedDoc): void {
    this.state.currentDoc = doc;
  }

  /** Close the current document. */
  closeDoc(): void {
    this.state.currentDoc = null;
  }

  /** Search across all loaded documents. */
  search(query: string, docs: SyncedDoc[]): void {
    this.state.searchQuery = query;
    const lowerQ = query.toLowerCase();

    this.state.searchResults = docs
      .filter(d => d.title.toLowerCase().includes(lowerQ) || d.markdown.toLowerCase().includes(lowerQ))
      .map(d => {
        const idx = d.markdown.toLowerCase().indexOf(lowerQ);
        const start = Math.max(0, idx - 40);
        const end = Math.min(d.markdown.length, idx + query.length + 80);
        const snippet = (start > 0 ? '...' : '') + d.markdown.slice(start, end) + (end < d.markdown.length ? '...' : '');
        return { id: d.id, title: d.title, snippet };
      })
      .slice(0, 20);
  }

  /** Toggle sidebar visibility. */
  toggleSidebar(): boolean {
    this.state.sidebarVisible = !this.state.sidebarVisible;
    return this.state.sidebarVisible;
  }

  /** Render the current doc as formatted markdown (for IDE display). */
  renderCurrentDoc(): string {
    if (!this.state.currentDoc) return '*No document open*';
    const doc = this.state.currentDoc;
    const header = [
      `# ${doc.title}`,
      `*Source: ${doc.source} | Last modified: ${doc.lastModified.toISOString()}*`,
      '',
    ].join('\n');
    return header + '\n' + doc.markdown;
  }

  /** Get sidebar tree representation. */
  renderSidebar(): string {
    if (!this.state.sidebarVisible) return '';
    const grouped: Record<string, Array<{ id: string; title: string }>> = {};
    for (const doc of this.state.sidebarDocs) {
      (grouped[doc.source] = grouped[doc.source] || []).push(doc);
    }
    let out = '## Docs\n\n';
    for (const [source, docs] of Object.entries(grouped)) {
      out += `### ${source.charAt(0).toUpperCase() + source.slice(1)}\n`;
      for (const d of docs) {
        out += `- ${d.title}\n`;
      }
      out += '\n';
    }
    return out;
  }
}

// ─── Bidirectional Sync Engine ────────────────────────────────────────────

export class DocSyncEngine {
  private notionToken?: string;
  private notionDbIds: string[];
  private treeImporter?: ConfluencePageTreeImporter;
  private spaceKeys: string[];
  private detector: DocChangeDetector;
  viewer: DocViewer;
  private storageDir: string;
  private pageLimit: number;
  private docs = new Map<string, SyncedDoc>();
  private changeLog: SyncChange[] = [];

  constructor(config: DocSyncConfig) {
    this.notionToken = config.notionToken;
    this.notionDbIds = config.notionDatabaseIds || [];
    this.spaceKeys = config.confluenceSpaceKeys || [];
    this.pageLimit = config.pageLimit || 500;
    this.detector = new DocChangeDetector(config.notionWebhookSecret);
    this.viewer = new DocViewer();

    this.storageDir = config.localDocDir || join(homedir(), '.cobra-commander', 'doc-sync');
    if (!existsSync(this.storageDir)) mkdirSync(this.storageDir, { recursive: true });

    if (config.confluenceBaseUrl && config.confluenceEmail && config.confluenceApiToken) {
      this.treeImporter = new ConfluencePageTreeImporter(
        config.confluenceBaseUrl, config.confluenceEmail, config.confluenceApiToken,
      );
    }

    // Set up local file watching
    this.detector.watchLocal(this.storageDir);

    // Listen for changes
    this.detector.on('change', (change: SyncChange) => {
      this.changeLog.push(change);
      if (this.changeLog.length > 100) this.changeLog = this.changeLog.slice(-100);
    });

    this.loadDocs();

    // Start Confluence polling
    if (config.pollingIntervalSec !== undefined && this.treeImporter && this.spaceKeys.length > 0) {
      for (const spaceKey of this.spaceKeys) {
        this.detector.startConfluencePolling(
          spaceKey,
          config.pollingIntervalSec || 300,
          async () => {
            const pages = await this.treeImporter!.fetchAllPages(spaceKey, this.pageLimit);
            return pages.map(p => ({ id: p.id, version: p.version, title: p.title }));
          },
        );
      }
    }
  }

  // ─── Notion Sync ────────────────────────────────────────────────────────

  /** Fetch a Notion page's blocks and convert to markdown. */
  async fetchNotionPage(pageId: string): Promise<{ markdown: string; blocks: NotionBlock[] }> {
    if (!this.notionToken) throw new Error('Notion token not configured');

    const resp = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
      headers: {
        Authorization: 'Bearer ' + this.notionToken,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) throw new Error(`Notion API error (${resp.status})`);
    const data = await resp.json() as { results: NotionBlock[] };
    const blocks = data.results || [];
    const markdown = notionBlocksToMarkdown(blocks);

    return { markdown, blocks };
  }

  /** Push markdown content to a Notion page (append blocks). */
  async pushToNotion(pageId: string, markdown: string): Promise<void> {
    if (!this.notionToken) throw new Error('Notion token not configured');

    const blocks = markdownToNotionBlocks(markdown);
    const children = blocks.map(b => {
      const { id, ...rest } = b;
      // Notion API doesn't accept client-generated IDs for new blocks
      return rest;
    });

    await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + this.notionToken,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ children }),
    });
  }

  /** Write markdown to a local file. */
  writeLocalDoc(slug: string, markdown: string): string {
    const safeSlug = slug.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 100);
    const path = join(this.storageDir, safeSlug + '.md');
    writeFileSync(path, markdown);
    return path;
  }

  /** Read a local markdown file. */
  readLocalDoc(slug: string): string | null {
    const safeSlug = slug.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 100);
    const path = join(this.storageDir, safeSlug + '.md');
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  // ─── Bi-directional Sync ────────────────────────────────────────────────

  /** Sync a Notion page bidirectionally:
   *  - Pull latest from Notion, write to local .md
   *  - If local has diverged, push changes back to Notion
   */
  async syncBidirectional(pageId: string, title: string): Promise<SyncedDoc> {
    // Pull from Notion
    const { markdown, blocks } = await this.fetchNotionPage(pageId);

    // Check local version
    const localContent = this.readLocalDoc(pageId);
    let finalMarkdown = markdown;

    if (localContent && localContent !== markdown) {
      // Local has changes — push to Notion
      await this.pushToNotion(pageId, localContent);
      finalMarkdown = localContent;
    } else {
      // Write Notion content locally
      this.writeLocalDoc(pageId, markdown);
    }

    const doc: SyncedDoc = {
      id: pageId,
      source: 'notion',
      title,
      url: `https://notion.so/${pageId.replace(/-/g, '')}`,
      content: JSON.stringify(blocks),
      markdown: finalMarkdown,
      lastModified: new Date(),
      lastSynced: new Date(),
      children: [],
      metadata: { syncedVia: 'bidirectional' },
    };

    this.docs.set(pageId, doc);
    this.persistDocs();
    this.viewer.loadSidebar(this.listDocs());
    return doc;
  }

  // ─── Confluence Import ──────────────────────────────────────────────────

  /** Import a full Confluence page tree into local docs. */
  async importConfluenceTree(spaceKey: string): Promise<{
    tree: ConfluencePageTree[];
    docs: SyncedDoc[];
  }> {
    if (!this.treeImporter) throw new Error('Confluence not configured');

    const tree = await this.treeImporter.fetchPageTree(spaceKey);
    const docs: SyncedDoc[] = [];

    const importNode = async (node: ConfluencePageTree) => {
      try {
        const markdown = await this.treeImporter!.fetchPageContent(node.id);
        const doc: SyncedDoc = {
          id: node.id,
          source: 'confluence',
          title: node.title,
          url: node.url,
          content: markdown,
          markdown,
          lastModified: node.lastModified,
          lastSynced: new Date(),
          children: node.children.map(c => c.id),
          metadata: { spaceKey, version: String(node.version) },
        };
        this.docs.set(node.id, doc);
        this.writeLocalDoc(node.id, markdown);
        docs.push(doc);
      } catch {
        // Skip pages that fail
      }

      for (const child of node.children) {
        await importNode(child);
      }
    };

    for (const root of tree) {
      await importNode(root);
    }

    this.persistDocs();
    this.viewer.loadSidebar(this.listDocs());
    return { tree, docs };
  }

  // ─── Doc Management ─────────────────────────────────────────────────────

  /** List all synced docs. */
  listDocs(source?: SyncedDoc['source']): SyncedDoc[] {
    const all = Array.from(this.docs.values())
      .sort((a, b) => b.lastSynced.getTime() - a.lastSynced.getTime());
    return source ? all.filter(d => d.source === source) : all;
  }

  /** Get a specific doc. */
  getDoc(id: string): SyncedDoc | undefined {
    return this.docs.get(id);
  }

  /** Search docs. */
  searchDocs(query: string): SyncedDoc[] {
    const lowerQ = query.toLowerCase();
    const results = this.listDocs().filter(d =>
      d.title.toLowerCase().includes(lowerQ) || d.markdown.toLowerCase().includes(lowerQ),
    );
    this.viewer.search(query, results);
    return results;
  }

  /** Get recent changes. */
  getChangeLog(): SyncChange[] {
    return [...this.changeLog];
  }

  /** Get the change detector for webhook handling. */
  getChangeDetector(): DocChangeDetector {
    return this.detector;
  }

  /** Get sync status summary. */
  getSyncStatus(): {
    totalDocs: number;
    bySource: Record<string, number>;
    lastSync: Date | null;
    pendingChanges: number;
  } {
    const bySource: Record<string, number> = {};
    for (const doc of this.docs.values()) {
      bySource[doc.source] = (bySource[doc.source] || 0) + 1;
    }
    return {
      totalDocs: this.docs.size,
      bySource,
      lastSync: this.docs.size > 0
        ? new Date(Math.max(...Array.from(this.docs.values()).map(d => d.lastSynced.getTime())))
        : null,
      pendingChanges: this.changeLog.length,
    };
  }

  /** Stop all background activity. */
  shutdown(): void {
    this.detector.stopAll();
    this.persistDocs();
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  private getDocsPath(): string {
    return join(this.storageDir, 'synced-docs.json');
  }

  private persistDocs(): void {
    writeFileSync(this.getDocsPath(), JSON.stringify([...this.docs.values()], null, 2));
  }

  private loadDocs(): void {
    const path = this.getDocsPath();
    if (!existsSync(path)) return;
    try {
      const docs: SyncedDoc[] = JSON.parse(readFileSync(path, 'utf-8'));
      for (const doc of docs) {
        doc.lastModified = new Date(doc.lastModified);
        doc.lastSynced = new Date(doc.lastSynced);
        this.docs.set(doc.id, doc);
      }
      this.viewer.loadSidebar(this.listDocs());
    } catch {
      // Corrupt file — start fresh
    }
  }
}
