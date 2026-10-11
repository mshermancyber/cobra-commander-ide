import type { AuthProvider } from './index.js';
import { PamAuthProvider } from './pam.js';
import { CliAuthProvider } from './cli.js';
import { TokenAuthProvider } from './token.js';
import type { CliAuthConfig } from './cli.js';

// ---------------------------------------------------------------------------
// Auth Provider Factory
//
// `token` (default) checks a single operator credential from .env and works on
// any platform. `pam` delegates to the host's Linux PAM stack, which ties web
// logins to real system accounts. `cli` prompts on the terminal.
// ---------------------------------------------------------------------------

let cachedProvider: AuthProvider | null = null;

/**
 * Create (or retrieve cached) auth provider.
 * Set config.provider (or AUTH_PROVIDER) to "token", "pam" or "cli".
 * The provider is a singleton — created once and reused.
 */
export function createAuthProvider(config?: Record<string, string>): AuthProvider {
  if (cachedProvider) {
    return cachedProvider;
  }

  const providerType = config?.provider || process.env.AUTH_PROVIDER || 'token';

  if (providerType === 'cli') {
    const cliConfig: CliAuthConfig = {
      interactive: config?.interactive === 'true' || process.env.CLI_AUTH_INTERACTIVE === 'true',
      verbose: config?.verbose !== 'false' && process.env.CLI_AUTH_VERBOSE !== 'false',
    };
    cachedProvider = new CliAuthProvider(cliConfig);
  } else if (providerType === 'pam') {
    cachedProvider = new PamAuthProvider(config?.pamService);
  } else {
    cachedProvider = new TokenAuthProvider();
  }

  return cachedProvider;
}

/**
 * Reset the cached provider (useful for testing or config reload).
 */
export function resetAuthProvider(): void {
  const prev = cachedProvider;
  cachedProvider = null;
  // Clean up CLI provider's readline adapter if active
  if (prev instanceof CliAuthProvider) {
    (prev as CliAuthProvider).close();
  }
}

/**
 * Get the current cached provider without creating a new one.
 */
export function getAuthProvider(): AuthProvider | null {
  return cachedProvider;
}
