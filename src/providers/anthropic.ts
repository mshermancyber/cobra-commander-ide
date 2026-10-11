import Anthropic from '@anthropic-ai/sdk';
import type { ProviderConfig } from '../core/config.js';
import type { ToolDefinition } from '../core/types.js';

export interface AnthropicResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  >;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface TextContentBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export type MessageContentBlock = TextContentBlock | ImageContentBlock;

/** Cache control for Anthropic prompt caching */
export interface CacheControl {
  type: 'ephemeral';
}

export interface CacheControlConfig {
  /** Whether to enable prompt caching */
  enabled: boolean;
  /** Cache breakpoints: which message indices should have cache_control set */
  breakpoints: Set<number>;
}

export function buildMessageWithImages(
  text: string,
  images?: Array<{ base64Data: string; mediaType: string }>,
): MessageContentBlock[] {
  const blocks: MessageContentBlock[] = [];

  if (images && images.length > 0) {
    if (text) {
      blocks.push({ type: 'text', text });
    }
    for (const img of images) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.base64Data,
        },
      });
    }
  } else {
    blocks.push({ type: 'text', text });
  }

  return blocks;
}

/**
 * Build messages with cache_control breakpoints for Anthropic prompt caching.
 * Sets cache_control on the last message in each "turn" to maximize cache reuse.
 */
export function buildCachedMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
  cacheConfig?: Partial<CacheControlConfig>,
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const config: CacheControlConfig = {
    enabled: cacheConfig?.enabled ?? true,
    breakpoints: cacheConfig?.breakpoints ?? new Set(),
  };

  if (!config.enabled) return messages;

  const cached = messages.map((msg, i) => {
    if (!config.breakpoints.has(i)) return msg;

    if (typeof msg.content === 'string') {
      const blocks: Array<TextContentBlock | Record<string, unknown>> = [
        { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } },
      ];
      return { ...msg, content: blocks };
    }

    if (Array.isArray(msg.content)) {
      // Add cache_control to the last block in the array
      const blocks = [...msg.content] as Array<Record<string, unknown>>;
      if (blocks.length > 0) {
        const lastBlock = { ...blocks[blocks.length - 1] };
        lastBlock.cache_control = { type: 'ephemeral' };
        blocks[blocks.length - 1] = lastBlock;
      }
      return { ...msg, content: blocks };
    }

    return msg;
  });

  return cached;
}

/**
 * Compute optimal cache breakpoint indices for a conversation.
 * Anthropic recommends caching the last turn plus system prompt.
 */
export function computeBreakpoints(
  messageCount: number,
  strategy: 'last-turn' | 'all-turns' | 'minimal' = 'last-turn',
): Set<number> {
  const breakpoints = new Set<number>();

  switch (strategy) {
    case 'last-turn':
      // Cache the last 2 messages (user + assistant pair)
      if (messageCount >= 1) breakpoints.add(messageCount - 1);
      if (messageCount >= 2) breakpoints.add(messageCount - 2);
      break;
    case 'all-turns':
      // Cache every other message
      for (let i = 0; i < messageCount; i += 2) {
        breakpoints.add(i);
      }
      break;
    case 'minimal':
      // Cache only the last message
      if (messageCount >= 1) breakpoints.add(messageCount - 1);
      break;
  }

  return breakpoints;
}

export class AnthropicProvider {
  private client: Anthropic;
  private model: string;
  private cacheEnabled: boolean;
  private cacheStrategy: 'last-turn' | 'all-turns' | 'minimal';
  public cacheReadTokens: number = 0;
  public cacheWriteTokens: number = 0;

  constructor(config: ProviderConfig, cacheOptions?: { enabled?: boolean; strategy?: 'last-turn' | 'all-turns' | 'minimal' }) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.model = config.model;
    this.cacheEnabled = cacheOptions?.enabled ?? true;
    this.cacheStrategy = cacheOptions?.strategy ?? 'last-turn';
  }

  async chat(
    system: string,
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
    tools?: ToolDefinition[],
    maxTokens = 8192,
  ): Promise<AnthropicResponse> {
    // Apply cache_control to system prompt (always cache system)
    const systemWithCache: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = this.cacheEnabled
      ? [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }]
      : system;

    // Compute breakpoints for messages
    const breakpoints = this.cacheEnabled
      ? computeBreakpoints(messages.length, this.cacheStrategy)
      : new Set<number>();

    const cachedMessages = this.cacheEnabled
      ? buildCachedMessages(messages, { enabled: true, breakpoints })
      : messages;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system: systemWithCache,
      messages: cachedMessages as Anthropic.MessageParam[],
      ...(tools?.length ? { tools: tools as Anthropic.Tool[] } : {}),
    });

    // Track cache usage from response
    const usage = response.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    this.cacheReadTokens += cacheRead;
    this.cacheWriteTokens += cacheWrite;

    return {
      content: response.content as AnthropicResponse['content'],
      stop_reason: response.stop_reason ?? 'end_turn',
      usage: response.usage,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    };
  }

  /** Get total cache savings (tokens that were read from cache instead of being processed) */
  getCacheSavings(): { readTokens: number; writeTokens: number; estimatedCostSaved: number } {
    // Anthropic charges $1.25/MTok for cache writes, $0.10/MTok for cache reads (vs $3/MTok standard input)
    const writeCost = (this.cacheWriteTokens / 1_000_000) * 1.25;
    const readCost = (this.cacheReadTokens / 1_000_000) * 0.10;
    const standardCost = ((this.cacheReadTokens + this.cacheWriteTokens) / 1_000_000) * 3;
    const saved = standardCost - (writeCost + readCost);

    return {
      readTokens: this.cacheReadTokens,
      writeTokens: this.cacheWriteTokens,
      estimatedCostSaved: Math.max(0, saved),
    };
  }

  /** Reset cache token counters */
  resetCacheTracking(): void {
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
  }
}
