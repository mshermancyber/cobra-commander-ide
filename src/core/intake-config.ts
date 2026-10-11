import { join } from 'node:path';
import type { ProviderConfig } from './config.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { resolveWorkerKey } from './key-vault.js';
import { envFilePath, installRoot, readEnvFile } from './env-file.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from './config.js';

interface IntakeProviderState {
  config: ProviderConfig;
  provider: OpenAICompatibleProvider | null;
}

let state: IntakeProviderState = {
  config: { apiKey: '', baseUrl: '', model: '' },
  provider: null,
};

function loadFromEnv(): ProviderConfig {
  const envVars = readEnvFile(envFilePath());
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = process.env[name] || envVars.get(name);
      if (value) return value;
    }
    return undefined;
  };

  return {
    apiKey: pick('INTAKE_API_KEY') || '',
    baseUrl: pick('INTAKE_BASE_URL', 'INTAKE_PROVIDER_URL', 'WORKER_BASE_URL', 'OPENAI_BASE_URL')
      || DEFAULT_BASE_URL,
    model: pick('INTAKE_MODEL', 'WORKER_MODEL', 'OPENAI_MODEL') || DEFAULT_MODEL,
  };
}

export async function getIntakeProvider(): Promise<OpenAICompatibleProvider> {
  if (state.provider && state.config.apiKey) return state.provider;

  state.config = loadFromEnv();

  if (!state.config.apiKey) {
    const vaultKey = await resolveWorkerKey(envFilePath()).catch(() => null);
    if (vaultKey) state.config.apiKey = vaultKey;
  }

  if (!state.config.apiKey) {
    throw new Error('No API key available for intake agent. Set INTAKE_API_KEY or ensure worker key is configured.');
  }

  state.provider = new OpenAICompatibleProvider(state.config);
  return state.provider;
}

export function getIntakeConfig(): ProviderConfig {
  if (!state.config.apiKey) {
    state.config = loadFromEnv();
  }
  return { ...state.config };
}

export function updateIntakeConfig(update: Partial<ProviderConfig>): ProviderConfig {
  if (update.apiKey !== undefined) state.config.apiKey = update.apiKey;
  if (update.baseUrl !== undefined) state.config.baseUrl = update.baseUrl;
  if (update.model !== undefined) state.config.model = update.model;
  state.provider = null;
  return { ...state.config };
}

export function reloadIntakeConfig(): ProviderConfig {
  state.config = loadFromEnv();
  state.provider = null;
  return { ...state.config };
}
