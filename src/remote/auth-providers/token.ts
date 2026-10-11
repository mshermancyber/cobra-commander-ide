import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AuthProvider, AuthResult } from './index.js';
import { envValue } from '../../core/env-file.js';

// ---------------------------------------------------------------------------
// Token Auth Provider — the portable default
//
// Authenticates against a single operator credential held in .env. It needs no
// PAM, no system accounts and no platform-specific support, so it works the
// same on Linux, macOS and in a container.
//
// Configure one of:
//   REMOTE_AUTH_PASSWORD_HASH=<scrypt hash>   (preferred — generate below)
//   REMOTE_AUTH_PASSWORD=<plaintext>          (convenient, worse at rest)
//
// Generate a hash with:
//   npx tsx src/remote/auth-providers/token.ts <password>
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

/** Hash a password as `scrypt$<salt-hex>$<key-hex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Verify a password against a stored `scrypt$salt$key` hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still compare to keep the timing profile flat for wrong-length guesses.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export class TokenAuthProvider implements AuthProvider {
  readonly name = 'token';

  private readonly user: string;
  private readonly passwordHash?: string;
  private readonly password?: string;

  constructor(options?: { user?: string; passwordHash?: string; password?: string }) {
    this.user = options?.user || envValue('REMOTE_AUTH_USER') || 'operator';
    this.passwordHash = options?.passwordHash || envValue('REMOTE_AUTH_PASSWORD_HASH');
    this.password = options?.password || envValue('REMOTE_AUTH_PASSWORD');
  }

  /** True when a credential is configured; the server refuses to listen otherwise. */
  isConfigured(): boolean {
    return Boolean(this.passwordHash || this.password);
  }

  async authenticate(username: string, password: string): Promise<AuthResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'No remote credential configured. Set REMOTE_AUTH_PASSWORD_HASH in .env.',
      };
    }

    const userOk = constantTimeEquals(username, this.user);

    let passwordOk: boolean;
    if (this.passwordHash) {
      passwordOk = verifyPassword(password, this.passwordHash);
    } else {
      passwordOk = constantTimeEquals(password, this.password!);
    }

    if (userOk && passwordOk) return { success: true, user: this.user };
    return { success: false, error: 'Invalid credentials' };
  }

  async listUsers(): Promise<string[]> {
    return [this.user];
  }
}

const isMain = process.argv[1]?.endsWith('token.ts') || process.argv[1]?.endsWith('token.js');
if (isMain) {
  const password = process.argv[2];
  if (!password) {
    console.error('Usage: npx tsx src/remote/auth-providers/token.ts <password>');
    console.error('Prints a REMOTE_AUTH_PASSWORD_HASH line to paste into .env.');
    process.exit(1);
  }
  console.log(`REMOTE_AUTH_PASSWORD_HASH=${hashPassword(password)}`);
}
