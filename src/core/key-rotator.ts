/**
 * Multi-key API rotation with cooldown for rate-limited keys.
 *
 * Takes an array of API keys and round-robins on each call to getNextKey().
 * If a key encounters a 429 response, it is placed on cooldown for 60 seconds.
 */

interface KeyState {
  key: string;
  cooldownUntil: number; // epoch ms
}

export class KeyRotator {
  private keys: KeyState[];
  private cursor: number;

  /**
   * Create a KeyRotator from a comma-separated string or array of keys.
   */
  constructor(keys: string | string[]) {
    const keyList = typeof keys === 'string' ? keys.split(',').map((k) => k.trim()).filter(Boolean) : keys;
    if (keyList.length === 0) {
      throw new Error('KeyRotator requires at least one API key');
    }
    this.keys = keyList.map((key) => ({ key, cooldownUntil: 0 }));
    this.cursor = 0;
  }

  /**
   * Get the next available API key using round-robin, skipping keys on cooldown.
   * If all keys are on cooldown, returns the key with the earliest cooldown expiry.
   */
  getNextKey(): string {
    const now = Date.now();

    // Try to find a non-cooldown key starting from cursor
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.cursor + i) % this.keys.length;
      if (this.keys[idx].cooldownUntil <= now) {
        this.cursor = (idx + 1) % this.keys.length;
        return this.keys[idx].key;
      }
    }

    // All keys are on cooldown — return the one expiring soonest
    let earliestIdx = 0;
    let earliestTs = this.keys[0].cooldownUntil;
    for (let i = 1; i < this.keys.length; i++) {
      if (this.keys[i].cooldownUntil < earliestTs) {
        earliestTs = this.keys[i].cooldownUntil;
        earliestIdx = i;
      }
    }
    this.cursor = (earliestIdx + 1) % this.keys.length;
    return this.keys[earliestIdx].key;
  }

  /**
   * Report that the given key received a 429 rate limit.
   * The key will be placed on cooldown for 60 seconds.
   */
  reportRateLimit(key: string): void {
    const entry = this.keys.find((k) => k.key === key);
    if (entry) {
      entry.cooldownUntil = Date.now() + 60_000;
    }
  }

  /**
   * Get the number of registered keys.
   */
  get count(): number {
    return this.keys.length;
  }
}
