import type { BatchingStrategy } from './types';

interface BatchQueueConfig<T> {
  /** Strategy to use. Default: `'size-or-time'`. */
  strategy?:       BatchingStrategy;
  /** Trigger flush when queue reaches this many items. Default: 10. */
  batchSize?:      number;
  /** Trigger flush when this many ms have passed since the first queued item. Default: 5_000. */
  batchTimeoutMs?: number;
  /** Hard cap on queue size — older items are dropped to make room. Default: 1000. */
  maxSize?:        number;
  /** Called with each batch. Async; failures are caught and logged via `onError`. */
  onFlush:         (batch: T[]) => Promise<void> | void;
  /** Optional error sink. Default: `console.warn`. */
  onError?:        (err: unknown) => void;
}

/**
 * Generic batching queue used by the GA plugin's forward mode.
 *
 * Three strategies:
 * - `'immediate'`: every push triggers a flush of one item. Useful when you
 *   need linear ordering at all costs and don't care about call volume.
 * - `'time'`: a timer flushes whatever's queued every `batchTimeoutMs`. The
 *   queue can grow up to `maxSize` between flushes; oldest items are
 *   dropped beyond that.
 * - `'size-or-time'`: flush when either the queue reaches `batchSize` OR
 *   `batchTimeoutMs` has passed since the *first* item was queued. This is
 *   the GA-friendly default — favors latency at high traffic and call
 *   coalescing at low traffic.
 *
 * Flushes preserve order. Concurrent flushes are serialized — a flush in
 * progress does not block new pushes, but a second flush won't start until
 * the first resolves.
 *
 * `flush()` is a no-op when the queue is empty. `flushNow()` is the
 * synchronous-ish escape hatch used by `pagehide` handlers and by `destroy`.
 */
export class BatchQueue<T> {
  private readonly strategy:       BatchingStrategy;
  private readonly batchSize:      number;
  private readonly batchTimeoutMs: number;
  private readonly maxSize:        number;
  private readonly onFlush:        (batch: T[]) => Promise<void> | void;
  private readonly onError:        (err: unknown) => void;

  private queue: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  /** Wall-clock timestamp of the first item in the current batch. */
  private firstQueuedAt = 0;

  constructor(config: BatchQueueConfig<T>) {
    this.strategy       = config.strategy       ?? 'size-or-time';
    this.batchSize      = config.batchSize      ?? 10;
    this.batchTimeoutMs = config.batchTimeoutMs ?? 5_000;
    this.maxSize        = config.maxSize        ?? 1_000;
    this.onFlush        = config.onFlush;
    this.onError        = config.onError ?? ((e) => { try { console.warn('[BatchQueue]', e); } catch { /* swallow */ } });
  }

  /** Add an item to the queue. Triggers strategy-appropriate flushing. */
  push(item: T): void {
    if (this.queue.length >= this.maxSize) this.queue.shift();
    if (this.queue.length === 0) this.firstQueuedAt = Date.now();
    this.queue.push(item);

    switch (this.strategy) {
      case 'immediate':
        // Synchronous flush — each push fires `onFlush` with exactly the
        // item that was just queued. If `onFlush` returns a Promise, it's
        // fire-and-forget (concurrent flushes are allowed in immediate mode).
        this.flushImmediate();
        return;
      case 'size-or-time':
        if (this.queue.length >= this.batchSize) {
          void this.flush();
          return;
        }
        this.scheduleTimerFromFirstQueued();
        return;
      case 'time':
        this.scheduleTimerFromFirstQueued();
        return;
    }
  }

  /**
   * Drain everything queued through `onFlush`. Resolves once the flush
   * completes (or immediately if nothing's queued).
   *
   * Concurrent flush calls are serialized against the existing flushing
   * chain — the empty-check happens *inside* the chained wrapper so that a
   * second flush waiting behind a first doesn't fire `onFlush([])` after
   * the first drained the queue.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }

    // Serialize against any in-flight flush so order is preserved.
    const prev = this.flushing;
    this.flushing = (async () => {
      await prev.catch(() => undefined);
      // Re-check after the prior flush finished — it may have already drained
      // what we were going to take.
      if (this.queue.length === 0) return;
      const batch = this.queue;
      this.queue = [];
      this.firstQueuedAt = 0;
      try { await this.onFlush(batch); }
      catch (err) { this.onError(err); }
    })();
    return this.flushing;
  }

  /**
   * Synchronous flush attempt — fires `onFlush` immediately with whatever's
   * queued without awaiting. Intended for `pagehide` where awaiting is
   * impossible. Returns the batch so the caller can fire-and-forget if
   * needed (e.g. via `sendBeacon`).
   */
  flushNow(): T[] {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const batch = this.queue;
    this.queue = [];
    this.firstQueuedAt = 0;
    if (batch.length > 0) {
      try {
        const r = this.onFlush(batch);
        if (r instanceof Promise) r.catch(this.onError);
      }
      catch (err) { this.onError(err); }
    }
    return batch;
  }

  /** Number of items currently queued. */
  get length(): number {
    return this.queue.length;
  }

  /** Clear timers without flushing — used in `destroy()`. */
  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Synchronous flush — used by `'immediate'` strategy. Drains queue + fires `onFlush` exactly once. */
  private flushImmediate(): void {
    const batch = this.queue;
    this.queue = [];
    this.firstQueuedAt = 0;
    try {
      const r = this.onFlush(batch);
      if (r instanceof Promise) r.catch(this.onError);
    } catch (err) {
      this.onError(err);
    }
  }

  private scheduleTimerFromFirstQueued(): void {
    if (this.timer !== null) return;
    const elapsed = Date.now() - this.firstQueuedAt;
    const remaining = Math.max(0, this.batchTimeoutMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, remaining);
  }
}
