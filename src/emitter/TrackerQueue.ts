import type { TrackerEvent } from '../common/types';

/**
 * Configuration options for {@link TrackerQueue}.
 *
 * @see {@link TrackerConfig.queue}
 */
export interface TrackerQueueOptions {
  /**
   * Maximum number of events the in-memory queue can hold.
   * When exceeded, the oldest event is dropped (FIFO eviction).
   */
  maxSize:    number;

  /**
   * localStorage key used to persist unflushed events as a fallback
   * when all HTTP retry attempts are exhausted.
   */
  storageKey: string;
}

const isBrowser = typeof localStorage !== 'undefined';

/**
 * In-memory event queue with localStorage fallback for the client-side
 * HTTP transport pipeline.
 *
 * Events are added via {@link enqueue}, taken as a batch via {@link snapshot},
 * and removed after successful delivery via {@link confirm}. If delivery
 * fails after all retries, {@link persistFallback} saves events to
 * localStorage so they can be recovered on the next page load via
 * {@link drainStorage}.
 *
 * @remarks
 * This queue is used internally by {@link TrackerFlusher} and is not
 * needed when using a custom {@link ITrackerTransport}.
 *
 * @see {@link TrackerFlusher}
 * @see {@link TrackerQueueOptions}
 */
export class TrackerQueue {
  private readonly queue: TrackerEvent[] = [];
  private readonly maxSize: number;
  private readonly storageKey: string;

  /**
   * @param options - Queue size and storage key configuration.
   */
  constructor(options: TrackerQueueOptions) {
    this.maxSize    = options.maxSize;
    this.storageKey = options.storageKey;
  }

  /**
   * Add an event to the queue. If the queue is at capacity, the oldest
   * event is dropped to make room.
   *
   * @param event - The event to enqueue.
   */
  enqueue(event: TrackerEvent): void {
    if (this.queue.length >= this.maxSize) {
      this.queue.shift(); // drop oldest
    }
    this.queue.push(event);
  }

  /**
   * Get the current number of events in the queue.
   *
   * @returns The queue length.
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Get a shallow copy of the current queue contents without modifying the queue.
   *
   * Used by {@link TrackerFlusher} to take a batch for delivery. After successful
   * delivery, call {@link confirm} with the same batch to remove the events.
   *
   * @returns A shallow copy of the queued events.
   */
  snapshot(): TrackerEvent[] {
    return [...this.queue];
  }

  /**
   * Remove a previously snapshotted batch from the in-memory queue.
   *
   * Call this after a successful flush to acknowledge that the events
   * have been delivered and can be discarded.
   *
   * @param batch - The batch of events to remove (same references as returned by {@link snapshot}).
   */
  confirm(batch: TrackerEvent[]): void {
    const batchSet = new Set(batch);
    const remaining = this.queue.filter((e) => !batchSet.has(e));
    this.queue.length = 0;
    this.queue.push(...remaining);
  }

  /**
   * Persist a batch to localStorage as a fallback after all retries are exhausted.
   *
   * Merges with any existing stored events by deduplicating via JSON value equality.
   * The new batch is appended after existing events, preserving arrival order.
   *
   * @remarks
   * No-op if localStorage is unavailable (e.g. in Node.js) or full.
   *
   * @param batch - The events to persist.
   */
  persistFallback(batch: TrackerEvent[]): void {
    if (!isBrowser || batch.length === 0) return;
    try {
      const existing: TrackerEvent[] = JSON.parse(localStorage.getItem(this.storageKey) ?? '[]');
      // Keep only stored events that are NOT already in the new batch (by identity
      // is impossible after JSON round-trip, so dedup by value equality via JSON).
      const batchKeys = new Set(batch.map((e) => JSON.stringify(e)));
      const filtered  = existing.filter((e) => !batchKeys.has(JSON.stringify(e)));
      localStorage.setItem(this.storageKey, JSON.stringify([...filtered, ...batch]));
    } catch {
      // localStorage full or unavailable — silently drop
    }
  }

  /**
   * Load any events persisted to localStorage and prepend them to the queue.
   *
   * Clears the storage key after loading. Called during client initialization
   * to recover events from a previous session that failed to flush.
   *
   * @remarks
   * Corrupted storage data is silently discarded. Respects {@link TrackerQueueOptions.maxSize}.
   */
  drainStorage(): void {
    if (!isBrowser) return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const stored: TrackerEvent[] = JSON.parse(raw);
      localStorage.removeItem(this.storageKey);
      // Re-enqueue stored events in order, respecting maxSize
      for (const e of stored) this.enqueue(e);
    } catch {
      // Corrupted storage — clear and continue
      try { localStorage.removeItem(this.storageKey); } catch { /* ignore */ }
    }
  }
}
