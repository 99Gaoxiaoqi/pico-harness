/** Default credential cooldown in milliseconds. */
const DEFAULT_COOLDOWN_MS = 60_000;

/** Round-robin credential pool with rate-limit cooldown tracking. */
export class CredentialPool {
  private readonly keys: string[];
  private index = 0;
  private readonly rateLimited = new Map<string, number>();

  constructor(
    keys: readonly string[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.keys = keys.filter((key) => key.length > 0);
  }

  getNextAvailable(): string | undefined {
    if (this.keys.length === 0) return undefined;
    this.sweepExpired();
    for (let index = 0; index < this.keys.length; index++) {
      const key = this.keys[(this.index + index) % this.keys.length]!;
      if (!this.rateLimited.has(key)) {
        this.index = (this.index + index + 1) % this.keys.length;
        return key;
      }
    }
    return undefined;
  }

  markRateLimited(key: string, cooldownMs: number = DEFAULT_COOLDOWN_MS): void {
    if (!this.keys.includes(key)) return;
    this.rateLimited.set(key, this.now() + cooldownMs);
  }

  markRateLimitedWithInfo(
    key: string,
    info: { readonly resetAt?: number; readonly retryAfterMs?: number },
  ): void {
    let cooldown = DEFAULT_COOLDOWN_MS;
    if (info.retryAfterMs !== undefined && info.retryAfterMs > 0) cooldown = info.retryAfterMs;
    else if (info.resetAt !== undefined) {
      const remaining = info.resetAt - this.now();
      if (remaining > 0) cooldown = remaining;
    }
    this.markRateLimited(key, cooldown);
  }

  getRateLimitStatus(key: string): { readonly rateLimited: boolean; readonly resetsAt?: number } {
    this.sweepExpired();
    const resetsAt = this.rateLimited.get(key);
    return resetsAt === undefined ? { rateLimited: false } : { rateLimited: true, resetsAt };
  }

  get size(): number {
    return this.keys.length;
  }

  get available(): number {
    this.sweepExpired();
    return this.keys.filter((key) => !this.rateLimited.has(key)).length;
  }

  private sweepExpired(): void {
    if (this.rateLimited.size === 0) return;
    const now = this.now();
    for (const [key, expiry] of this.rateLimited) {
      if (expiry <= now) this.rateLimited.delete(key);
    }
  }
}
