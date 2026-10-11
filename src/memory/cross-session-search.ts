import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ConversationMemory {
  id: string;
  sessionId: string;
  project: string;
  topic: string;              // extracted topic/task summary
  date: number;               // timestamp of conversation
  messages: string;           // concatenated message text for embedding
  summary: string;            // AI-generated summary
  tags: string[];
  filesModified: string[];    // relative paths
  keyDecisions: string[];     // extracted decisions made
  outcome: 'completed' | 'blocked' | 'failed' | 'ongoing' | 'abandoned';
  participants: string[];     // agent roles involved
}

export interface MemoryEmbedding {
  memoryId: string;
  vector: number[];
  dimensions: number;
}

export interface MemoryIndex {
  memories: ConversationMemory[];
  embeddings: MemoryEmbedding[];
  dimensions: number;
  builtAt: number;
  lastSessionId: string;
}

export interface SearchQuery {
  /** Natural language query about what the user wants to find */
  text: string;
  /** Filter by project name */
  project?: string;
  /** Filter by date range */
  dateRange?: { from?: number; to?: number };
  /** Filter by tags */
  tags?: string[];
  /** Filter by outcome */
  outcome?: ConversationMemory['outcome'];
  /** Minimum similarity score (0-1, default 0.3) */
  minScore?: number;
  /** Maximum results to return */
  topK?: number;
}

export interface SearchHit {
  memory: ConversationMemory;
  score: number;
  highlightSnippet: string;
}

export interface ContextInjection {
  /** Formatted text to inject into the current prompt */
  text: string;
  /** Memory IDs that were injected */
  sourceIds: string[];
  /** Score quality of the overall injection */
  confidence: number;
}

export interface CrossSessionSearchConfig {
  storageDir?: string;
  dimensions?: number;
  minScore?: number;
  topK?: number;
  maxInjectionTokens?: number;
  autoIndexOnQuery?: boolean;
}

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<CrossSessionSearchConfig> = {
  storageDir: join(homedir(), '.cobra-commander', 'cross-session'),
  dimensions: 384,
  minScore: 0.3,
  topK: 5,
  maxInjectionTokens: 1500,
  autoIndexOnQuery: true,
};

// ─── Embedding Generation ─────────────────────────────────────────────────

function generateEmbedding(text: string, dimensions: number): number[] {
  const vec = new Array(dimensions).fill(0);

  // Character-level features with positional weighting
  for (let i = 0; i < text.length; i++) {
    const idx = (text.charCodeAt(i) * 31 + i * 7) % dimensions;
    vec[idx] += (text.charCodeAt(i) / 255) * 2 - 1;
  }

  // Word-level semantic features
  const words = text.toLowerCase().match(/\b[a-z_]\w*\b/g) || [];
  for (const word of words) {
    // Weight by word rarity (approximation: shorter words are more common)
    const weight = Math.min(1.5, 5 / word.length);
    const idx = word.split('').reduce((s, c) => s + c.charCodeAt(0), 0) * 17 % dimensions;
    vec[idx] += weight * 0.5;
  }

  // Bigram features for phrase-level meaning
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = words[i] + '-' + words[i + 1];
    const idx = bigram.split('').reduce((s, c) => s + c.charCodeAt(0), 0) * 13 % dimensions;
    vec[idx] += 0.3;
  }

  // Normalize to unit vector
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map(v => v / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Topic Extraction ─────────────────────────────────────────────────────

function extractTopic(messages: string): string {
  // Extract first meaningful line as topic hint
  const lines = messages.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const clean = line.replace(/^[#*\-•]\s*/, '').trim();
    if (clean.length > 20 && clean.length < 200) {
      return clean.slice(0, 150);
    }
  }
  return messages.slice(0, 150).trim() || 'Untitled';
}

function extractTags(messages: string): string[] {
  const lower = messages.toLowerCase();
  const tagPatterns: Array<{ pattern: RegExp; tag: string }> = [
    { pattern: /\b(refactor|rewrite|migrate)\b/, tag: 'refactor' },
    { pattern: /\b(test|spec|coverage|unit test|integration test)\b/, tag: 'testing' },
    { pattern: /\b(bug|fix|issue|error|crash)\b/, tag: 'bug-fix' },
    { pattern: /\b(api|endpoint|route|rest|graphql)\b/, tag: 'api' },
    { pattern: /\b(security|auth|permission|vuln|cve)\b/, tag: 'security' },
    { pattern: /\b(performance|perf|slow|optimize|fast)\b/, tag: 'performance' },
    { pattern: /\b(docs|documentation|readme)\b/, tag: 'documentation' },
    { pattern: /\b(deploy|ci|cd|pipeline|release)\b/, tag: 'devops' },
    { pattern: /\b(database|sql|mongo|postgres|migration)\b/, tag: 'database' },
    { pattern: /\b(ui|component|css|style|frontend|react|vue)\b/, tag: 'frontend' },
    { pattern: /\b(config|settings|env|environment)\b/, tag: 'configuration' },
    { pattern: /\b(import|dependency|package|module|library)\b/, tag: 'dependencies' },
  ];

  const tags: string[] = [];
  for (const { pattern, tag } of tagPatterns) {
    if (pattern.test(lower)) {
      tags.push(tag);
    }
  }

  return tags;
}

function extractFilesModified(messages: string): string[] {
  const filePattern = /(?:wrote|edited|created|modified|deleted|read|updated|changed)\s+([\w/\-.]+\.[\w]+)/gi;
  const files = new Set<string>();
  let match;
  while ((match = filePattern.exec(messages)) !== null) {
    files.add(match[1]);
  }
  return [...files];
}

// ─── CrossSessionSearch ───────────────────────────────────────────────────

export class CrossSessionSearch {
  private config: Required<CrossSessionSearchConfig>;
  private index: MemoryIndex;

  constructor(config?: CrossSessionSearchConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.index = {
      memories: [],
      embeddings: [],
      dimensions: this.config.dimensions,
      builtAt: 0,
      lastSessionId: '',
    };
    this.loadIndex();
  }

  // ─── Memory Ingestion ───────────────────────────────────────────────────

  /**
   * Index the messages from a session for future cross-session search.
   */
  indexSession(params: {
    sessionId: string;
    project: string;
    messages: Array<{ role: string; content: unknown }>;
    outcome?: ConversationMemory['outcome'];
    summary?: string;
    participants?: string[];
  }): ConversationMemory {
    // Flatten messages into a single text for embedding
    const flatMessages = params.messages.map(m => {
      const role = m.role;
      const content = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as Array<{ type: string; text?: string }>)
            .filter(b => b.type === 'text')
            .map(b => b.text || '')
            .join(' ')
          : '';
      return `[${role}]: ${content}`;
    }).join('\n');

    const topic = extractTopic(flatMessages);
    const tags = extractTags(flatMessages);
    const filesModified = extractFilesModified(flatMessages);

    const memory: ConversationMemory = {
      id: `mem-${params.sessionId}-${Date.now()}-${randomUUID().slice(0, 6)}`,
      sessionId: params.sessionId,
      project: params.project,
      topic,
      date: Date.now(),
      messages: flatMessages.slice(0, 8000),  // Truncate for storage
      summary: params.summary || topic,
      tags,
      filesModified,
      keyDecisions: [],
      outcome: params.outcome || 'ongoing',
      participants: params.participants || ['assistant'],
    };

    // Check if this session is already indexed (update vs create)
    const existingIdx = this.index.memories.findIndex(m => m.sessionId === params.sessionId);
    if (existingIdx >= 0) {
      this.index.memories[existingIdx] = memory;
      // Re-compute embedding
      this.index.embeddings[existingIdx] = {
        memoryId: memory.id,
        vector: generateEmbedding(flatMessages.slice(0, 4000), this.config.dimensions),
        dimensions: this.config.dimensions,
      };
    } else {
      this.index.memories.push(memory);
      this.index.embeddings.push({
        memoryId: memory.id,
        vector: generateEmbedding(flatMessages.slice(0, 4000), this.config.dimensions),
        dimensions: this.config.dimensions,
      });
    }

    this.index.builtAt = Date.now();
    this.index.lastSessionId = params.sessionId;
    this.persistIndex();

    return memory;
  }

  /**
   * Index multiple sessions at once (batch ingestion).
   */
  indexSessions(
    sessions: Array<{
      sessionId: string;
      project: string;
      messages: Array<{ role: string; content: unknown }>;
      outcome?: ConversationMemory['outcome'];
      summary?: string;
      participants?: string[];
    }>,
  ): { indexed: number; updated: number } {
    let indexed = 0;
    let updated = 0;

    for (const session of sessions) {
      const existing = this.index.memories.find(m => m.sessionId === session.sessionId);
      this.indexSession(session);
      if (existing) updated++;
      else indexed++;
    }

    return { indexed, updated };
  }

  // ─── Semantic Search ────────────────────────────────────────────────────

  /**
   * Search the memory index for conversations relevant to the query.
   */
  search(query: SearchQuery): SearchHit[] {
    if (this.index.memories.length === 0) {
      return [];
    }

    const k = query.topK ?? this.config.topK;
    const minScore = query.minScore ?? this.config.minScore;
    const queryVec = generateEmbedding(query.text, this.index.dimensions);

    const scored: SearchHit[] = [];

    for (let i = 0; i < this.index.memories.length; i++) {
      const memory = this.index.memories[i];
      const embedding = this.index.embeddings[i];

      // Apply filters
      if (query.project && memory.project !== query.project) continue;
      if (query.outcome && memory.outcome !== query.outcome) continue;
      if (query.dateRange) {
        if (query.dateRange.from && memory.date < query.dateRange.from) continue;
        if (query.dateRange.to && memory.date > query.dateRange.to) continue;
      }
      if (query.tags && query.tags.length > 0) {
        const hasAllTags = query.tags.every(t => memory.tags.includes(t));
        if (!hasAllTags) continue;
      }

      const score = embedding
        ? cosineSimilarity(queryVec, embedding.vector)
        : 0;

      if (score >= minScore) {
        // Generate highlight snippet
        const snippet = this.generateSnippet(memory.messages, query.text, 150);

        scored.push({
          memory,
          score: Math.round(score * 1000) / 1000,
          highlightSnippet: snippet,
        });
      }
    }

    // Sort by score descending, then by date descending
    scored.sort((a, b) => b.score - a.score || b.memory.date - a.memory.date);

    return scored.slice(0, k);
  }

  /**
   * Search by topic keywords in addition to embedding.
   */
  searchByTopic(topicQuery: string, options?: Omit<SearchQuery, 'text'>): SearchHit[] {
    return this.search({
      text: topicQuery,
      ...options,
    });
  }

  /**
   * Find similar sessions to a given session.
   */
  findSimilarSessions(sessionId: string, topK?: number): SearchHit[] {
    const memory = this.index.memories.find(m => m.sessionId === sessionId);
    if (!memory) return [];

    return this.search({
      text: memory.topic,
      topK: topK ?? this.config.topK,
    }).filter(hit => hit.memory.sessionId !== sessionId);
  }

  // ─── Context Injection ──────────────────────────────────────────────────

  /**
   * Build an injection string suitable for prepending to the current
   * conversation prompt, containing the top-K most relevant past memories.
   */
  injectContext(query: SearchQuery): ContextInjection {
    const hits = this.search(query);

    if (hits.length === 0) {
      return {
        text: '',
        sourceIds: [],
        confidence: 0,
      };
    }

    const sourceIds: string[] = [];
    const sections: string[] = [
      '## Relevant Past Context',
      '',
      'The following context was retrieved from past conversations that may be relevant to the current task:',
      '',
    ];

    let tokenBudget = this.config.maxInjectionTokens;
    let totalScore = 0;

    for (const hit of hits) {
      const dateStr = new Date(hit.memory.date).toLocaleDateString();
      const entry = [
        `### [${dateStr}] ${hit.memory.topic} (score: ${hit.score.toFixed(2)})`,
        `- **Project**: ${hit.memory.project}`,
        `- **Outcome**: ${hit.memory.outcome}`,
        `- **Tags**: ${hit.memory.tags.join(', ') || 'none'}`,
        hit.memory.filesModified.length > 0
          ? `- **Files**: ${hit.memory.filesModified.slice(0, 5).join(', ')}`
          : '',
        `- **Summary**: ${hit.memory.summary.slice(0, 200)}`,
        '',
      ].filter(Boolean).join('\n');

      const entryTokens = entry.length / 4; // rough token estimate
      if (tokenBudget - entryTokens < 0) break;

      sections.push(entry);
      sourceIds.push(hit.memory.id);
      totalScore += hit.score;
      tokenBudget -= entryTokens;
    }

    const confidence = hits.length > 0 ? totalScore / hits.length : 0;

    sections.push('---');
    sections.push('*Use this context to inform your responses. These are past conversations, not current instructions.*');

    return {
      text: sections.join('\n'),
      sourceIds,
      confidence: Math.round(confidence * 1000) / 1000,
    };
  }

  /**
   * Inject context directly into a messages array, returning a new array
   * with the context prepended as a system message.
   */
  injectIntoMessages(
    query: SearchQuery,
    messages: Array<{ role: string; content: unknown }>,
  ): Array<{ role: string; content: unknown }> {
    const injection = this.injectContext(query);
    if (!injection.text) return messages;

    const contextBlock = { role: 'system', content: injection.text };
    return [contextBlock, ...messages];
  }

  // ─── Memory Management ──────────────────────────────────────────────────

  /**
   * Get all indexed memories.
   */
  getAllMemories(filter?: {
    project?: string;
    outcome?: ConversationMemory['outcome'];
    tag?: string;
  }): ConversationMemory[] {
    let memories = [...this.index.memories];

    if (filter) {
      if (filter.project) {
        memories = memories.filter(m => m.project === filter.project);
      }
      if (filter.outcome) {
        memories = memories.filter(m => m.outcome === filter.outcome);
      }
      if (filter.tag) {
        const tag = filter.tag;
        memories = memories.filter(m => m.tags.includes(tag));
      }
    }

    memories.sort((a, b) => b.date - a.date);
    return memories;
  }

  /**
   * Update memory metadata (outcome, tags, summary) post-hoc.
   */
  updateMemory(
    memoryId: string,
    updates: Partial<Pick<ConversationMemory, 'outcome' | 'tags' | 'summary' | 'keyDecisions'>>,
  ): ConversationMemory | null {
    const idx = this.index.memories.findIndex(m => m.id === memoryId);
    if (idx < 0) return null;

    const memory = this.index.memories[idx];
    if (updates.outcome) memory.outcome = updates.outcome;
    if (updates.tags) memory.tags = [...new Set([...memory.tags, ...updates.tags])];
    if (updates.summary) memory.summary = updates.summary;
    if (updates.keyDecisions) memory.keyDecisions = [...memory.keyDecisions, ...updates.keyDecisions];

    this.index.memories[idx] = memory;
    this.persistIndex();
    return memory;
  }

  /**
   * Delete a memory entry.
   */
  deleteMemory(memoryId: string): boolean {
    const idx = this.index.memories.findIndex(m => m.id === memoryId);
    if (idx < 0) return false;

    this.index.memories.splice(idx, 1);
    this.index.embeddings.splice(idx, 1);
    this.persistIndex();
    return true;
  }

  /**
   * Prune old memories beyond a certain age.
   */
  pruneOlderThan(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const before = this.index.memories.length;

    const keepIndices: number[] = [];
    for (let i = 0; i < this.index.memories.length; i++) {
      if (this.index.memories[i].date >= cutoff) {
        keepIndices.push(i);
      }
    }

    this.index.memories = keepIndices.map(i => this.index.memories[i]);
    this.index.embeddings = keepIndices.map(i => this.index.embeddings[i]);

    const removed = before - this.index.memories.length;
    if (removed > 0) this.persistIndex();
    return removed;
  }

  // ─── Statistics ─────────────────────────────────────────────────────────

  getStats(): {
    totalMemories: number;
    totalSessions: number;
    projects: string[];
    oldestDate: number | null;
    newestDate: number | null;
    dimensions: number;
  } {
    const projectSet = new Set(this.index.memories.map(m => m.project));
    const dates = this.index.memories.map(m => m.date);
    const sessionSet = new Set(this.index.memories.map(m => m.sessionId));

    return {
      totalMemories: this.index.memories.length,
      totalSessions: sessionSet.size,
      projects: [...projectSet],
      oldestDate: dates.length > 0 ? Math.min(...dates) : null,
      newestDate: dates.length > 0 ? Math.max(...dates) : null,
      dimensions: this.index.dimensions,
    };
  }

  // ─── Export / Import ────────────────────────────────────────────────────

  /**
   * Export the full memory index for backup or transfer.
   */
  exportIndex(): MemoryIndex {
    return JSON.parse(JSON.stringify(this.index)) as MemoryIndex;
  }

  /**
   * Import a full memory index, merging with existing.
   */
  importIndex(external: MemoryIndex): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;

    const existingIds = new Set(this.index.memories.map(m => m.id));
    for (let i = 0; i < external.memories.length; i++) {
      const mem = external.memories[i];
      const emb = external.embeddings[i];
      if (!existingIds.has(mem.id)) {
        this.index.memories.push(mem);
        this.index.embeddings.push(emb || {
          memoryId: mem.id,
          vector: generateEmbedding(mem.messages.slice(0, 4000), this.config.dimensions),
          dimensions: this.config.dimensions,
        });
        added++;
      } else {
        skipped++;
      }
    }

    if (added > 0) {
      this.index.builtAt = Date.now();
      this.persistIndex();
    }

    return { added, skipped };
  }

  /**
   * Clear all indexed memories.
   */
  clearIndex(): void {
    this.index = {
      memories: [],
      embeddings: [],
      dimensions: this.config.dimensions,
      builtAt: 0,
      lastSessionId: '',
    };
    this.persistIndex();
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private generateSnippet(text: string, query: string, maxLen: number): string {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();

    const queryWords = lowerQuery.split(/\s+/).filter(w => w.length > 2);

    // Find the first occurrence of any query word
    let bestPos = 0;
    let bestDensity = 0;

    for (let i = 0; i < text.length - 50; i += 20) {
      const snippet = lowerText.slice(i, i + maxLen);
      let density = 0;
      for (const word of queryWords) {
        if (snippet.includes(word)) density++;
      }
      if (density > bestDensity) {
        bestDensity = density;
        bestPos = i;
      }
    }

    let snippet = text.slice(bestPos, bestPos + maxLen * 2);
    if (bestPos > 0) snippet = '...' + snippet;
    if (bestPos + maxLen * 2 < text.length) snippet = snippet + '...';

    return snippet.slice(0, maxLen + 6); // +6 for ellipsis
  }

  private persistIndex(): void {
    const dir = this.config.storageDir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const indexPath = join(dir, 'memory-index.json');
    writeFileSync(indexPath, JSON.stringify(this.index, null, 2), 'utf-8');
  }

  private loadIndex(): void {
    const indexPath = join(this.config.storageDir, 'memory-index.json');
    if (!existsSync(indexPath)) return;

    try {
      const raw = readFileSync(indexPath, 'utf-8');
      const data = JSON.parse(raw) as MemoryIndex;

      // Validate structure
      if (Array.isArray(data.memories) && Array.isArray(data.embeddings)) {
        this.index = data;
      }
    } catch {
      // Corrupt index, start fresh
    }
  }
}

// ─── Convenience Functions ─────────────────────────────────────────────────

/**
 * Quick search across past sessions without constructing the full searcher.
 */
export function searchPastSessions(
  query: string,
  options?: {
    storageDir?: string;
    project?: string;
    topK?: number;
  },
): SearchHit[] {
  const searcher = new CrossSessionSearch({ storageDir: options?.storageDir });
  return searcher.search({ text: query, project: options?.project, topK: options?.topK });
}

/**
 * Build a context injection string from past conversations relevant to the query.
 */
export function buildMemoryContext(
  query: string,
  options?: {
    storageDir?: string;
    project?: string;
    maxTokens?: number;
    topK?: number;
  },
): ContextInjection {
  const searcher = new CrossSessionSearch({
    storageDir: options?.storageDir,
    maxInjectionTokens: options?.maxTokens,
    topK: options?.topK,
  });
  return searcher.injectContext({ text: query, project: options?.project });
}
