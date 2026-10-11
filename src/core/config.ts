import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getProfile, applyProfile } from './config-profiles.js';
import { resolveWorkerKey } from './key-vault.js';
import { envFilePath, installRoot, loadEnvFile, readEnvFile } from './env-file.js';
import { KeyRotator } from './key-rotator.js';

loadEnvFile();

/** Default OpenAI-compatible gateway. Override with OPENAI_BASE_URL. */
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** Default model. Override with OPENAI_MODEL. */
export const DEFAULT_MODEL = 'gpt-5.1';

/**
 * Configuration for a model provider (any OpenAI-compatible gateway, or Anthropic).
 */
export interface ProviderConfig {
  /** API key for authentication */
  apiKey: string;
  /** Optional base URL override for the provider's API */
  baseUrl?: string;
  /** Model identifier to use */
  model: string;
}

/**
 * An entry in the worker pool defining a named worker tier.
 */
export interface WorkerPoolEntry {
  /** Human-readable name for this worker configuration */
  name: string;
  /** Provider configuration for the worker's LLM backend */
  provider: ProviderConfig;
  /** Performance/cost tier: fast (cheap/simple), standard (balanced), heavy (powerful) */
  tier: 'fast' | 'standard' | 'heavy';
}

/**
 * Post-delegation verification configuration.
 */
export interface VerificationConfig {
  /** Shell commands to run for verification (e.g., ['npx tsc --noEmit', 'npm run lint']) */
  commands?: string[];
  /** Timeout in seconds for verification commands (default 60) */
  timeout?: number;
  /** Whether warnings should be treated as failures (default false) */
  failOnWarnings?: boolean;
  /** Regex patterns to ignore in command output */
  skipPatterns?: string[];
}

/**
 * Webhook server configuration for GitLab/GitHub integrations.
 */
export interface WebhookConfig {
  /** Port for the webhook server to listen on */
  port: number;
  /** Optional shared secret for webhook payload verification */
  secret?: string;
  /** GitLab personal access token for API operations */
  gitlabToken?: string;
  /** Whether to automatically trigger security scans on push events */
  autoScan: boolean;
  /** Optional path to restrict scans to */
  scanPath?: string;
}

/**
 * Represents a registered project in the multi-project system.
 */
export interface ProjectEntry {
  /** Display name for the project */
  name: string;
  /** Absolute filesystem path to the project root */
  path: string;
  /** Unix timestamp when the project was added */
  addedAt: number;
  /** Unix timestamp of last activation (set when switched to) */
  lastUsedAt?: number;
}

/**
 * Configuration for the multi-project management system.
 */
export interface MultiProjectConfig {
  /** All registered projects */
  projects: ProjectEntry[];
  /** Name of the currently active project (empty string if none) */
  activeProject: string;
}

/**
 * Top-level Cobra Commander configuration. Loaded from ~/.cobra-commander/config.json
 * with environment variable overrides and optional profile application.
 */
export interface Config {
  orchestrator: ProviderConfig;
  worker: ProviderConfig;
  workerPool: WorkerPoolEntry[];
  /** Where CC is installed — config, .env, vault all live here */
  homeDir: string;
  /** The project being worked on — workers read/write here */
  workDir: string;
  additionalDirs: string[];
  maxWorkerTurns: number;
  maxOrchestratorTurns: number;
  maxRetries: number;
  commandTimeout: number;
  verbose: boolean;
  autoScan?: boolean;
  autoCommitEnabled?: boolean;
  autoFeatureBranch?: boolean;
  crossModelVerify?: boolean;
  costAwareRouting?: boolean;
  autoRetry?: boolean;
  verification?: VerificationConfig;
  fallbackChain?: string[];    // ordered list of model names to try on failure
  profile?: string;            // named config profile to apply
  progressReportInterval?: number;
  progressReportEnabled?: boolean;
  autoCompact?: boolean;
  autoCompactKeepLast?: number;
  webhook?: WebhookConfig;
  projects?: MultiProjectConfig;
}

/**
 * Path to the behaviour config file. `CC_CONFIG_FILE` overrides it, which keeps
 * tests and alternate deployments off the invoking user's real config.
 */
function configPath(): string {
  return process.env.CC_CONFIG_FILE || join(homedir(), '.cobra-commander', 'config.json');
}

/**
 * Load and merge configuration from the config file and environment variables.
 * Applies named profile overrides if a profile is specified.
 *
 * @param overrides - Partial config values to override loaded settings
 * @returns Fully resolved configuration object
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  let fileConfig: any = {};

  const path = configPath();
  if (existsSync(path)) {
    try {
      fileConfig = JSON.parse(readFileSync(path, 'utf-8'));
    } catch { /* ignore bad config */ }
  }

  const defaultWorker: ProviderConfig = {
    apiKey: process.env.WORKER_API_KEY || process.env.OPENAI_API_KEY || (fileConfig.worker?.apiKey ?? ''),
    baseUrl: process.env.WORKER_BASE_URL || process.env.OPENAI_BASE_URL || fileConfig.worker?.baseUrl || DEFAULT_BASE_URL,
    model: process.env.WORKER_MODEL || process.env.OPENAI_MODEL || fileConfig.worker?.model || DEFAULT_MODEL,
  };

  // Strip any plaintext key from fileConfig — keys should come from env or the scanner
  if (fileConfig.worker?.apiKey) {
    delete fileConfig.worker.apiKey;
  }

  const workerPool: WorkerPoolEntry[] = fileConfig.workerPool || [
    { name: 'default', provider: defaultWorker, tier: 'standard' as const },
  ];

  const ccHome = overrides.homeDir || installRoot();

  const config: Config = {
    orchestrator: {
      apiKey: process.env.ORCHESTRATOR_API_KEY || process.env.WORKER_API_KEY || process.env.OPENAI_API_KEY || (fileConfig.orchestrator?.apiKey ?? ''),
      baseUrl: process.env.ORCHESTRATOR_BASE_URL || fileConfig.orchestrator?.baseUrl || defaultWorker.baseUrl,
      model: process.env.ORCHESTRATOR_MODEL || fileConfig.orchestrator?.model || DEFAULT_MODEL,
    },
    worker: defaultWorker,
    workerPool,
    homeDir: ccHome,
    workDir: overrides.workDir || process.cwd(),
    additionalDirs: overrides.additionalDirs || [],
    maxWorkerTurns: overrides.maxWorkerTurns ?? fileConfig.maxWorkerTurns ?? 300,
    maxOrchestratorTurns: overrides.maxOrchestratorTurns ?? fileConfig.maxOrchestratorTurns ?? 5,
    maxRetries: overrides.maxRetries ?? fileConfig.maxRetries ?? 3,
    commandTimeout: overrides.commandTimeout ?? fileConfig.commandTimeout ?? 30,
    verbose: overrides.verbose ?? fileConfig.verbose ?? false,
    autoScan: overrides.autoScan ?? fileConfig.autoScan ?? false,
    autoCommitEnabled: overrides.autoCommitEnabled ?? fileConfig.autoCommitEnabled ?? false,
    autoFeatureBranch: overrides.autoFeatureBranch ?? fileConfig.autoFeatureBranch ?? false,
    crossModelVerify: overrides.crossModelVerify ?? fileConfig.crossModelVerify ?? false,
    costAwareRouting: overrides.costAwareRouting ?? fileConfig.costAwareRouting ?? false,
    autoRetry: overrides.autoRetry ?? fileConfig.autoRetry ?? true,
    verification: overrides.verification ?? fileConfig.verification ?? {
      commands: ['npx tsc --noEmit'],
      timeout: 60,
      failOnWarnings: false,
      skipPatterns: [],
    },
    fallbackChain: overrides.fallbackChain ?? fileConfig.fallbackChain ?? undefined,
    profile: overrides.profile ?? fileConfig.profile ?? undefined,
    progressReportInterval: overrides.progressReportInterval ?? fileConfig.progressReportInterval ?? 240000,
    progressReportEnabled: overrides.progressReportEnabled ?? fileConfig.progressReportEnabled ?? true,
    autoCompact: overrides.autoCompact ?? fileConfig.autoCompact ?? true,
    autoCompactKeepLast: overrides.autoCompactKeepLast ?? fileConfig.autoCompactKeepLast ?? 3,
    webhook: overrides.webhook ?? fileConfig.webhook ?? undefined,
  };

  if (config.profile) {
    const profile = getProfile(config.profile, config.homeDir);
    if (profile) {
      return applyProfile(config, profile);
    }
  }

  return config;
}

/**
 * Hydrate the model API key from the environment or the .env file.
 *
 * Resolution order: OPENAI_API_KEY / WORKER_API_KEY in the real environment,
 * then the same keys in .env, then the sealed CC_WORKER_KEY in .env. Nothing
 * here reaches out to the network and no key is ever written into config.json.
 *
 * @param config - Configuration to hydrate (mutated in place)
 * @returns The same config object with keys populated
 */
export async function hydrateWorkerKey(config: Config): Promise<Config> {
  if (config.worker.apiKey) return config;

  // An explicit CC_ENV_FILE always wins; otherwise the .env beside the install.
  const envPath = process.env.CC_ENV_FILE
    ? envFilePath()
    : (config.homeDir ? join(config.homeDir, '.env') : envFilePath());
  const key = await resolveWorkerKey(envPath).catch(() => null);
  if (!key) return config;

  config.worker.apiKey = key;
  config.workerPool.forEach(w => {
    if (!w.provider.apiKey) w.provider.apiKey = key;
  });
  if (!config.orchestrator.apiKey) config.orchestrator.apiKey = key;
  return config;
}

/**
 * Read a named value from the environment, falling back to .env in the install
 * root. Used by subsystems that need a credential without loading full config.
 */
export function configValue(key: string): string | undefined {
  return process.env[key] || readEnvFile(envFilePath()).get(key) || undefined;
}

// ──────────────────────────────────────────────
// Key rotator for multi-key support
// ──────────────────────────────────────────────

let workerKeyRotator: KeyRotator | null = null;

/**
 * Initialise or retrieve the worker key rotator.
 * If WORKER_API_KEY contains commas, a round-robin KeyRotator is created.
 * Otherwise returns null for single-key fallback.
 */
export function getWorkerKeyRotator(): KeyRotator | null {
  if (workerKeyRotator) return workerKeyRotator;
  const raw = process.env.WORKER_API_KEY || '';
  if (raw.includes(',')) {
    workerKeyRotator = new KeyRotator(raw);
    return workerKeyRotator;
  }
  return null;
}

/**
 * Resolve the current active worker API key, taking the rotator into account.
 * Returns the single key if no rotator is configured.
 */
export function getNextWorkerKey(): string | null {
  const rotator = getWorkerKeyRotator();
  if (rotator) return rotator.getNextKey();
  const raw = process.env.WORKER_API_KEY || '';
  return raw || null;
}

/**
 * Report a 429 rate limit on a key, placing it on cooldown.
 */
export function reportWorkerKeyRateLimit(key: string): void {
  const rotator = getWorkerKeyRotator();
  if (rotator) rotator.reportRateLimit(key);
}

/**
 * Load project memory from the .cobra-commander/context.md file.
 * This provides persistent context about the project to the orchestrator.
 *
 * @param workDir - Working directory to search for the context file
 * @returns The contents of the context file, or null if it doesn't exist
 */
export function loadProjectMemory(workDir: string, homeDir?: string): string | null {
  const projectPath = join(workDir, '.cobra-commander', 'context.md');
  if (existsSync(projectPath)) {
    try {
      return readFileSync(projectPath, 'utf-8');
    } catch { /* fall through */ }
  }
  if (homeDir && homeDir !== workDir) {
    const homePath = join(homeDir, '.cobra-commander', 'context.md');
    if (existsSync(homePath)) {
      try {
        return readFileSync(homePath, 'utf-8');
      } catch { return null; }
    }
  }
  return null;
}

// ──────────────────────────────────────────────
// Multi-project support
// ──────────────────────────────────────────────

const PROJECTS_CONFIG_PATH = join(homedir(), '.cobra-commander', 'projects.json');

/**
 * Load the multi-project configuration from disk.
 *
 * @returns Multi-project configuration with registered projects
 */
export function loadProjectsConfig(): MultiProjectConfig {
  if (existsSync(PROJECTS_CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(PROJECTS_CONFIG_PATH, 'utf-8'));
      return {
        projects: raw.projects || [],
        activeProject: raw.activeProject || '',
      };
    } catch { /* ignore */ }
  }
  return { projects: [], activeProject: '' };
}

/**
 * Persist the multi-project configuration to disk.
 *
 * @param config - Configuration to save
 */
export function saveProjectsConfig(config: MultiProjectConfig): void {
  const dir = join(homedir(), '.cobra-commander');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(PROJECTS_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Register a new project (or replace an existing one with the same name/path).
 * Sets as active if no project is currently active.
 *
 * @param name - Display name for the project
 * @param path - Absolute filesystem path to the project root
 * @returns Updated multi-project configuration
 */
export function addProject(name: string, path: string): MultiProjectConfig {
  const config = loadProjectsConfig();

  // Remove existing project with same name or path
  config.projects = config.projects.filter(p => p.name !== name && p.path !== path);

  config.projects.push({
    name,
    path,
    addedAt: Date.now(),
  });

  if (!config.activeProject) {
    config.activeProject = name;
  }

  saveProjectsConfig(config);
  return config;
}

/**
 * Remove a project from the registry by name.
 * If the removed project was active, activates the first remaining project.
 *
 * @param name - Name of the project to remove
 * @returns Updated multi-project configuration
 */
export function removeProject(name: string): MultiProjectConfig {
  const config = loadProjectsConfig();
  config.projects = config.projects.filter(p => p.name !== name);

  if (config.activeProject === name) {
    config.activeProject = config.projects[0]?.name || '';
  }

  saveProjectsConfig(config);
  return config;
}

/**
 * Switch the active project to the named project.
 *
 * @param name - Name of the project to activate
 * @returns The activated project entry, or null if not found
 */
export function switchProject(name: string): ProjectEntry | null {
  const config = loadProjectsConfig();
  const project = config.projects.find(p => p.name === name);

  if (project) {
    config.activeProject = name;
    project.lastUsedAt = Date.now();
    saveProjectsConfig(config);
    return project;
  }

  return null;
}

/**
 * Get the currently active project entry.
 *
 * @returns The active project, or null if none is set
 */
export function getActiveProject(): ProjectEntry | null {
  const config = loadProjectsConfig();
  if (!config.activeProject) return null;
  return config.projects.find(p => p.name === config.activeProject) || null;
}

/**
 * List all registered projects.
 *
 * @returns Array of project entries
 */
export function listProjects(): ProjectEntry[] {
  return loadProjectsConfig().projects;
}
