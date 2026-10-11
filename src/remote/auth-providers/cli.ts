import type { AuthProvider, AuthResult } from './index.js';
import { createReadlineAdapter, type ReadlineAdapter } from './readline-adapter.js';

// ---------------------------------------------------------------------------
// CLI Auth Provider
// Interactive authentication via stdin/stdout using Node.js readline.
//
// Validates credentials against a configurable validation function
// (defaults to checking environment variables CLI_AUTH_USER / CLI_AUTH_PASS).
// Keeps the user informed with status messages on stderr.
// ---------------------------------------------------------------------------

export type CredentialValidator = (username: string, password: string) => Promise<boolean>;

export interface CliAuthConfig {
  /** Custom credential validator. If not provided, falls back to env vars. */
  validator?: CredentialValidator;
  /** Whether to prompt for credentials interactively (default: false). */
  interactive?: boolean;
  /** Whether to output status messages (default: true). */
  verbose?: boolean;
}

/**
 * Default credential validator: checks CLI_AUTH_USER / CLI_AUTH_PASS env vars.
 */
const defaultValidator: CredentialValidator = async (username: string, password: string): Promise<boolean> => {
  const expectedUser = process.env.CLI_AUTH_USER;
  const expectedPass = process.env.CLI_AUTH_PASS;

  if (!expectedUser && !expectedPass) {
    // No env vars set — allow anyone (development mode)
    return true;
  }

  if (expectedUser && expectedPass) {
    return username === expectedUser && password === expectedPass;
  }

  // Only one set — treat as misconfiguration, deny
  return false;
};

export class CliAuthProvider implements AuthProvider {
  readonly name = 'cli';
  private readonly validator: CredentialValidator;
  private readonly interactive: boolean;
  private readonly verbose: boolean;
  private adapter: ReadlineAdapter | null = null;

  constructor(config: CliAuthConfig = {}) {
    this.validator = config.validator ?? defaultValidator;
    this.interactive = config.interactive ?? false;
    this.verbose = config.verbose ?? true;
  }

  private getAdapter(): ReadlineAdapter {
    if (!this.adapter) {
      this.adapter = createReadlineAdapter();
    }
    return this.adapter;
  }

  async authenticate(username: string, password: string): Promise<AuthResult> {
    const adapter = this.getAdapter();

    // ── Status: authentication attempt started ──
    if (this.verbose) {
      adapter.status(`Authenticating user "${username}" via CLI provider...`);
    }

    let effectiveUsername = username;
    let effectivePassword = password;

    // ── Interactive mode: prompt the user for credentials ──
    if (this.interactive) {
      if (this.verbose) {
        adapter.status('Interactive mode — prompting for credentials.');
      }

      if (!username.trim()) {
        effectiveUsername = await adapter.question('Username: ');
        if (!effectiveUsername) {
          if (this.verbose) {
            adapter.status('No username provided. Authentication aborted.');
          }
          return { success: false, error: 'Username required' };
        }
      }

      if (!password.trim()) {
        effectivePassword = await adapter.questionSecret('Password: ');
        if (!effectivePassword) {
          if (this.verbose) {
            adapter.status('No password provided. Authentication aborted.');
          }
          return { success: false, error: 'Password required' };
        }
      }
    }

    // ── Basic validation ──
    if (!effectiveUsername || effectiveUsername.length > 64) {
      if (this.verbose) {
        adapter.status('Invalid username format.');
      }
      return { success: false, error: 'Invalid username format' };
    }

    if (!effectivePassword) {
      if (this.verbose) {
        adapter.status('Empty password.');
      }
      return { success: false, error: 'Empty password' };
    }

    // ── Run the validator ──
    if (this.verbose) {
      adapter.status('Validating credentials...');
    }

    try {
      const valid = await this.validator(effectiveUsername, effectivePassword);

      if (valid) {
        if (this.verbose) {
          adapter.status(`Authentication successful for "${effectiveUsername}".`);
        }
        return {
          success: true,
          user: effectiveUsername,
          metadata: { provider: 'cli' },
        };
      }

      if (this.verbose) {
        adapter.status(`Authentication failed for "${effectiveUsername}".`);
      }
      return { success: false, error: 'Authentication failed' };
    } catch (err) {
      if (this.verbose) {
        adapter.status(`Validation error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Authentication error',
      };
    }
  }

  /**
   * Clean up the readline adapter if it was created.
   * Call this when the provider is no longer needed to prevent hanging.
   */
  close(): void {
    if (this.adapter) {
      this.adapter.close();
      this.adapter = null;
    }
  }
}
