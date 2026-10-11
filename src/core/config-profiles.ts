import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from './config.js';

export interface ConfigProfile {
  name: string;
  description: string;
  flags: {
    autoScan?: boolean;
    autoCommit?: boolean;
    crossModelVerify?: boolean;
    costAwareRouting?: boolean;
    autoFeatureBranch?: boolean;
    shellPermission?: 'allow-all' | 'deny-dangerous' | 'ask-all';
    fastPath?: boolean;
    maxWorkerTurns?: number;
    maxRetries?: number;
    workerModel?: string;
    verbose?: boolean;
  };
}

const BUILTIN_PROFILES: ConfigProfile[] = [
  {
    name: 'security',
    description: 'Security-focused: auto-scan, verify changes, careful shell permissions',
    flags: {
      autoScan: true,
      shellPermission: 'ask-all',
      crossModelVerify: true,
      autoFeatureBranch: true,
    },
  },
  {
    name: 'fast',
    description: 'Speed-focused: fast path enabled, fewer turns, cost routing',
    flags: {
      fastPath: true,
      maxWorkerTurns: 15,
      costAwareRouting: true,
      shellPermission: 'allow-all',
    },
  },
  {
    name: 'thorough',
    description: 'Quality-focused: cross-model verify, more turns, no auto-commit',
    flags: {
      crossModelVerify: true,
      maxWorkerTurns: 35,
      maxRetries: 3,
      autoCommit: false,
    },
  },
  {
    name: 'review',
    description: 'Code review mode: scan + verify, verbose output, no auto-commit',
    flags: {
      autoScan: true,
      crossModelVerify: true,
      autoCommit: false,
      verbose: true,
    },
  },
];

export function getBuiltinProfiles(): ConfigProfile[] {
  return BUILTIN_PROFILES.map(p => ({ ...p, flags: { ...p.flags } }));
}

function getProfilesDir(workDir: string): string {
  return join(workDir, '.cobra-commander', 'profiles');
}

export function loadCustomProfiles(workDir: string): ConfigProfile[] {
  const profilesDir = getProfilesDir(workDir);
  if (!existsSync(profilesDir)) {
    return [];
  }

  const profiles: ConfigProfile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(profilesDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = join(profilesDir, entry);
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      // Validate required fields
      if (data && typeof data.name === 'string' && typeof data.description === 'string' && data.flags) {
        profiles.push({
          name: data.name,
          description: data.description,
          flags: {
            autoScan: data.flags.autoScan ?? undefined,
            autoCommit: data.flags.autoCommit ?? undefined,
            crossModelVerify: data.flags.crossModelVerify ?? undefined,
            costAwareRouting: data.flags.costAwareRouting ?? undefined,
            autoFeatureBranch: data.flags.autoFeatureBranch ?? undefined,
            shellPermission: data.flags.shellPermission ?? undefined,
            fastPath: data.flags.fastPath ?? undefined,
            maxWorkerTurns: data.flags.maxWorkerTurns ?? undefined,
            maxRetries: data.flags.maxRetries ?? undefined,
            workerModel: data.flags.workerModel ?? undefined,
            verbose: data.flags.verbose ?? undefined,
          },
        });
      }
    } catch {
      // Skip invalid profile files
    }
  }

  return profiles;
}

export function getProfile(name: string, workDir: string): ConfigProfile | null {
  // Check built-in first
  const builtin = BUILTIN_PROFILES.find(p => p.name === name);
  if (builtin) return { ...builtin, flags: { ...builtin.flags } };

  // Check custom profiles
  const custom = loadCustomProfiles(workDir);
  const found = custom.find(p => p.name === name);
  if (found) return found;

  return null;
}

export function applyProfile(config: Config, profile: ConfigProfile): Config {
  const f = profile.flags;

  if (f.autoScan !== undefined) config.autoScan = f.autoScan;
  if (f.autoCommit !== undefined) config.autoCommitEnabled = f.autoCommit;
  if (f.crossModelVerify !== undefined) config.crossModelVerify = f.crossModelVerify;
  if (f.costAwareRouting !== undefined) config.costAwareRouting = f.costAwareRouting;
  if (f.autoFeatureBranch !== undefined) config.autoFeatureBranch = f.autoFeatureBranch;
  if (f.maxWorkerTurns !== undefined) config.maxWorkerTurns = f.maxWorkerTurns;
  if (f.maxRetries !== undefined) config.maxRetries = f.maxRetries;
  if (f.workerModel !== undefined) config.worker.model = f.workerModel;
  if (f.verbose !== undefined) config.verbose = f.verbose;

  return config;
}

export function listProfiles(workDir: string): ConfigProfile[] {
  const builtin = getBuiltinProfiles();
  const custom = loadCustomProfiles(workDir);
  return [...builtin, ...custom];
}

export function saveProfile(workDir: string, profile: ConfigProfile): void {
  const profilesDir = getProfilesDir(workDir);
  if (!existsSync(profilesDir)) {
    mkdirSync(profilesDir, { recursive: true });
  }

  const filePath = join(profilesDir, `${profile.name}.json`);
  writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8');
}

export function deleteProfile(workDir: string, name: string): boolean {
  // Cannot delete built-in profiles
  if (BUILTIN_PROFILES.some(p => p.name === name)) {
    return false;
  }

  const profilesDir = getProfilesDir(workDir);
  const filePath = join(profilesDir, `${name}.json`);
  if (!existsSync(filePath)) {
    return false;
  }

  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
