import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { envFilePath, parseEnvFile, readEnvFile } from './env-file.js';

/**
 * Local API-key vault.
 *
 * The API key normally lives in plain text in .env (file-permission protected,
 * git-ignored). For installs that would rather not keep a plaintext key on
 * disk, the same key can be sealed with AES-256-GCM and stored as CC_WORKER_KEY.
 *
 * The sealing passphrase comes from CC_VAULT_PASSPHRASE when set. Without it,
 * a host+user fingerprint is used, which means the sealed value can only be
 * decrypted by the same user on the same machine — convenient, but it is
 * obfuscation at rest, not a secret manager. Use CC_VAULT_PASSPHRASE (or a real
 * secret manager injecting OPENAI_API_KEY) for anything that matters.
 */

const ALGO = 'aes-256-gcm';
const PBKDF2_ITERATIONS = 200_000;

function sealingSecret(): string {
  if (process.env.CC_VAULT_PASSPHRASE) return process.env.CC_VAULT_PASSPHRASE;
  return `${hostname()}::${userInfo().username}::cobra-commander-vault-v1`;
}

function deriveKey(salt: Buffer): Buffer {
  return pbkdf2Sync(sealingSecret(), salt, PBKDF2_ITERATIONS, 32, 'sha512');
}

export function encryptValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptValue(packed: string, key: Buffer): string {
  const buf = Buffer.from(packed, 'base64');
  const decipher = createDecipheriv(ALGO, key, buf.subarray(0, 16));
  decipher.setAuthTag(buf.subarray(16, 32));
  return Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]).toString('utf-8');
}

function writeEnvVars(envPath: string, vars: Record<string, string>): void {
  let lines: string[];
  if (existsSync(envPath)) {
    lines = readFileSync(envPath, 'utf-8').split('\n');
  } else {
    lines = [
      '# Cobra Commander configuration — keep this file out of version control.',
      '',
    ];
  }

  for (const [k, v] of Object.entries(vars)) {
    const idx = lines.findIndex(l => l.trim().startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }

  if (!lines[lines.length - 1]?.match(/^\s*$/)) lines.push('');
  writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
}

/** Seal an API key into .env as CC_VAULT_SALT + CC_WORKER_KEY. */
export function sealApiKey(apiKey: string, envPath = envFilePath()): void {
  const salt = randomBytes(32);
  writeEnvVars(envPath, {
    CC_VAULT_SALT: salt.toString('hex'),
    CC_WORKER_KEY: encryptValue(apiKey, deriveKey(salt)),
  });
}

/** Decrypt the sealed API key from .env, or null if absent/undecryptable. */
export function unsealApiKey(envPath = envFilePath()): string | null {
  const env = readEnvFile(envPath);
  const saltHex = env.get('CC_VAULT_SALT');
  const sealed = env.get('CC_WORKER_KEY');
  if (!saltHex || !sealed) return null;
  try {
    return decryptValue(sealed, deriveKey(Buffer.from(saltHex, 'hex')));
  } catch {
    return null;
  }
}

/**
 * Resolve the model API key. Resolution order:
 *   1. OPENAI_API_KEY / WORKER_API_KEY in the real environment
 *   2. the same keys in .env
 *   3. the sealed CC_WORKER_KEY in .env
 */
export async function resolveWorkerKey(envPath = envFilePath()): Promise<string | null> {
  const fromEnv = process.env.OPENAI_API_KEY || process.env.WORKER_API_KEY;
  if (fromEnv) return fromEnv;

  const env = readEnvFile(envPath);
  const fromFile = env.get('OPENAI_API_KEY') || env.get('WORKER_API_KEY');
  if (fromFile) return fromFile;

  return unsealApiKey(envPath);
}

/** Seal a key from stdin/argv: `npx tsx src/core/key-vault.ts <api-key>` */
const isMain = process.argv[1]?.endsWith('key-vault.ts') || process.argv[1]?.endsWith('key-vault.js');
if (isMain) {
  const apiKey = process.argv[2];
  if (!apiKey) {
    console.error('Usage: npx tsx src/core/key-vault.ts <api-key>');
    console.error('Seals the key into .env as CC_WORKER_KEY (AES-256-GCM).');
    console.error('Set CC_VAULT_PASSPHRASE first to seal with a passphrase instead of a host fingerprint.');
    process.exit(1);
  }
  const target = envFilePath();
  sealApiKey(apiKey, target);
  const check = unsealApiKey(target);
  if (check === apiKey) {
    console.log(`Key sealed into ${target} (${apiKey.slice(0, 5)}…${apiKey.slice(-4)}).`);
    if (!process.env.CC_VAULT_PASSPHRASE) {
      console.log('Sealed with a host+user fingerprint — it will not decrypt on another machine.');
    }
    const plaintext = parseEnvFile(readFileSync(target, 'utf-8')).get('OPENAI_API_KEY');
    if (plaintext) console.log('Note: OPENAI_API_KEY is still set in plain text and takes precedence — remove it to use the sealed key.');
  } else {
    console.error('Seal verification failed — key not usable.');
    process.exit(1);
  }
}
