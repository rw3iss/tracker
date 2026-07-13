import type { ITrackerDeduplicationCache } from './ITrackerDeduplicationCache';

/** Minimal interface — compatible with ioredis Redis client */
interface RedisLike {
  set(key: string, value: string, mode: 'PX', ttl: number, flag: 'NX'): Promise<string | null>;
  exists(key: string): Promise<number>;
}

/**
 * Redis-backed deduplication cache.
 * Bring your own ioredis client — no Redis dependency in this package.
 *
 * @example
 * import Redis from 'ioredis';
 * const cache = new RedisDeduplicationCache(new Redis());
 */
export class RedisDeduplicationCache implements ITrackerDeduplicationCache {
  constructor(private readonly redis: RedisLike) {}

  async has(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) > 0;
  }

  async set(key: string, ttlMs: number): Promise<void> {
    // SET key 1 PX ttl NX — atomic, only sets if not already present
    await this.redis.set(key, '1', 'PX', ttlMs, 'NX');
  }
}
