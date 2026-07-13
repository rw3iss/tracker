import type { TrackerQueue } from './TrackerQueue';
import type { IDBEventQueue } from './IDBEventQueue';

/**
 * Retry configuration for failed HTTP flush attempts.
 *
 * Uses exponential backoff: delay = `baseDelay * backoffFactor^(attempt-1)`.
 *
 * @see {@link TrackerConfig.retry}
 */
export interface RetryOptions {
  /** Maximum number of delivery attempts before giving up. */
  maxAttempts:   number;
  /** Base delay in milliseconds before the first retry. */
  baseDelay:     number;
  /** Multiplier applied to the delay on each successive retry. */
  backoffFactor: number;
}

/**
 * Configuration options for {@link TrackerFlusher}.
 *
 * @see {@link TrackerFlusher}
 */
export interface TrackerFlusherOptions {
  /** The in-memory event queue to flush from. */
  queue:         TrackerQueue;
  /** HTTP endpoint to POST events to. */
  endpoint:      string;
  /** Retry configuration for failed delivery attempts. */
  retry:         RetryOptions;
  /** Interval in milliseconds between automatic flushes. */
  flushInterval: number;
  /** API key sent as `X-Tracker-Key` header on every request. */
  apiKey?:       string;
  /**
   * When provided, `flush()` reads from IndexedDB instead of the memory queue.
   * The `sendBeacon` beforeunload handler is skipped (Background Sync handles
   * post-close delivery).
   */
  idbQueue?:     IDBEventQueue;
  /**
   * Injectable delay function for testing.
   * @defaultValue `setTimeout`-based Promise.
   * @internal
   */
  _delay?: (ms: number) => Promise<void>;
}

const isBrowser = typeof window !== 'undefined';

/**
 * Periodically flushes queued {@link TrackerEvent}s to the server via HTTP POST.
 *
 * The flusher runs on a configurable interval and supports:
 * - **Automatic retries** with exponential backoff ({@link RetryOptions})
 * - **localStorage fallback** when all retries are exhausted (memory queue mode)
 * - **IndexedDB mode** for Service Worker Background Sync delivery
 * - **sendBeacon** on `beforeunload` for best-effort delivery when the page closes
 *
 * @remarks
 * In memory queue mode, failed events are persisted to localStorage via
 * {@link TrackerQueue.persistFallback} and recovered on the next page load.
 * In IDB mode, failed events remain in IndexedDB for the Service Worker to retry.
 *
 * @see {@link TrackerQueue}
 * @see {@link TrackerFlusherOptions}
 */
export class TrackerFlusher {
  private readonly queue: TrackerQueue;
  private readonly endpoint: string;
  private readonly retry: RetryOptions;
  private readonly flushInterval: number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly apiKey?: string;
  private readonly idbQueue?: IDBEventQueue;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private beaconHandler: (() => void) | null = null;
  private isFlushing = false;

  /**
   * @param options - Flusher configuration including queue, endpoint, and retry settings.
   */
  constructor(options: TrackerFlusherOptions) {
    this.queue         = options.queue;
    this.endpoint      = options.endpoint;
    this.retry         = options.retry;
    this.flushInterval = options.flushInterval;
    this.apiKey        = options.apiKey;
    this.idbQueue      = options.idbQueue;
    this.delay         = options._delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Start the periodic flush interval and register the `beforeunload` beacon handler.
   *
   * @remarks
   * The `sendBeacon` handler is only registered in memory-queue mode (no IDB).
   * In IDB mode, the Service Worker Background Sync handles post-close delivery.
   * Calling `start()` when already started is a no-op.
   */
  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => { void this.flush(); }, this.flushInterval);

    // sendBeacon is only registered in memory-queue mode.
    // In IDB mode the Service Worker Background Sync handles post-close delivery.
    // Cast through unknown — in dual-environment builds (browser + Node) the
    // global `navigator` ambient type can resolve to WorkerNavigator (Node's
    // worker_threads shim) which lacks sendBeacon. We runtime-check before use.
    const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as unknown as Navigator | undefined;
    if (!this.idbQueue && isBrowser && nav && nav.sendBeacon) {
      this.beaconHandler = () => {
        const batch = this.queue.snapshot();
        if (batch.length === 0) return;
        const blob = new Blob([JSON.stringify(batch)], { type: 'application/json' });
        nav.sendBeacon(this.endpoint, blob);
        this.queue.confirm(batch);
      };
      window.addEventListener('beforeunload', this.beaconHandler);
    }
  }

  /**
   * Stop the periodic flush interval and remove the `beforeunload` handler.
   *
   * Does not flush remaining events -- call {@link flush} first if needed.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.beaconHandler && isBrowser) {
      window.removeEventListener('beforeunload', this.beaconHandler);
      this.beaconHandler = null;
    }
  }

  /**
   * Flush all queued events immediately.
   *
   * Reads from either the in-memory queue or IndexedDB depending on configuration.
   * Uses exponential backoff retry on failure. Re-entrant calls while a flush is
   * in progress are silently skipped.
   *
   * @returns A promise that resolves when the flush attempt completes (success or final failure).
   */
  async flush(): Promise<void> {
    if (this.idbQueue) {
      return this.flushFromIDB();
    }
    return this.flushFromMemory();
  }

  private async flushFromMemory(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;
    try {
      const batch = this.queue.snapshot();
      if (batch.length === 0) return;

      let lastError: unknown;
      for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
        if (attempt > 0) {
          await this.delay(this.retry.baseDelay * Math.pow(this.retry.backoffFactor, attempt - 1));
        }
        try {
          const res = await fetch(this.endpoint, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(batch),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this.queue.confirm(batch);
          return;
        } catch (err) {
          lastError = err;
        }
      }

      // All retries exhausted — persist to localStorage and remove from memory
      this.queue.persistFallback(batch);
      this.queue.confirm(batch);
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[tracker] flush failed after retries, persisted to storage:', lastError);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  private async flushFromIDB(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;
    try {
      const items = await this.idbQueue!.getAll();
      if (items.length === 0) return;

      const events = items.map((i) => i.event);
      let lastError: unknown;
      for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
        if (attempt > 0) {
          await this.delay(this.retry.baseDelay * Math.pow(this.retry.backoffFactor, attempt - 1));
        }
        try {
          const res = await fetch(this.endpoint, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(events),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await this.idbQueue!.removeByIds(items.map((i) => i.id));
          return;
        } catch (err) {
          lastError = err;
        }
      }
      // All retries exhausted — leave events in IDB for SW Background Sync retry
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[tracker] IDB flush failed after retries (SW Background Sync will retry):', lastError);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['X-Tracker-Key'] = this.apiKey;
    return h;
  }
}
