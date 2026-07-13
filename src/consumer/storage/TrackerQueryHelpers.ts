import type { EventType, StoredTrackerEvent, TrackerEventStatus } from '../../common/types';
import type { ITrackerStorage, ITrackerStorageFilter } from './ITrackerStorage';

/**
 * Common-case tracker queries, built on top of `ITrackerStorage.find`.
 *
 * Most dashboards and debugging tools reach for the same handful of shapes:
 * recent errors, event counts by type, top error messages, activity for a
 * specific user, etc. This helper captures them as single-method calls so
 * every consumer doesn't reimplement the same `find({ type: 'error', from: ... })`
 * boilerplate.
 *
 * ## Usage
 *
 * App-scoped (most common — auto-filters every query by `appId`):
 *
 * ```ts
 * const queries = new TrackerQueryHelpers(storage, 'release-manager');
 * const recent  = await queries.recentErrors();                    // last 1h, default 100
 * const rate    = await queries.errorRate({ windowMs: 86_400_000 });
 * const topOops = await queries.topErrorMessages({ topN: 10 });
 * ```
 *
 * Cross-app (aggregate across every app in the catalog):
 *
 * ```ts
 * const global  = new TrackerQueryHelpers(storage);
 * const volume  = await global.topApps({ topN: 20 });
 * const errRate = await global.errorRate();
 * ```
 *
 * ## In-process aggregation caveat
 *
 * Aggregation methods pull up to `opts.sampleLimit` events (default 5,000)
 * and tally in memory. For event volumes beyond that, either widen
 * `sampleLimit` at the cost of latency + memory, or push aggregation down
 * to SQL with `COUNT() + GROUP BY` in a custom storage method. The helper
 * is for dashboards and troubleshooting, not for production analytics
 * pipelines.
 */
export class TrackerQueryHelpers {
    /** Default window for "recent" shortcuts (1 hour). */
    static readonly DEFAULT_WINDOW_MS = 3_600_000;
    /** Default row limit for retrieval shortcuts. */
    static readonly DEFAULT_LIMIT = 100;
    /** Default sample size pulled into memory for aggregations. */
    static readonly DEFAULT_SAMPLE_LIMIT = 5_000;

    constructor(
        private readonly storage: ITrackerStorage,
        /** When set, every query auto-filters by this appId. Omit for cross-app queries. */
        private readonly appId?: string,
    ) {}

    // ─────────────────────────────────────────────────────────────────────
    //  Retrieval shortcuts — thin wrappers over storage.find()
    // ─────────────────────────────────────────────────────────────────────

    /** Pull the event with this id, if any. Passes through to `storage.findById`. */
    findById(id: string): Promise<StoredTrackerEvent | null> {
        return this.storage.findById(id);
    }

    /** Recent events (any type), newest first. */
    recent(opts: RecentOpts = {}): Promise<StoredTrackerEvent[]> {
        return this.findInWindow(opts);
    }

    /** Recent errors. */
    recentErrors(opts: RecentOpts = {}): Promise<StoredTrackerEvent[]> {
        return this.findInWindow({ ...opts, filter: { ...opts.filter, type: 'error' } });
    }

    /** Recent warnings. */
    recentWarnings(opts: RecentOpts = {}): Promise<StoredTrackerEvent[]> {
        return this.findInWindow({ ...opts, filter: { ...opts.filter, type: 'warning' } });
    }

    /** Recent info-level events. */
    recentInfo(opts: RecentOpts = {}): Promise<StoredTrackerEvent[]> {
        return this.findInWindow({ ...opts, filter: { ...opts.filter, type: 'info' } });
    }

    /** Recent events of a given type. */
    byType(type: EventType, opts: RecentOpts = {}): Promise<StoredTrackerEvent[]> {
        return this.findInWindow({ ...opts, filter: { ...opts.filter, type } });
    }

    /** Events whose lifecycle status matches — useful for triage queues ('new', 'acknowledged', ...). */
    byStatus(status: TrackerEventStatus, opts: RecentOpts = {}): Promise<StoredTrackerEvent[]> {
        return this.findInWindow({ ...opts, filter: { ...opts.filter, status } });
    }

    /** Events for a specific user (matches `context.userId`). */
    forUser(userId: string, opts: RecentOpts = {}): Promise<StoredTrackerEvent[]> {
        return this.findInWindow({ ...opts, filter: { ...opts.filter, userId } });
    }

    /** Events from a specific deployment environment (e.g. `'production'`). */
    forEnvironment(environment: string, opts: RecentOpts = {}): Promise<StoredTrackerEvent[]> {
        return this.findInWindow({ ...opts, filter: { ...opts.filter, environment } });
    }

    /** Events under a category (e.g. `'payment'`, `'auction'`). */
    forCategory(category: string, opts: RecentOpts = {}): Promise<StoredTrackerEvent[]> {
        return this.findInWindow({ ...opts, filter: { ...opts.filter, category } });
    }

    /** Events carrying ALL of the listed tags. */
    withTags(tags: string[], opts: RecentOpts = {}): Promise<StoredTrackerEvent[]> {
        return this.findInWindow({ ...opts, filter: { ...opts.filter, tags } });
    }

    /**
     * Events where the payload JSONB contains the given key/value pairs.
     * Uses the underlying Postgres `@>` containment operator (GIN-indexed).
     * @example queries.withPayload({ orderId: '123', step: 'failed' })
     */
    withPayload(
        payloadFilters: Record<string, string>,
        opts: RecentOpts = {},
    ): Promise<StoredTrackerEvent[]> {
        return this.findInWindow({ ...opts, filter: { ...opts.filter, payloadFilters } });
    }

    /** Events within an explicit time range. */
    inRange(
        range: { from: number; to: number },
        opts: Omit<RecentOpts, 'windowMs'> = {},
    ): Promise<StoredTrackerEvent[]> {
        return this.storage.find({
            ...(this.appId ? { appId: this.appId } : {}),
            from: range.from,
            to: range.to,
            limit: opts.limit ?? TrackerQueryHelpers.DEFAULT_LIMIT,
            ...opts.filter,
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Aggregations — in-process tally over a sampled window
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Tally events by type in the window.
     * Returns `{ error: N, warning: N, info: N, debug: N, event: N }` — any
     * type with zero events is omitted.
     */
    async countsByType(opts: AggregateOpts = {}): Promise<Partial<Record<EventType, number>>> {
        const events = await this.sampleWindow(opts);
        return this.tally(events, (e) => e.type) as Partial<Record<EventType, number>>;
    }

    /** Tally events by lifecycle status (useful for triage queue sizes). */
    async countsByStatus(opts: AggregateOpts = {}): Promise<Record<string, number>> {
        const events = await this.sampleWindow(opts);
        return this.tally(events, (e) => e.status);
    }

    /**
     * Error rate in the window, as a float `[0, 1]`. Returns 0 when no events.
     * A useful single-number health metric for dashboards.
     */
    async errorRate(opts: AggregateOpts = {}): Promise<number> {
        const counts = await this.countsByType(opts);
        const total = Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
        if (total === 0) return 0;
        return (counts.error ?? 0) / total;
    }

    /** Top N error messages by frequency — "what's breaking the most". */
    async topErrorMessages(opts: TopNOpts = {}): Promise<TopEntry[]> {
        const events = await this.sampleWindow({
            ...opts,
            filter: { ...opts.filter, type: 'error' },
        });
        return this.topN(events, (e) => e.message, opts.topN ?? 10);
    }

    /** Top N categories by event frequency — which parts of the app are chattiest. */
    async topCategories(opts: TopNOpts = {}): Promise<TopEntry[]> {
        const events = await this.sampleWindow(opts);
        return this.topN(events, (e) => e.category, opts.topN ?? 10);
    }

    /** Top N users by event frequency — who's hitting the most error paths. */
    async topUsers(opts: TopNOpts = {}): Promise<TopEntry[]> {
        const events = await this.sampleWindow(opts);
        return this.topN(events, (e) => e.context?.userId, opts.topN ?? 10);
    }

    /**
     * Top N apps by event volume. Most useful when constructed **without**
     * an appId (cross-app helper); if constructed with one, all events
     * roll up to that single app.
     */
    async topApps(opts: TopNOpts = {}): Promise<TopEntry[]> {
        const events = await this.sampleWindow(opts);
        return this.topN(events, (e) => e.appId, opts.topN ?? 20);
    }

    /** Top N tag values by frequency (flattened across each event's tag array). */
    async topTags(opts: TopNOpts = {}): Promise<TopEntry[]> {
        const events = await this.sampleWindow(opts);
        const counts: Record<string, number> = {};
        for (const e of events) {
            for (const t of e.tags ?? []) counts[t] = (counts[t] ?? 0) + 1;
        }
        return Object.entries(counts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, opts.topN ?? 10)
            .map(([value, count]) => ({ value, count }));
    }

    /**
     * Event counts bucketed across the time window — used to render error-rate
     * / volume sparklines. Buckets are evenly sized.
     *
     * Returns `[{ from, to, total, errors }]` with the most recent bucket last.
     */
    async timeline(
        opts: TimelineOpts = {},
    ): Promise<{ from: number; to: number; total: number; errors: number }[]> {
        const windowMs = opts.windowMs ?? TrackerQueryHelpers.DEFAULT_WINDOW_MS;
        const buckets = Math.max(1, opts.buckets ?? 24);
        const now = Date.now();
        const from = now - windowMs;
        const bucketMs = Math.ceil(windowMs / buckets);

        const events = await this.storage.find({
            ...(this.appId ? { appId: this.appId } : {}),
            from,
            to: now,
            limit: opts.sampleLimit ?? TrackerQueryHelpers.DEFAULT_SAMPLE_LIMIT,
            sortBy: 'receivedAt',
            sortDir: 'asc',
            ...opts.filter,
        });

        const out = Array.from({ length: buckets }, (_, i) => ({
            from: from + i * bucketMs,
            to: Math.min(from + (i + 1) * bucketMs, now),
            total: 0,
            errors: 0,
        }));

        for (const e of events) {
            const idx = Math.min(buckets - 1, Math.floor((e.receivedAt - from) / bucketMs));
            if (idx < 0) continue;
            out[idx].total += 1;
            if (e.type === 'error') out[idx].errors += 1;
        }

        return out;
    }

    /**
     * One-shot dashboard summary — convenience for "just give me the overview".
     * Combines several of the helpers above into a single object, single call.
     */
    async healthSnapshot(opts: AggregateOpts = {}): Promise<HealthSnapshot> {
        const windowMs = opts.windowMs ?? TrackerQueryHelpers.DEFAULT_WINDOW_MS;
        const sampleLimit = opts.sampleLimit ?? TrackerQueryHelpers.DEFAULT_SAMPLE_LIMIT;
        const events = await this.sampleWindow({ windowMs, sampleLimit, filter: opts.filter });

        const counts = this.tally(events, (e) => e.type) as Partial<Record<EventType, number>>;
        const total = events.length;
        const errors = counts.error ?? 0;
        const warnings = counts.warning ?? 0;

        return {
            windowMs,
            sampleLimit,
            sampled: total,
            truncated: total >= sampleLimit,
            counts,
            errorRate: total === 0 ? 0 : errors / total,
            warnings,
            errors,
            topErrorMessages: this.topN(
                events.filter((e) => e.type === 'error'),
                (e) => e.message,
                opts.topN ?? 5,
            ),
            topCategories: this.topN(events, (e) => e.category, opts.topN ?? 5),
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Internals
    // ─────────────────────────────────────────────────────────────────────

    /** Build a filter that applies appId-scoping + window + caller overrides. */
    private baseFilter(opts: { windowMs?: number } = {}): ITrackerStorageFilter {
        const windowMs = opts.windowMs ?? TrackerQueryHelpers.DEFAULT_WINDOW_MS;
        const now = Date.now();
        return {
            ...(this.appId ? { appId: this.appId } : {}),
            from: now - windowMs,
            to: now,
        };
    }

    private findInWindow(opts: RecentOpts): Promise<StoredTrackerEvent[]> {
        return this.storage.find({
            ...this.baseFilter(opts),
            limit: opts.limit ?? TrackerQueryHelpers.DEFAULT_LIMIT,
            ...opts.filter,
        });
    }

    private sampleWindow(opts: AggregateOpts): Promise<StoredTrackerEvent[]> {
        return this.storage.find({
            ...this.baseFilter(opts),
            limit: opts.sampleLimit ?? TrackerQueryHelpers.DEFAULT_SAMPLE_LIMIT,
            ...opts.filter,
        });
    }

    private tally<T>(events: T[], key: (e: T) => string | undefined): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const e of events) {
            const k = key(e);
            if (k === undefined) continue;
            counts[k] = (counts[k] ?? 0) + 1;
        }
        return counts;
    }

    private topN<T>(events: T[], key: (e: T) => string | undefined, n: number): TopEntry[] {
        const counts = this.tally(events, key);
        return Object.entries(counts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, n)
            .map(([value, count]) => ({ value, count }));
    }
}

// ─── Option types ───────────────────────────────────────────────────────

/** Options for retrieval shortcuts (recent*, byType, etc.). */
export interface RecentOpts {
    /** Window size in ms. Default: 1 hour. */
    windowMs?: number;
    /** Max events to return. Default: 100. */
    limit?: number;
    /** Extra filter fields merged into the underlying storage filter. */
    filter?: Partial<ITrackerStorageFilter>;
}

/** Options for aggregations. */
export interface AggregateOpts {
    /** Window size in ms. Default: 1 hour. */
    windowMs?: number;
    /** Max events pulled into memory for the tally. Default: 5,000. */
    sampleLimit?: number;
    /** Extra filter fields merged into the underlying storage filter. */
    filter?: Partial<ITrackerStorageFilter>;
    /** Only used by snapshot — top-N cutoff inside the snapshot's sub-aggregations. */
    topN?: number;
}

/** Options for top-N aggregations. */
export interface TopNOpts extends AggregateOpts {
    /** How many entries to return. Default: 10 (20 for topApps). */
    topN?: number;
}

/** Options for the bucketed timeline. */
export interface TimelineOpts {
    windowMs?: number;
    /** Number of equal-sized time buckets. Default: 24. */
    buckets?: number;
    /** Sample cap. Default: 5,000. */
    sampleLimit?: number;
    filter?: Partial<ITrackerStorageFilter>;
}

/** A `{ value, count }` pair returned by top-N aggregators. */
export interface TopEntry {
    value: string;
    count: number;
}

/** Dashboard snapshot returned by `healthSnapshot()`. */
export interface HealthSnapshot {
    /** The window width used, in ms. */
    windowMs: number;
    /** Cap used when sampling from storage. */
    sampleLimit: number;
    /** How many events were actually pulled into memory. */
    sampled: number;
    /** True when the sample hit the cap — tallies may under-represent reality. */
    truncated: boolean;
    /** Counts by event type for the sampled window. */
    counts: Partial<Record<EventType, number>>;
    /** errors / total. `0` when the window has no events. */
    errorRate: number;
    /** Convenience: counts.error. */
    errors: number;
    /** Convenience: counts.warning. */
    warnings: number;
    /** Top error messages by frequency. */
    topErrorMessages: TopEntry[];
    /** Top categories by frequency. */
    topCategories: TopEntry[];
}
