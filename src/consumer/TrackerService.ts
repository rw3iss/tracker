import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import type { TrackerEvent, TrackerEventStatus, StoredTrackerEvent } from '../common/types';
import { TrackerEventStatus as Status } from '../common/types';
import { TRACKER_DEDUPLICATOR, TRACKER_MODULE_OPTIONS, TRACKER_PLUGINS } from './constants';
import type { ITrackerStorage, ITrackerStorageFilter } from './storage/ITrackerStorage';
import type { TrackerDeduplicator } from './TrackerDeduplicator';
import type { ITrackerPlugin, IngestContext } from './ITrackerPlugin';
import type { TrackerModuleOptions } from './TrackerModule';

const logger = new Logger('TrackerService');

/**
 * Module-scoped singleton reference.
 * Set during onModuleInit, cleared during onModuleDestroy.
 * Enables `TrackerService.instance()` for non-DI access.
 */
let _instance: TrackerService | null = null;

/** Build a map of plugin name → resolved wave index for topological sorting. */
function buildWaves(plugins: ITrackerPlugin[]): ITrackerPlugin[][] {
  const named = new Map<string, ITrackerPlugin>();
  for (const p of plugins) {
    if (p.name) named.set(p.name, p);
  }

  const waveOf = new Map<ITrackerPlugin, number>();
  const visited = new Set<ITrackerPlugin>();

  function resolveWave(p: ITrackerPlugin, stack: Set<ITrackerPlugin>): number {
    if (waveOf.has(p)) return waveOf.get(p)!;
    if (stack.has(p)) throw new Error(`Circular plugin dependency detected for "${p.name ?? '(unnamed)'}"`);

    stack.add(p);
    let wave = 0;

    for (const depName of (p.after ?? [])) {
      const dep = named.get(depName);
      if (!dep) continue;
      wave = Math.max(wave, resolveWave(dep, stack) + 1);
    }

    stack.delete(p);
    waveOf.set(p, wave);
    visited.add(p);
    return wave;
  }

  for (const p of plugins) {
    resolveWave(p, new Set());
  }

  const maxWave = Math.max(...[...waveOf.values()], 0);
  const waves: ITrackerPlugin[][] = Array.from({ length: maxWave + 1 }, () => []);
  for (const p of plugins) {
    waves[waveOf.get(p) ?? 0].push(p);
  }
  return waves.filter(w => w.length > 0);
}

/**
 * Core server-side event processing engine.
 *
 * TrackerService handles the full server-side pipeline for tracker events:
 * 1. Size enforcement ({@link TrackerModuleOptions.maxEventBytes})
 * 2. Server-side enrichers ({@link TrackerModuleOptions.serverEnrichers})
 * 3. Plugin `onIngest` hooks (sequential, can veto events)
 * 4. Deduplication (optional, via {@link TrackerDeduplicator})
 * 5. Stamping with `id`, `status`, and `receivedAt`
 * 6. Plugin `onEvent` hooks (topological wave execution)
 *
 * @remarks
 * TrackerService is NOT a capture API -- always use `TrackerClient` as the
 * public API surface. For server self-tracking, use {@link DirectTransport} to
 * route `TrackerClient` events into this service without HTTP.
 *
 * @see `TrackerClient` for the public capture API.
 * @see {@link DirectTransport} for server self-tracking.
 * @see {@link TrackerModule} for NestJS module registration.
 */
@Injectable()
export class TrackerService implements OnModuleInit, OnModuleDestroy {
  /** Registered by EventStoragePlugin.onInit() — null until a storage plugin is added. */
  private storage: ITrackerStorage | null = null;
  private metricsProvider: (() => string) | null = null;
  private pluginWaves: ITrackerPlugin[][] = [];

  /**
   * Get the singleton TrackerService instance without dependency injection.
   *
   * Available after the NestJS module initializes. Use this from utility functions,
   * middleware, or non-DI code that needs to track events on the same server
   * without an HTTP roundtrip.
   *
   * @returns The TrackerService instance, or `null` if TrackerModule has not initialized yet.
   *
   * @example
   * ```typescript
   * const svc = TrackerService.instance();
   * if (svc) {
   *   await svc.track(event);
   * }
   * ```
   *
   * @see {@link DirectTransport}
   */
  static instance(): TrackerService | null {
    return _instance;
  }

  constructor(
    @Optional() @Inject(TRACKER_DEDUPLICATOR) private readonly deduplicator: TrackerDeduplicator | null,
    @Optional() @Inject(TRACKER_PLUGINS)      private readonly plugins: ITrackerPlugin[] = [],
    @Optional() @Inject(TRACKER_MODULE_OPTIONS) private readonly options: TrackerModuleOptions | null = null,
  ) {}

  /**
   * Register a storage adapter for query and status update support.
   *
   * Called internally by storage plugins (e.g. `EventStoragePlugin`) during
   * their `onInit` hook. After registration, the {@link query} and
   * {@link updateStatus} methods become functional.
   *
   * @param storage - The storage adapter to register.
   *
   * @see {@link ITrackerStorage}
   */
  setStorage(storage: ITrackerStorage): void {
    this.storage = storage;
  }

  /**
   * Register a Prometheus metrics provider.
   *
   * The registered function is called by the `GET /tracker/metrics` endpoint
   * to generate metrics output.
   *
   * @param fn - Function returning Prometheus text exposition format string.
   */
  registerMetricsProvider(fn: () => string): void {
    this.metricsProvider = fn;
  }

  /**
   * Get the current Prometheus metrics string.
   *
   * @returns Prometheus-formatted metrics, or empty string if no provider is registered.
   */
  getMetrics(): string {
    return this.metricsProvider?.() ?? '';
  }

  async onModuleInit(): Promise<void> {
    _instance = this;
    this.pluginWaves = buildWaves(this.plugins);
    for (const plugin of this.plugins) {
      await plugin.onInit?.(this);
    }
  }

  private getWaves(): ITrackerPlugin[][] {
    if (this.pluginWaves.length === 0 && this.plugins.length > 0) {
      this.pluginWaves = buildWaves(this.plugins);
    }
    return this.pluginWaves;
  }

  async onModuleDestroy(): Promise<void> {
    if (_instance === this) _instance = null;
    for (const plugin of this.plugins) {
      await plugin.onDestroy?.();
    }
  }

  /**
   * Process a single event through the full server pipeline.
   *
   * Pipeline stages:
   * 1. Enforce `maxEventBytes` (truncate or reject oversized events)
   * 2. Run `serverEnrichers` in sequence
   * 3. Run plugin `onIngest` hooks sequentially (null return vetoes the event)
   * 4. Deduplication check (if enabled)
   * 5. Stamp `id`, `status: New`, `receivedAt`
   * 6. Execute plugin `onEvent` hooks in topological waves
   *
   * @param event - The event to process.
   * @param ctx - Optional ingestion context (IP, headers, URL from the HTTP request).
   *
   * @see {@link trackBatch} for batch processing.
   * @see {@link IngestContext}
   */
  async track(event: TrackerEvent, ctx: IngestContext = {}): Promise<void> {
    let current: TrackerEvent = event;

    // 1. Enforce maxEventBytes
    const maxBytes = this.options?.maxEventBytes;
    if (maxBytes !== undefined) {
      if (JSON.stringify(current).length > maxBytes) {
        // Truncate long payload string values
        if (current.payload) {
          current = {
            ...current,
            payload: Object.fromEntries(
              Object.entries(current.payload).map(([k, v]) =>
                typeof v === 'string' && v.length > 1000
                  ? [k, v.slice(0, 1000)]
                  : [k, v],
              ),
            ),
          };
        }
        if (JSON.stringify(current).length > maxBytes) {
          logger.warn(`Event rejected: exceeds maxEventBytes (${maxBytes}). type=${current.type} appId=${current.appId ?? ''}`);
          return;
        }
      }
    }

    // 2. Run serverEnrichers in sequence
    for (const enricher of (this.options?.serverEnrichers ?? [])) {
      current = await enricher(current, ctx);
    }

    // 3. Run plugin.onIngest sequentially — null return vetoes the event
    for (const plugin of this.plugins) {
      if (!plugin.onIngest) continue;
      const result = await plugin.onIngest(current, ctx);
      if (result === null) return;
      current = result;
    }

    // 4. Deduplication
    if (this.deduplicator && await this.deduplicator.isDuplicate(current)) return;

    // 5. Stamp id, status, receivedAt
    const stored: StoredTrackerEvent = {
      ...current,
      id:         randomUUID(),
      status:     Status.New,
      receivedAt: Date.now(),
    };

    // 6. Execute onEvent in topological waves; each wave uses Promise.allSettled
    const concurrency = this.options?.pluginConcurrency ?? Infinity;

    for (const wave of this.getWaves()) {
      if (concurrency === Infinity) {
        await Promise.allSettled(wave.map(p => Promise.resolve(p.onEvent(stored)).catch(() => {})));
      } else {
        // Process wave in chunks of `concurrency`
        for (let i = 0; i < wave.length; i += concurrency) {
          const chunk = wave.slice(i, i + concurrency);
          await Promise.allSettled(chunk.map(p => Promise.resolve(p.onEvent(stored)).catch(() => {})));
        }
      }
    }
  }

  /**
   * Process a batch of events.
   *
   * When deduplication is enabled, events are processed sequentially to avoid
   * race conditions on the dedup cache. When disabled, events are processed
   * in parallel for better throughput (individual failures do not block the batch).
   *
   * @param events - Array of events to process.
   * @param ctx - Optional ingestion context shared across all events in the batch.
   *
   * @see {@link track}
   */
  async trackBatch(events: TrackerEvent[], ctx: IngestContext = {}): Promise<void> {
    if (this.deduplicator) {
      // Sequential when dedup is enabled — parallel would race on identical events
      for (const event of events) {
        await this.track(event, ctx);
      }
    } else {
      // Parallel when no dedup — individual failures don't block the batch
      await Promise.allSettled(events.map(event => this.track(event, ctx)));
    }
  }

  /**
   * Update a stored event's lifecycle status.
   *
   * No-op if no storage plugin is registered.
   *
   * @param id - The event UUID to update.
   * @param status - The new {@link TrackerEventStatus} to set.
   *
   * @see {@link TrackerEventStatus}
   */
  async updateStatus(id: string, status: TrackerEventStatus): Promise<void> {
    await this.storage?.updateStatus(id, status);
  }

  /**
   * Query stored events with optional filters.
   *
   * Returns an empty array if no storage plugin is registered.
   *
   * @param filters - Optional query filters (type, status, date range, pagination, etc.).
   * @returns Array of matching {@link StoredTrackerEvent}s.
   *
   * @see {@link ITrackerStorageFilter}
   */
  async query(filters?: ITrackerStorageFilter): Promise<StoredTrackerEvent[]> {
    if (!this.storage) return [];
    return this.storage.find(filters);
  }

  /**
   * Fetch a single stored event by its UUID, or `null` if it doesn't
   * exist (or no storage is registered). Powers the dashboard's
   * `?event_id=…` deep-link feature — admins can paste a permalink and
   * the detail pane opens straight on that event, even if it's not in
   * the currently-loaded results window.
   */
  async queryOne(id: string): Promise<StoredTrackerEvent | null> {
    if (!this.storage) return null;
    return this.storage.findById(id);
  }

  /**
   * Distinct values + counts for a column. Powers the dashboard's
   * App-ID multi-select picker, but exposed generically so future
   * dropdowns (category, environment, …) reuse the same plumbing.
   *
   * Returns an empty array if no storage plugin is registered.
   *
   * @see {@link ITrackerStorage.distinct}
   */
  /**
   * Delete stored events matching the filter (or every row, if no
   * filter is passed). The single shared code path used by both the
   * server's CLI tool (`scripts/clear-events.ts`) and the admin HTTP
   * endpoint — keep the security check (key auth, dashboard role) at
   * the call site, not in here.
   *
   * Returns the row count when the adapter reports it, or `-1` when
   * the adapter can't produce one (Console, SQS).
   *
   * @see {@link ITrackerStorage.clear}
   */
  async clearEvents(
    filters?: import('./storage/ITrackerStorage').ITrackerStorageFilter,
  ): Promise<number> {
    if (!this.storage) return 0;
    return this.storage.clear(filters);
  }

  async queryDistinct(
    field: import('./storage/ITrackerStorage').DistinctField,
    opts?: { limit?: number; sinceMs?: number },
  ): Promise<Array<{ value: string; count: number }>> {
    if (!this.storage) return [];
    return this.storage.distinct(field, opts);
  }
}
