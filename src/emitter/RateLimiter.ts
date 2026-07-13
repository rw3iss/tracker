/**
 * Token bucket configuration for a single event type.
 *
 * @see {@link RateLimitConfig}
 * @see {@link RateLimiter}
 */
export interface BucketConfig {
  /** Maximum burst -- how many events can be sent immediately before throttling. */
  capacity:     number;
  /** Token refill rate per second after the burst is spent. */
  refillPerSec: number;
}

/**
 * Event types that can be individually rate-limited.
 *
 * @see {@link RateLimitConfig}
 */
export type RateLimitEventType = 'error' | 'warning' | 'info' | 'debug' | 'event';

/**
 * Rate limiting configuration for the tracker client.
 *
 * Configure per-type token buckets to prevent event storms from overwhelming
 * the tracking backend. Each event type can have independent burst capacity
 * and refill rates.
 *
 * @example
 * ```typescript
 * TrackerClient.init({
 *   rateLimit: {
 *     error: { capacity: 10, refillPerSec: 1 },    // 10 burst, 1/sec steady
 *     debug: { capacity: 50, refillPerSec: 5 },     // 50 burst, 5/sec steady
 *     summaryIntervalMs: 30_000,                     // emit summary every 30s
 *   },
 *   ...
 * });
 * ```
 *
 * @see {@link BucketConfig}
 * @see {@link TrackerConfig.rateLimit}
 */
export type RateLimitConfig = Partial<Record<RateLimitEventType, BucketConfig>> & {
  /**
   * How often (in ms) to emit a dropped-events summary event.
   * Set to `0` to disable summary emission.
   * @defaultValue `30_000`
   */
  summaryIntervalMs?: number;
};

/**
 * Callback invoked when the rate limiter has dropped events and a summary is ready.
 *
 * The consumer should enqueue this as a tracker event of type `'event'` with
 * category `'tracker:rate-limit'`.
 *
 * @param dropped - Map of event type to number of events dropped since the last summary.
 *
 * @see {@link RateLimiter}
 */
export type SummaryCallback = (dropped: Partial<Record<RateLimitEventType, number>>) => void;

interface BucketState {
  tokens:     number;
  lastRefill: number;
}

/**
 * Token-bucket rate limiter for tracker events.
 *
 * Each configured event type gets an independent token bucket with a burst
 * capacity and a steady-state refill rate. When a bucket is empty, events
 * of that type are dropped and counted. Dropped event counts are periodically
 * reported via the {@link SummaryCallback}.
 *
 * @remarks
 * Event types without a configured {@link BucketConfig} are always allowed through.
 *
 * @see {@link RateLimitConfig}
 * @see {@link TrackerConfig.rateLimit}
 */
export class RateLimiter {
  private readonly config:     RateLimitConfig;
  private readonly onSummary:  SummaryCallback;
  private readonly buckets:    Map<RateLimitEventType, BucketState> = new Map();
  private readonly dropped:    Partial<Record<RateLimitEventType, number>> = {};
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * @param config - Per-type bucket configuration and summary interval.
   * @param onSummary - Callback invoked with dropped event counts at each summary interval.
   */
  constructor(config: RateLimitConfig, onSummary: SummaryCallback) {
    this.config    = config;
    this.onSummary = onSummary;
  }

  /**
   * Start the periodic summary emission interval.
   *
   * No-op if `summaryIntervalMs` is `0` or if already started.
   */
  start(): void {
    const ms = this.config.summaryIntervalMs ?? 30_000;
    if (ms === 0 || this.intervalId !== null) return;
    this.intervalId = setInterval(() => this.emitSummary(), ms);
  }

  /**
   * Stop the summary interval and emit a final summary if any events were dropped.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.emitSummary();
  }

  /**
   * Check whether an event of the given type should be allowed through.
   *
   * Consumes one token from the type's bucket. If no tokens are available,
   * the event is dropped and the dropped counter is incremented.
   *
   * @param type - The event type to check.
   * @returns `true` if the event should be allowed, `false` if it should be dropped.
   */
  allow(type: RateLimitEventType): boolean {
    const bucketCfg = this.config[type];
    if (!bucketCfg) return true;

    const now   = Date.now();
    let   state = this.buckets.get(type);

    if (!state) {
      state = { tokens: bucketCfg.capacity, lastRefill: now };
      this.buckets.set(type, state);
    }

    // Refill tokens based on elapsed time
    const elapsedSecs = (now - state.lastRefill) / 1_000;
    state.tokens      = Math.min(
      bucketCfg.capacity,
      state.tokens + elapsedSecs * bucketCfg.refillPerSec,
    );
    state.lastRefill  = now;

    if (state.tokens >= 1) {
      state.tokens -= 1;
      return true;
    }

    this.dropped[type] = (this.dropped[type] ?? 0) + 1;
    return false;
  }

  private emitSummary(): void {
    const hasDropped = Object.values(this.dropped).some((n) => (n ?? 0) > 0);
    if (!hasDropped) return;

    this.onSummary({ ...this.dropped });

    // Reset counts
    for (const key of Object.keys(this.dropped) as RateLimitEventType[]) {
      delete this.dropped[key];
    }
  }
}
