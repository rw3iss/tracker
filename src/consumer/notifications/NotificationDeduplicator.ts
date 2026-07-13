import type { StoredTrackerEvent } from '../../common/types';

/**
 * In-memory TTL deduplicator for notification dispatch.
 *
 * Key format: `${canonicalEventId}:${channelType}`
 * - For normal events: canonicalEventId = event.id
 * - For notification-failed events: canonicalEventId = event.payload.originalEventId ?? event.id
 *
 * seen() both checks AND marks the key as seen in one call.
 *
 * seenCoarse() provides a second, broader deduplication layer keyed on event type+message.
 * Call seenCoarse() before seen() — if either returns true, skip dispatch.
 */

export interface CoarseDeduplicationConfig {
  windowMs: number;
  /** Default: `${type}:${message.slice(0, 100)}` */
  key?: (event: StoredTrackerEvent) => string;
}

export class NotificationDeduplicator {
  private readonly map      = new Map<string, number>();
  private readonly coarseMap = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly coarseConfig?: CoarseDeduplicationConfig,
  ) {}

  /**
   * Returns true if this key was seen within the window. Marks it as seen if not.
   */
  seen(key: string): boolean {
    const now = Date.now();
    this.evict(now);
    if (this.map.has(key)) return true;
    this.map.set(key, now + this.windowMs);
    return false;
  }

  /**
   * Returns true if an event matching the coarse key was seen within the coarse window.
   * Marks the coarse key as seen if not.
   * Always returns false when no coarseConfig was provided.
   */
  seenCoarse(event: StoredTrackerEvent): boolean {
    if (!this.coarseConfig) return false;
    const now     = Date.now();
    this.evictCoarse(now);
    const keyFn   = this.coarseConfig.key ?? defaultCoarseKey;
    const key     = keyFn(event);
    if (this.coarseMap.has(key)) return true;
    this.coarseMap.set(key, now + this.coarseConfig.windowMs);
    return false;
  }

  clear(): void {
    this.map.clear();
    this.coarseMap.clear();
  }

  private evict(now: number): void {
    for (const [k, expiry] of this.map) {
      if (expiry <= now) this.map.delete(k);
    }
  }

  private evictCoarse(now: number): void {
    for (const [k, expiry] of this.coarseMap) {
      if (expiry <= now) this.coarseMap.delete(k);
    }
  }
}

function defaultCoarseKey(event: StoredTrackerEvent): string {
  return `${event.type}:${event.message.slice(0, 100)}`;
}
