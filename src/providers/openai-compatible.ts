import type { ProviderConfig } from '../core/config.js';
import type { ToolDefinition } from '../core/types.js';
import { isPrivateIP } from '../core/url-validator.js';
import { circuitBreaker } from '../core/circuit-breaker.js';
import { chatCompletionsUrl } from '../core/api-endpoint.js';

type OAIContent = string | null | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
>;

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: OAIContent;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OAIResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface WorkerResponse {
  text: string | null;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  finishReason: string;
  usage: { input: number; output: number };
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

/** Cache tracking for OpenAI-compatible providers */
export interface CacheTracking {
  cacheHitTokens: number;
  cacheMissTokens: number;
  estimatedCostSaved: number;
}

const MAX_RETRIES = 3;
// Connection-level failures get a longer window: 3 quick retries (~3 s) lost whole worker
// attempts to a ~15 s network blip. 6 attempts back off 1+2+4+8+16 s ≈ 31 s.
const NETWORK_MAX_RETRIES = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

// Timeouts: env-overridable defaults — 30 min request, 180 s SSE idle
const REQUEST_TIMEOUT_MS =
  parseInt(process.env.CC_LLM_REQUEST_TIMEOUT_MS || '1800000', 10) || 1_800_000;
const SSE_IDLE_TIMEOUT_MS =
  parseInt(process.env.CC_LLM_IDLE_TIMEOUT_MS || '180000', 10) || 180_000;

/**
 * Parse the Retry-After header value (seconds) or Retry-After-Ms (milliseconds).
 * Returns milliseconds to wait, or null if no valid header found.
 */
function parseRetryAfter(headers: Headers): number | null {
  const afterMs = headers.get('Retry-After-Ms') || headers.get('retry-after-ms');
  if (afterMs) {
    const ms = parseInt(afterMs, 10);
    if (!isNaN(ms) && ms > 0) {
      return Math.min(ms, MAX_DELAY_MS);
    }
  }

  const afterSec = headers.get('Retry-After') || headers.get('retry-after');
  if (afterSec) {
    const sec = parseInt(afterSec, 10);
    if (!isNaN(sec) && sec > 0) {
      return Math.min(sec * 1000, MAX_DELAY_MS);
    }

    // Retry-After can also be a HTTP-date
    const date = Date.parse(afterSec);
    if (!isNaN(date)) {
      const delay = date - Date.now();
      if (delay > 0) {
        return Math.min(delay, MAX_DELAY_MS);
      }
    }
  }

  return null;
}

/**
 * Compute exponential backoff delay: baseDelay * 2^(attempt-1) with jitter.
 */
function exponentialBackoff(attempt: number, baseDelay: number = BASE_DELAY_MS): number {
  const exp = Math.min(Math.pow(2, attempt - 1), 16);
  const delay = baseDelay * exp;
  const jitter = delay * 0.3 * Math.random();
  return Math.min(delay + jitter, MAX_DELAY_MS);
}

function validateApiUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Invalid protocol: ${parsed.protocol}`);
    }
    // Block cloud metadata endpoints
    const blocked = ['169.254.169.254', 'metadata.google.internal', 'metadata.internal', '100.100.100.200'];
    if (blocked.some(b => parsed.hostname === b || parsed.hostname.endsWith('.' + b))) {
      throw new Error(`Blocked metadata endpoint: ${parsed.hostname}`);
    }
    // Block private/internal IPs (SSRF prevention)
    if (isPrivateIP(parsed.hostname)) {
      throw new Error(`Blocked private IP: ${parsed.hostname}`);
    }
  } catch (err) {
    if ((err as Error).message.includes('Invalid URL')) {
      throw new Error(`Invalid API URL: ${url}`);
    }
    throw err;
  }
}

export interface RetryHook {
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  onExhausted?: (attempts: number, lastError: string) => void;
}

export class OpenAICompatibleProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private cacheEnabled: boolean;
  public cacheHitTokens: number = 0;
  public cacheMissTokens: number = 0;
  public retryHook?: RetryHook;

  constructor(config: ProviderConfig, cacheOptions?: { enabled?: boolean }) {
    this.baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    validateApiUrl(this.baseUrl);
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.cacheEnabled = cacheOptions?.enabled ?? true;
  }

  async chat(
    systemPrompt: string,
    messages: OAIMessage[],
    tools?: ToolDefinition[],
    maxTokens = 8192,
    onToken?: (text: string) => void,
  ): Promise<WorkerResponse> {
    const oaiMessages: OAIMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const oaiTools = tools?.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const body: Record<string, unknown> = {
      model: this.model,
      messages: oaiMessages,
      max_tokens: maxTokens,
      temperature: 0.1,
      stream: true,
    };

    if (oaiTools?.length) {
      body.tools = oaiTools;
      body.tool_choice = 'auto';
    }

    // Prompt caching: some OpenAI-compatible providers (the worker model) support prefix caching
    // via the 'cached_tokens' fields. We track any cache-related usage returned.
    if (this.cacheEnabled) {
      // the worker model supports automatic prefix caching — no special header needed,
      // but we track cache hit/miss tokens from the response
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= NETWORK_MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetch(chatCompletionsUrl(this.baseUrl), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err as Error;
        if (attempt < NETWORK_MAX_RETRIES) {
          const delay = exponentialBackoff(attempt);
          this.retryHook?.onRetry?.(attempt, delay, lastError.message);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        this.retryHook?.onExhausted?.(NETWORK_MAX_RETRIES, lastError.message);
        throw new Error(`Worker API fetch failed after ${NETWORK_MAX_RETRIES} attempts: ${lastError.message}`);
      }

      if (response.ok) {
        circuitBreaker.recordSuccess();
        // Success path — process the response
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
          const data = await response.json() as OAIResponse;
          const choice = data.choices[0];

          const toolCalls = (choice.message.tool_calls || []).map(tc => ({
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          }));

          const usageData = data.usage as Record<string, unknown> | undefined;
          const cacheHit = (usageData?.cache_read_input_tokens as number) || (usageData?.cached_tokens as number) || 0;
          const cacheMiss = usageData?.prompt_tokens_details
            ? ((usageData.prompt_tokens_details as Record<string, number>)?.cached_tokens || 0)
            : 0;
          this.cacheHitTokens += cacheHit;
          this.cacheMissTokens += Math.max(0, ((data.usage?.prompt_tokens as number) || 0) - cacheHit);

          return {
            text: choice.message.content,
            toolCalls,
            finishReason: choice.finish_reason,
            usage: {
              input: data.usage.prompt_tokens,
              output: data.usage.completion_tokens,
            },
            cacheHitTokens: cacheHit,
            cacheMissTokens: this.cacheMissTokens,
          };
        }

        // SSE streaming path (response.ok)
        return this.parseSSEStream(response, onToken);
      }

      // Non-ok response — check if retryable
      if (attempt < MAX_RETRIES && (response.status === 429 || response.status >= 500)) {
        const serverDelay = parseRetryAfter(response.headers);
        const delay = serverDelay ?? exponentialBackoff(attempt);
        const text = await response.text().catch(() => '');
        lastError = new Error(`Worker API error (${response.status}): ${text.slice(0, 200)}`);
        const reason = response.status === 429 ? 'rate_limited' : `server_error_${response.status}`;
        this.retryHook?.onRetry?.(attempt, delay, reason);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // Non-retryable or last attempt
      const text = await response.text().catch(() => '');
      const errMsg = `Worker API error (${response.status}): ${text.slice(0, 500)}`;
      this.retryHook?.onExhausted?.(attempt, errMsg);
      throw new Error(errMsg);
    }

    // Should not reach here, but TypeScript needs it
    throw lastError || new Error('Worker API request failed');
  }

  private async parseSSEStream(
    response: Response,
    onToken?: (text: string) => void,
  ): Promise<WorkerResponse> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let fullText = '';
    let reasoningLength = 0;
    let finishReason = '';
    let usage: { input: number; output: number } | null = null;

    // Accumulate tool calls across chunks
    // Keyed by index in the choices[0].delta.tool_calls array
    const toolCallAccumulators: Map<number, {
      id: string;
      name: string;
      arguments: string;
    }> = new Map();

    // Read-idle timeout: cancel reader if no chunk arrives within SSE_IDLE_TIMEOUT_MS
    let idleExpired = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleExpired = true;
        reader.cancel().catch(() => {});
      }, SSE_IDLE_TIMEOUT_MS);
      if (idleTimer.unref) idleTimer.unref();
    };

    resetIdleTimer();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdleTimer();

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines in the buffer
      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // SSE data lines start with "data: "
        if (!trimmed.startsWith('data: ')) continue;

        const payload = trimmed.slice(6); // Remove "data: " prefix

        // End-of-stream marker
        if (payload === '[DONE]') continue;

        // Parse the JSON chunk
        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          // Malformed chunk, skip
          continue;
        }

        const choice = chunk.choices?.[0];
        if (!choice) {
          // Some providers send usage in a separate chunk without choices
          if (chunk.usage) {
            usage = {
              input: chunk.usage.prompt_tokens ?? 0,
              output: chunk.usage.completion_tokens ?? 0,
            };
          }
          continue;
        }

        const delta = choice.delta || {};

        // Accumulate text (skip reasoning_content — only capture final output)
        if (delta.content) {
          fullText += delta.content;
          if (onToken) {
            onToken(delta.content);
          }
        }

        // Track reasoning tokens for usage but don't emit them
        if (delta.reasoning_content) {
          reasoningLength += delta.reasoning_content.length;
        }

        // Accumulate tool calls
        if (delta.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const index = tcDelta.index ?? 0;

            if (!toolCallAccumulators.has(index)) {
              toolCallAccumulators.set(index, {
                id: tcDelta.id || '',
                name: tcDelta.function?.name || '',
                arguments: tcDelta.function?.arguments || '',
              });
            } else {
              const acc = toolCallAccumulators.get(index)!;
              if (tcDelta.id) acc.id = tcDelta.id;
              if (tcDelta.function?.name) acc.name = tcDelta.function.name;
              if (tcDelta.function?.arguments) {
                acc.arguments += tcDelta.function.arguments;
              }
            }
          }
        }

        // Track finish reason
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        // Some providers include usage in the last data chunk
        if (chunk.usage) {
          usage = {
            input: chunk.usage.prompt_tokens ?? 0,
            output: chunk.usage.completion_tokens ?? 0,
          };
        }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }

    if (idleExpired) {
      throw new Error(`SSE idle timeout — no data for ${SSE_IDLE_TIMEOUT_MS / 1000}s`);
    }

    // Process any remaining data in the buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ')) {
        const payload = trimmed.slice(6);
        if (payload !== '[DONE]') {
          try {
            const chunk = JSON.parse(payload);
            if (chunk.usage) {
              usage = {
                input: chunk.usage.prompt_tokens ?? 0,
                output: chunk.usage.completion_tokens ?? 0,
              };
            }
          } catch { /* ignore */ }
        }
      }
    }

    // Build tool calls from accumulators
    const toolCalls: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];

    for (const [, acc] of toolCallAccumulators) {
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = JSON.parse(acc.arguments);
      } catch {
        // If arguments are not valid JSON, use as-is
        parsedInput = { _raw: acc.arguments };
      }
      toolCalls.push({
        id: acc.id,
        name: acc.name,
        input: parsedInput,
      });
    }

    // Estimate usage if not provided by the API
    if (!usage) {
      // Rough estimate: ~4 chars per token for text
      const estimatedOutput = Math.max(1, Math.ceil(fullText.length / 4));
      usage = { input: 0, output: estimatedOutput };
    }

    return {
      text: fullText || null,
      toolCalls,
      finishReason: finishReason || 'stop',
      usage,
      cacheHitTokens: this.cacheHitTokens,
      cacheMissTokens: this.cacheMissTokens,
    };
  }

  /** Get total cache tracking info */
  getCacheTracking(): CacheTracking {
    // the worker model charges ~$0.14/MTok for cache hits vs $0.27/MTok for misses
    const standardCost = ((this.cacheHitTokens + this.cacheMissTokens) / 1_000_000) * 0.27;
    const cachedCost = (this.cacheHitTokens / 1_000_000) * 0.14 + (this.cacheMissTokens / 1_000_000) * 0.27;
    const saved = Math.max(0, standardCost - cachedCost);

    return {
      cacheHitTokens: this.cacheHitTokens,
      cacheMissTokens: this.cacheMissTokens,
      estimatedCostSaved: saved,
    };
  }

  /** Reset cache tracking counters */
  resetCacheTracking(): void {
    this.cacheHitTokens = 0;
    this.cacheMissTokens = 0;
  }
}
