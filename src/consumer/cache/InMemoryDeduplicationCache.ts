import type { ITrackerDeduplicationCache } from './ITrackerDeduplicationCache';

/** Map<key, expiryTimestampMs> */
export class InMemoryDeduplicationCache implements ITrackerDeduplicationCache {
  private readonly store = new Map<string, number>();

  async has(key: string): Promise<boolean> {
    const expiry = this.store.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async set(key: string, ttlMs: number): Promise<void> {
    this.store.set(key, Date.now() + ttlMs);
  }

  /** Optional manual sweep — call periodically to prevent unbounded growth. */
  sweep(): void {
    const now = Date.now();
    for (const [k, expiry] of this.store) {
      if (now > expiry) this.store.delete(k);
    }
  }
}
