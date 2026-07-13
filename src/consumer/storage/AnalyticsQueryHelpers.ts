import type { StoredTrackerEvent } from '../../common/types';
import type { ITrackerStorage } from './ITrackerStorage';

/**
 * Window options used by every helper. `since` is Unix ms; defaults to "last
 * 24h". `appId` is auto-applied if the helper was constructed with one.
 */
export interface AnalyticsWindowOpts {
  /** Lower bound on `receivedAt` (Unix ms). Default: 24h ago. */
  since?: number;
  /** Upper bound on `receivedAt` (Unix ms). Default: now. */
  until?: number;
  /** Maximum events to scan in-memory. Default: 50_000. */
  sampleLimit?: number;
}

/**
 * Higher-level analytics queries on top of `ITrackerStorage`. Designed to
 * answer the same questions GA4 dashboards do — DAU/MAU, top pages, traffic
 * sources, session duration, funnel drop-off, cohort retention, last-touch
 * attribution — without leaving the tracker stack.
 *
 * **Caveat:** all aggregations run in memory by default. They sample up to
 * `sampleLimit` events (default 50k) per call. For production analytics
 * workloads on a Postgres backend, use `SessionRollupPlugin` to maintain a
 * pre-aggregated `tracker_sessions` table and write SQL queries directly
 * against it. The helpers here are correct, but they're for dashboards
 * and ad-hoc queries — not for high-cardinality analytics at scale.
 *
 * @example
 * ```typescript
 * const helpers = new AnalyticsQueryHelpers(storage, 'buyer-portal');
 * await helpers.dau({ since: Date.now() - 7 * 86_400_000 });
 * await helpers.topPages({ limit: 25 });
 * await helpers.funnel(['view_item', 'add_to_cart', 'purchase']);
 * await helpers.cohortRetention({ cohortBucketDays: 1, retentionWindowDays: 30 });
 * ```
 */
export class AnalyticsQueryHelpers {
  static readonly DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
  static readonly DEFAULT_SAMPLE_LIMIT = 50_000;

  constructor(
    private readonly storage: ITrackerStorage,
    /** Auto-filter every query to this app. Omit for cross-app queries. */
    private readonly appId?: string,
  ) {}

  // ──────────────────────────────────────────────────────────────────────
  //  Audience
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Daily Active Users — distinct `client_id` count over the window.
   * Counts visitors, not sessions or users (use `dauByUser` for `userId`).
   */
  async dau(opts: AnalyticsWindowOpts = {}): Promise<number> {
    const events = await this.fetchAnalyticsEvents(opts);
    const ids = new Set<string>();
    for (const e of events) {
      const id = e.payload?.client_id;
      if (typeof id === 'string') ids.add(id);
    }
    return ids.size;
  }

  /** DAU by `userId` (excludes anonymous visitors). */
  async dauByUser(opts: AnalyticsWindowOpts = {}): Promise<number> {
    const events = await this.fetchAnalyticsEvents(opts);
    const ids = new Set<string>();
    for (const e of events) {
      const id = e.context?.userId;
      if (typeof id === 'string') ids.add(id);
    }
    return ids.size;
  }

  /** DAU / WAU / MAU rolled into one call. Each window slides back from `until`. */
  async dauWauMau(opts: AnalyticsWindowOpts = {}): Promise<{ dau: number; wau: number; mau: number }> {
    const until = opts.until ?? Date.now();
    const [dau, wau, mau] = await Promise.all([
      this.dau({ since: until - 1 * 86_400_000, until, sampleLimit: opts.sampleLimit }),
      this.dau({ since: until - 7 * 86_400_000, until, sampleLimit: opts.sampleLimit }),
      this.dau({ since: until - 30 * 86_400_000, until, sampleLimit: opts.sampleLimit }),
    ]);
    return { dau, wau, mau };
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Pages + sessions
  // ──────────────────────────────────────────────────────────────────────

  /** Top page paths by `page_view` event count. */
  async topPages(opts: AnalyticsWindowOpts & { limit?: number } = {}): Promise<Array<{ path: string; views: number }>> {
    const events = await this.fetchAnalyticsEvents({ ...opts });
    const counts = new Map<string, number>();
    for (const e of events) {
      if (e.message !== 'page_view') continue;
      const path = (e.payload?.page_path ?? e.payload?.page_location) as string | undefined;
      if (!path) continue;
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.limit ?? 50)
      .map(([path, views]) => ({ path, views }));
  }

  /** Average + p95 session durations from `session_end` events. */
  async sessionDuration(opts: AnalyticsWindowOpts = {}): Promise<{ count: number; avgMs: number; p50Ms: number; p95Ms: number }> {
    const events = await this.fetchAnalyticsEvents(opts);
    const durations: number[] = [];
    for (const e of events) {
      if (e.message !== 'session_end') continue;
      const ms = e.payload?.session_duration_ms;
      if (typeof ms === 'number' && ms > 0) durations.push(ms);
    }
    if (durations.length === 0) return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0 };
    durations.sort((a, b) => a - b);
    const sum = durations.reduce((a, b) => a + b, 0);
    return {
      count: durations.length,
      avgMs: Math.round(sum / durations.length),
      p50Ms: durations[Math.floor(durations.length * 0.5)],
      p95Ms: durations[Math.floor(durations.length * 0.95)],
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Acquisition
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Traffic sources (UTM source breakdown) — counts `session_start` events
   * by `utm_source`. Sessions with no UTM are bucketed as `'(direct)'` if
   * the referrer is empty, or `'(referral)'` if a `page_referrer` is set.
   */
  async trafficSources(opts: AnalyticsWindowOpts = {}): Promise<Array<{ source: string; sessions: number }>> {
    const events = await this.fetchAnalyticsEvents(opts);
    const counts = new Map<string, number>();
    for (const e of events) {
      if (e.message !== 'session_start') continue;
      const utm = e.payload?.utm_source as string | undefined;
      const ref = e.payload?.page_referrer as string | undefined;
      const source = utm ?? (ref ? '(referral)' : '(direct)');
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([source, sessions]) => ({ source, sessions }));
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Funnels
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Step-by-step drop-off through an ordered event sequence.
   *
   * For each `client_id`, walks the configured event sequence in order — a
   * client counts at step N if they emitted step N *after* emitting step
   * N-1, all within `windowMs` of each other.
   *
   * @returns Array with one entry per step: `{ step, name, count, conversionFromStart, conversionFromPrev }`.
   */
  async funnel(
    sequence: string[],
    opts: AnalyticsWindowOpts & { windowMs?: number } = {},
  ): Promise<Array<{ step: number; name: string; count: number; conversionFromStart: number; conversionFromPrev: number }>> {
    if (sequence.length === 0) return [];
    const events = await this.fetchAnalyticsEvents({ ...opts, sampleLimit: opts.sampleLimit ?? 100_000 });
    const windowMs = opts.windowMs ?? 30 * 60_000;

    // Group by client_id, sort by timestamp.
    const byClient = new Map<string, StoredTrackerEvent[]>();
    for (const e of events) {
      if (!sequence.includes(e.message)) continue;
      const cid = e.payload?.client_id;
      if (typeof cid !== 'string') continue;
      const arr = byClient.get(cid);
      if (arr) arr.push(e); else byClient.set(cid, [e]);
    }
    for (const arr of byClient.values()) arr.sort((a, b) => a.timestamp - b.timestamp);

    const counts = new Array(sequence.length).fill(0);
    for (const arr of byClient.values()) {
      let stepIdx = 0;
      let lastTs = 0;
      for (const e of arr) {
        if (e.message === sequence[stepIdx] && (stepIdx === 0 || (e.timestamp - lastTs) <= windowMs)) {
          counts[stepIdx]++;
          lastTs = e.timestamp;
          stepIdx++;
          if (stepIdx === sequence.length) break;
        }
      }
    }

    const start = counts[0] || 1;
    return sequence.map((name, step) => ({
      step,
      name,
      count: counts[step],
      conversionFromStart: counts[step] / start,
      conversionFromPrev:  step === 0 ? 1 : (counts[step - 1] === 0 ? 0 : counts[step] / counts[step - 1]),
    }));
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Cohort retention
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Cohort retention curve. Defines a cohort by the day of the visitor's
   * first observed event (`first_visit` or earliest `session_start`), then
   * computes how many of that cohort returned on each subsequent day up to
   * `retentionWindowDays`.
   *
   * @returns Matrix shaped `{ cohortDay, sizes: number[], retainedPerDay: number[][] }`.
   */
  async cohortRetention(opts: AnalyticsWindowOpts & {
    cohortBucketDays?:    number;
    retentionWindowDays?: number;
  } = {}): Promise<Array<{ cohort: string; size: number; retained: number[] }>> {
    const events = await this.fetchAnalyticsEvents({ ...opts, sampleLimit: opts.sampleLimit ?? 100_000 });
    const windowDays = opts.retentionWindowDays ?? 30;
    const bucketMs = (opts.cohortBucketDays ?? 1) * 86_400_000;

    // First-seen per client_id.
    const firstSeen = new Map<string, number>();
    const everySeen = new Map<string, Set<number>>(); // cid → set of day indexes seen
    for (const e of events) {
      const cid = e.payload?.client_id;
      if (typeof cid !== 'string') continue;
      const ts = e.timestamp;
      const cur = firstSeen.get(cid);
      if (cur === undefined || ts < cur) firstSeen.set(cid, ts);
      const dayIdx = Math.floor(ts / bucketMs);
      const seenSet = everySeen.get(cid);
      if (seenSet) seenSet.add(dayIdx); else everySeen.set(cid, new Set([dayIdx]));
    }

    // Group clients into cohorts by their first-seen bucket.
    const cohorts = new Map<number, string[]>(); // bucket → client ids
    for (const [cid, ts] of firstSeen.entries()) {
      const cohort = Math.floor(ts / bucketMs);
      const arr = cohorts.get(cohort);
      if (arr) arr.push(cid); else cohorts.set(cohort, [cid]);
    }

    // For each cohort, compute retained-per-day.
    const result: Array<{ cohort: string; size: number; retained: number[] }> = [];
    const sortedCohorts = Array.from(cohorts.keys()).sort((a, b) => a - b);
    for (const cohortBucket of sortedCohorts) {
      const cids = cohorts.get(cohortBucket)!;
      const retained = new Array<number>(windowDays).fill(0);
      for (const cid of cids) {
        const seenSet = everySeen.get(cid)!;
        for (let d = 0; d < windowDays; d++) {
          if (seenSet.has(cohortBucket + d)) retained[d]++;
        }
      }
      result.push({
        cohort: new Date(cohortBucket * bucketMs).toISOString().slice(0, 10),
        size: cids.length,
        retained,
      });
    }
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Attribution (last-touch)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Last-touch attribution for a conversion event. For each conversion, walks
   * back through the visitor's `session_start` events within `lookbackMs`
   * and credits the most recent one's `utm_source` / `page_referrer`.
   */
  async lastTouchAttribution(opts: AnalyticsWindowOpts & {
    conversionEvent: string;
    lookbackMs?:     number;
  }): Promise<Array<{ source: string; conversions: number }>> {
    const events = await this.fetchAnalyticsEvents({ ...opts, sampleLimit: opts.sampleLimit ?? 100_000 });
    const lookback = opts.lookbackMs ?? 7 * 86_400_000;

    // Sessions per client_id, sorted by ts.
    const sessionsByClient = new Map<string, StoredTrackerEvent[]>();
    const conversions: StoredTrackerEvent[] = [];
    for (const e of events) {
      if (e.message === 'session_start') {
        const cid = e.payload?.client_id;
        if (typeof cid !== 'string') continue;
        const arr = sessionsByClient.get(cid);
        if (arr) arr.push(e); else sessionsByClient.set(cid, [e]);
      } else if (e.message === opts.conversionEvent) {
        conversions.push(e);
      }
    }
    for (const arr of sessionsByClient.values()) arr.sort((a, b) => a.timestamp - b.timestamp);

    const credit = new Map<string, number>();
    for (const conv of conversions) {
      const cid = conv.payload?.client_id;
      if (typeof cid !== 'string') continue;
      const sessions = sessionsByClient.get(cid);
      if (!sessions || sessions.length === 0) continue;
      // Find the latest session_start before the conversion within lookback.
      let credited: StoredTrackerEvent | null = null;
      for (let i = sessions.length - 1; i >= 0; i--) {
        const s = sessions[i];
        if (s.timestamp <= conv.timestamp && (conv.timestamp - s.timestamp) <= lookback) {
          credited = s;
          break;
        }
      }
      if (!credited) continue;
      const source = (credited.payload?.utm_source as string)
        ?? (credited.payload?.page_referrer ? '(referral)' : '(direct)');
      credit.set(source, (credit.get(source) ?? 0) + 1);
    }
    return Array.from(credit.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([source, conversions]) => ({ source, conversions }));
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Internals
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Fetch up to `sampleLimit` events with `category: 'analytics'` (or
   * `'ecommerce'`) within the time window. Used as the base sample for every
   * aggregation here.
   */
  private async fetchAnalyticsEvents(opts: AnalyticsWindowOpts): Promise<StoredTrackerEvent[]> {
    const until = opts.until ?? Date.now();
    const since = opts.since ?? until - AnalyticsQueryHelpers.DEFAULT_WINDOW_MS;
    const limit = opts.sampleLimit ?? AnalyticsQueryHelpers.DEFAULT_SAMPLE_LIMIT;
    return this.storage.find({
      appId: this.appId,
      from:  since,
      to:    until,
      limit,
      sortBy:  'timestamp',
      sortDir: 'asc',
    });
  }
}
