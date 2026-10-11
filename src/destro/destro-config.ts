import { resolveWorkerKey } from '../core/key-vault.js';
import { envFilePath, readEnvFile } from '../core/env-file.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../core/config.js';

/**
 * Provider configuration for the Destro agent's LLM backend.
 * Mirrors src/core/config.ts ProviderConfig.
 */
export interface DestroProviderConfig {
  /** API key for authentication */
  apiKey: string;
  /** Optional base URL override for the provider's API */
  baseUrl?: string;
  /** Model identifier to use */
  model: string;
}

/**
 * Top-level Destro agent configuration.
 * Resolved from DESTRO_* environment variables, /.env, and key vault.
 */
export interface DestroConfig {
  /** Primary provider configuration */
  provider: DestroProviderConfig;
  /** Optional fallback provider name/base URL (e.g. 'anthropic', 'https://api.openai.com') */
  fallbackProvider?: string;
  /** Optional fallback model identifier */
  fallbackModel?: string;
  /** Working directory for Destro operations */
  workDir: string;
  /** Maximum agent turns before auto-termination */
  maxTurns: number;
  /** Shell command timeout in seconds */
  commandTimeout: number;
  /** Verbose logging mode */
  verbose: boolean;
}

const ENV_PATH = envFilePath();

function firstOf(...values: Array<string | undefined | null>): string {
  for (const v of values) {
    if (v && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Load Destro agent configuration from environment variables,
 * the /.env file, and the key vault (for the API key).
 *
 * Fallback chain per field:
 *   provider:         DESTRO_PROVIDER env → .env → WORKER_BASE_URL → OPENAI_BASE_URL → default
 *   model:            DESTRO_MODEL env → .env → WORKER_MODEL → OPENAI_MODEL → default
 *   apiKey:           DESTRO_API_KEY env → .env → key vault (resolveWorkerKey) → ''
 *   baseUrl:          DESTRO_BASE_URL env → .env → provider default
 *   fallbackProvider: DESTRO_FALLBACK_PROVIDER env → .env → ''
 *   fallbackModel:    DESTRO_FALLBACK_MODEL env → .env → ''
 *
 * @param overrides - Partial config values to override resolved settings
 * @returns Fully resolved Destro configuration
 */
export async function loadDestroConfig(overrides: Partial<DestroConfig> = {}): Promise<DestroConfig> {
  const dotenv = readEnvFile(ENV_PATH);

  const provider = firstOf(
    overrides.provider?.baseUrl,
    process.env.DESTRO_PROVIDER,
    dotenv.get('DESTRO_PROVIDER'),
    process.env.WORKER_BASE_URL,
    process.env.OPENAI_BASE_URL,
    dotenv.get('OPENAI_BASE_URL'),
    DEFAULT_BASE_URL,
  );

  const model = firstOf(
    overrides.provider?.model,
    process.env.DESTRO_MODEL,
    dotenv.get('DESTRO_MODEL'),
    process.env.WORKER_MODEL,
    process.env.OPENAI_MODEL,
    dotenv.get('OPENAI_MODEL'),
    DEFAULT_MODEL,
  );

  const apiKey = firstOf(
    overrides.provider?.apiKey,
    process.env.DESTRO_API_KEY,
    dotenv.get('DESTRO_API_KEY'),
    await resolveWorkerKey(ENV_PATH).catch(() => null),
  );

  const baseUrl = firstOf(
    process.env.DESTRO_BASE_URL,
    dotenv.get('DESTRO_BASE_URL'),
    provider,
  );

  const fallbackProvider = firstOf(
    overrides.fallbackProvider,
    process.env.DESTRO_FALLBACK_PROVIDER,
    dotenv.get('DESTRO_FALLBACK_PROVIDER'),
  );

  const fallbackModel = firstOf(
    overrides.fallbackModel,
    process.env.DESTRO_FALLBACK_MODEL,
    dotenv.get('DESTRO_FALLBACK_MODEL'),
  );

  const providerConfig: DestroProviderConfig = { apiKey, baseUrl, model };

  return {
    provider: providerConfig,
    fallbackProvider: fallbackProvider || undefined,
    fallbackModel: fallbackModel || undefined,
    workDir: overrides.workDir || process.cwd(),
    maxTurns: overrides.maxTurns ??
      parseInt(firstOf(process.env.DESTRO_MAX_TURNS, dotenv.get('DESTRO_MAX_TURNS'), '40'), 10),
    commandTimeout: overrides.commandTimeout ?? 30,
    verbose: overrides.verbose ?? false,
  };
}
