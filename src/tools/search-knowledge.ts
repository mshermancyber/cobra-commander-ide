import type { ToolDefinition } from '../core/types.js';
import { KnowledgeBase, ContentChunker } from '../core/knowledge-base.js';
import type { DocConnector, SearchResult } from '../core/knowledge-base.js';
import { join } from 'node:path';
import { installRoot } from '../core/env-file.js';

// Singleton knowledge base shared across the system
const CC_HOME = installRoot();
const knowledgeBase = new KnowledgeBase(join(CC_HOME, '.cobra-commander', 'knowledge-base'));

export function getKnowledgeBase(): KnowledgeBase {
  return knowledgeBase;
}

// ─── External doc connectors registry ───────────────────────────────────────

const connectors = new Map<string, DocConnector>();

export function registerConnector(connector: DocConnector): void {
  connectors.set(connector.name, connector);
  knowledgeBase.setConnector(connector);
}

export function getConnectors(): DocConnector[] {
  return [...connectors.values()];
}

// ─── Tool definition ────────────────────────────────────────────────────────

export const searchKnowledgeTool: ToolDefinition = {
  name: 'search_knowledge',
  description: `Search the project knowledge base for relevant documentation, code patterns, or context. You can do keyword search or semantic search. Also supports listing ingested sources and syncing from external doc connectors (e.g., Notion, Confluence). Use this to find context before making decisions or delegating tasks.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'semantic', 'list_sources', 'sync', 'ingest'],
        description: 'Action to perform: "search" (keyword-based), "semantic" (embedding similarity), "list_sources" (show ingested sources), "sync" (pull from connected external doc sources), "ingest" (add a document manually)',
      },
      query: {
        type: 'string',
        description: 'Search query text (required for "search" and "semantic" actions)',
      },
      topK: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
      },
      title: {
        type: 'string',
        description: 'Document title (required for "ingest" action)',
      },
      content: {
        type: 'string',
        description: 'Document content to ingest (required for "ingest" action)',
      },
      source: {
        type: 'string',
        description: 'Source name for ingested document (required for "ingest" action, e.g., "project-readme", "api-docs")',
      },
    },
    required: ['action'],
  },
};

// ─── Execute ────────────────────────────────────────────────────────────────

export async function executeSearchKnowledge(input: Record<string, unknown>): Promise<{ result: string; is_error: boolean }> {
  const action = input.action as string;
  const topK = (input.topK as number) || 10;

  switch (action) {
    case 'search': {
      const query = input.query as string;
      if (!query || !query.trim()) {
        return { result: 'Error: "query" is required for search action', is_error: true };
      }

      const results = knowledgeBase.search(query, topK);
      return { result: formatResults(query, results, 'keyword'), is_error: false };
    }

    case 'semantic': {
      const query = input.query as string;
      if (!query || !query.trim()) {
        return { result: 'Error: "query" is required for semantic action', is_error: true };
      }

      try {
        const results = await knowledgeBase.semanticSearch(query, topK);
        return { result: formatResults(query, results, 'semantic'), is_error: false };
      } catch (err) {
        return {
          result: `Error during semantic search: ${(err as Error).message}`,
          is_error: true,
        };
      }
    }

    case 'list_sources': {
      // Scan knowledge base directory for entries
      const entries = knowledgeBase.search('', 100); // hack: get all entries
      const sources = new Map<string, number>();
      for (const r of entries) {
        sources.set(r.source, (sources.get(r.source) || 0) + 1);
      }

      if (sources.size === 0) {
        const connectorList = [...connectors.keys()];
        if (connectorList.length > 0) {
          return {
            result: `No ingested documents found.\n\nAvailable external connectors: ${connectorList.join(', ')}\nUse action=sync to pull documents from these sources.`,
            is_error: false,
          };
        }
        return {
          result: 'No ingested documents. Use action=ingest to add documents or action=sync to pull from external sources.',
          is_error: false,
        };
      }

      let output = `Knowledge Base Sources:\n\n`;
      for (const [source, count] of [...sources.entries()].sort()) {
        output += `- **${source}**: ${count} document(s)\n`;
      }

      const connectorList = [...connectors.keys()];
      if (connectorList.length > 0) {
        output += `\nAvailable external connectors: ${connectorList.join(', ')}\n`;
        output += `Use action=sync to pull latest documents from these sources.`;
      }

      return { result: output, is_error: false };
    }

    case 'sync': {
      if (connectors.size === 0) {
        return {
          result: 'No external doc connectors available. Register a connector first (e.g., Notion, Confluence).',
          is_error: false,
        };
      }

      const results: string[] = [];
      for (const [name, connector] of connectors) {
        try {
          const syncResult = await knowledgeBase.syncFromConnector();
          results.push(`- **${name}**: ${syncResult.added} added, ${syncResult.updated} updated`);
        } catch (err) {
          results.push(`- **${name}**: Failed — ${(err as Error).message}`);
        }
      }

      return { result: `Sync complete:\n${results.join('\n')}`, is_error: false };
    }

    case 'ingest': {
      const title = input.title as string;
      const content = input.content as string;
      const source = input.source as string;

      if (!title || !title.trim()) {
        return { result: 'Error: "title" is required for ingest action', is_error: true };
      }
      if (!content || !content.trim()) {
        return { result: 'Error: "content" is required for ingest action', is_error: true };
      }
      if (!source || !source.trim()) {
        return { result: 'Error: "source" is required for ingest action', is_error: true };
      }

      const entry = knowledgeBase.ingest({
        source,
        title,
        content,
        generateEmbeddings: true,
      });

      // Generate embeddings async (best effort)
      try {
        await knowledgeBase.generateEmbeddings(entry.id);
      } catch {
        // embeddings are optional for keyword search
      }

      return {
        result: `Document ingested successfully.\n- ID: ${entry.id}\n- Title: ${entry.title}\n- Source: ${entry.source}\n- Chunks: ${entry.chunks.length}`,
        is_error: false,
      };
    }

    default:
      return {
        result: `Error: Unknown action "${action}". Use "search", "semantic", "list_sources", "sync", or "ingest".`,
        is_error: true,
      };
  }
}

function formatResults(query: string, results: SearchResult[], method: string): string {
  if (results.length === 0) {
    return `No results found for "${query}" (${method} search). Try different keywords or use action=ingest to add relevant documents.`;
  }

  let output = `## Results for "${query}" (${method}, ${results.length} hits)\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    output += `### ${i + 1}. ${r.title} (score: ${r.score.toFixed(2)})\n`;
    output += `**Source:** ${r.source}\n`;
    output += `\`\`\`\n${r.content.slice(0, 500)}\n\`\`\`\n\n`;
  }

  return output;
}
