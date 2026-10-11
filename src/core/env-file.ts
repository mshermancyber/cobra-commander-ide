import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the installation root — the directory that holds package.json, .env
 * and the src/ tree. Everything that needs "where is Cobra Commander installed"
 * goes through here instead of an absolute path.
 */
export function installRoot(): string {
  if (process.env.CC_HOME) return resolve(process.env.CC_HOME);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Absolute path to the .env file Cobra Commander reads its secrets from. */
export function envFilePath(): string {
  return process.env.CC_ENV_FILE || join(installRoot(), '.env');
}

/**
 * Parse a dotenv-style file into a map. Supports `#` comments, blank lines,
 * `export KEY=value` prefixes and single/double quoted values.
 */
export function parseEnvFile(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

/** Read the .env file into a map. Returns an empty map when it does not exist. */
export function readEnvFile(envPath = envFilePath()): Map<string, string> {
  if (!existsSync(envPath)) return new Map();
  try {
    return parseEnvFile(readFileSync(envPath, 'utf-8'));
  } catch {
    return new Map();
  }
}

let loaded = false;

/**
 * Load .env into process.env. Real environment variables always win, so a
 * shell export or a systemd Environment= line overrides the file. Idempotent.
 */
export function loadEnvFile(envPath = envFilePath()): void {
  if (loaded && envPath === envFilePath()) return;
  for (const [key, value] of readEnvFile(envPath)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  if (envPath === envFilePath()) loaded = true;
}

/** Read a single value from the environment, falling back to the .env file. */
export function envValue(key: string, envPath = envFilePath()): string | undefined {
  if (process.env[key]) return process.env[key];
  return readEnvFile(envPath).get(key) || undefined;
}
