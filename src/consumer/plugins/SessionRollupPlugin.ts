import type { ITrackerPlugin, ITrackerServiceRef } from '../ITrackerPlugin';
import type { StoredTrackerEvent } from '../../common/types';

/** State maintained per session in memory; flushed to the underlying storage on session_end or interval. */
interface SessionRollupState {
  appId:          string | undefined;
  clientId:       string;
  sessionId:      string;
  sessionNumber:  number | undefined;
  startTs:        number;
  lastTs:         number;
  pageViews:      number;
  events:         number;
  utmSource:      string | undefined;
  pageReferrer:   string | undefined;
  firstPagePath:  string | undefined;
  lastPagePath:   string | undefined;
  userId:         string | undefined;
}

/**
 * Storage interface for session rollup writes. The plugin doesn't care
 * whether you're writing to TypeORM, Postgres directly, BigQuery, etc — pass
 * any object that implements this interface.
 *
 * For Postgres, a typical implementation is `INSERT ... ON CONFLICT (session_id)
 * DO UPDATE` against a `tracker_sessions` table.
 */
export interface ISessionRollupSink {
  upsert(state: SessionRollupState): Promise<void>;
}

/**
 * Maintains a per-session aggregate by listening to every event from the
 * AnalyticsPlugin and incrementally updating an in-memory map. On each
 * `session_end` (or every `flushIntervalMs`), the rolled-up state is written
 * to the configured `ISessionRollupSink`.
 *
 * Use this when query latency matters more than storage cost — a
 * `tracker_sessions` table is several orders of magnitude smaller than the
 * raw event log and supports flat SQL queries for DAU/MAU, top sources,
 * session duration percentiles, etc.
 *
 * If `sink` is omitted, the plugin keeps state in memory only (useful for
 * tests and for `instance.snapshot()` debug callers).
 */
export class SessionRollupPlugin implements ITrackerPlugin {
  static readonly PLUGIN_NAME = 'SessionRollupPlugin';
  readonly name = SessionRollupPlugin.PLUGIN_NAME;

  private readonly states = new Map<string, SessionRollupState>();
  private readonly flushHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly opts: {
      sink?:            ISessionRollupSink;
      flushIntervalMs?: number;
    } = {},
  ) {
    const flushMs = opts.flushIntervalMs ?? 60_000;
    if (typeof setInterval !== 'undefined') {
      this.flushHandle = setInterval(() => { void this.flushAll(); }, flushMs);
    }
  }

  onInit(_ref: ITrackerServiceRef): void { /* nothing to set up */ }

  /** Update rollup state for the event. Idempotent on repeats (same id). */
  async onEvent(event: StoredTrackerEvent): Promise<void> {
    if (event.category !== 'analytics' && event.category !== 'ecommerce') return;
    const sessionId = event.payload?.session_id as string | undefined;
    const clientId  = event.payload?.client_id as string | undefined;
    if (!sessionId || !clientId) return;

    const existing = this.states.get(sessionId);
    if (existing) {
      existing.lastTs = Math.max(existing.lastTs, event.timestamp);
      existing.events += 1;
      if (event.message === 'page_view') {
        existing.pageViews += 1;
        existing.lastPagePath = event.payload?.page_path as string | undefined;
        if (existing.firstPagePath === undefined) existing.firstPagePath = existing.lastPagePath;
      }
      if (event.context?.userId) existing.userId = event.context.userId;
    } else {
      this.states.set(sessionId, {
        appId:         event.appId,
        clientId,
        sessionId,
        sessionNumber: event.payload?.session_number as number | undefined,
        startTs:       event.timestamp,
        lastTs:        event.timestamp,
        pageViews:     event.message === 'page_view' ? 1 : 0,
        events:        1,
        utmSource:     event.payload?.utm_source as string | undefined,
        pageReferrer:  event.payload?.page_referrer as string | undefined,
        firstPagePath: event.message === 'page_view' ? (event.payload?.page_path as string | undefined) : undefined,
        lastPagePath:  event.message === 'page_view' ? (event.payload?.page_path as string | undefined) : undefined,
        userId:        event.context?.userId,
      });
    }

    // Flush this session immediately on session_end.
    if (event.message === 'session_end') {
      const state = this.states.get(sessionId);
      if (state && this.opts.sink) {
        try { await this.opts.sink.upsert(state); }
        catch { /* failure shouldn't break event ingest */ }
      }
      this.states.delete(sessionId);
    }
  }

  /** Snapshot current in-memory state — useful for tests or admin endpoints. */
  snapshot(): SessionRollupState[] {
    return Array.from(this.states.values()).map(s => ({ ...s }));
  }

  /** Flush every active session to the sink. Called on interval and on destroy. */
  async flushAll(): Promise<void> {
    if (!this.opts.sink) return;
    for (const state of this.states.values()) {
      try { await this.opts.sink.upsert(state); }
      catch { /* swallow */ }
    }
  }

  async onDestroy(): Promise<void> {
    if (this.flushHandle !== null) clearInterval(this.flushHandle);
    await this.flushAll();
  }
}

export type { SessionRollupState };
