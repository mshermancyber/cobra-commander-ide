// ---------------------------------------------------------------------------
// Auth Provider Interface
// Pluggable authentication backends for the remote control server.
// ---------------------------------------------------------------------------

export interface AuthResult {
  success: boolean;
  user?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AuthProvider {
  /** Unique name for this provider (e.g., "pam", "database", "oidc", "cli") */
  readonly name: string;

  /**
   * Authenticate a user with username + password credentials.
   * Returns AuthResult with user identity on success.
   */
  authenticate(username: string, password: string): Promise<AuthResult>;

  /**
   * Optional: validate an existing session token.
   * If not implemented, session validation falls back to the built-in
   * HMAC-signed session store.
   */
  validateSession?(token: string): Promise<boolean>;

  /**
   * Optional: list all users known to this provider.
   * Only meaningful for providers that maintain a user directory (database, PAM).
   */
  listUsers?(): Promise<string[]>;

  /**
   * Optional: create a new user in this provider's store.
   */
  createUser?(username: string, password: string): Promise<void>;

  /**
   * Optional: delete a user from this provider's store.
   */
  deleteUser?(username: string): Promise<void>;

  /**
   * Optional: change a user's password.
   */
  changePassword?(username: string, newPassword: string): Promise<void>;
}

// Re-export providers for convenience
export { TokenAuthProvider, hashPassword, verifyPassword } from './token.js';
export { CliAuthProvider } from './cli.js';
export type { CliAuthConfig, CredentialValidator } from './cli.js';
export { createReadlineAdapter } from './readline-adapter.js';
export type { ReadlineAdapter } from './readline-adapter.js';
