import type { StoredTrackerEvent, TrackerEvent } from '../common/types';
import type { ITrackerStorage } from './storage/ITrackerStorage';

/**
 * Contextual metadata about the HTTP request that delivered the event.
 *
 * Populated by {@link TrackerController} and passed to server-side enrichers
 * and plugin hooks. Available fields depend on the ingestion method.
 *
 * @see {@link ITrackerPlugin.onIngest}
 * @see {@link TrackerService.track}
 */
export interface IngestContext {
  /** Client IP address, extracted from `X-Forwarded-For` or socket address. */
  ip?:      string;
  /** Request URL path. */
  url?:     string;
  /** Raw HTTP headers from the ingestion request. */
  headers?: Record<string, string>;
}

/**
 * Minimal {@link TrackerService} surface exposed to server-side plugins.
 *
 * Avoids circular imports by not exposing the full TrackerService class.
 * Plugins receive this reference in their {@link ITrackerPlugin.onInit} hook.
 *
 * @see {@link ITrackerPlugin.onInit}
 */
export interface ITrackerServiceRef {
  /**
   * Ingest a single event through the full server pipeline.
   *
   * @param event - The event to process.
   * @param ctx - Optional ingestion context (IP, headers, etc.).
   */
  track(event: TrackerEvent, ctx?: IngestContext): Promise<void>;

  /**
   * Register a storage adapter with the tracker service.
   *
   * Called by storage plugins (e.g. `EventStoragePlugin`) during
   * {@link ITrackerPlugin.onInit} to enable query and status update endpoints.
   *
   * @param storage - The storage adapter to register.
   */
  setStorage(storage: ITrackerStorage): void;

  /**
   * Register a Prometheus metrics provider function.
   *
   * The function should return metrics in Prometheus text exposition format.
   * Called by metrics plugins during init.
   *
   * @param fn - Function that returns Prometheus-formatted metrics string.
   */
  registerMetricsProvider(fn: () => string): void;
}

/**
 * Plugin interface for server-side `TrackerService` extensions.
 *
 * Server plugins hook into the event processing pipeline at multiple points:
 *
 * 1. **{@link onInit}** -- called once during NestJS module initialization.
 *    Use to capture the service reference, set up connections, or register storage.
 * 2. **{@link onIngest}** -- called sequentially before dedup/storage. Return `null`
 *    to veto (drop) the event. Use for server-side filtering or transformation.
 * 3. **{@link onEvent}** -- called after the event is stamped with `id`, `status`,
 *    and `receivedAt`. Fire-and-forget; errors are swallowed. Use for storage,
 *    forwarding, alerting, etc.
 * 4. **{@link onDestroy}** -- called during NestJS module teardown.
 *    Close connections and release resources.
 *
 * Plugins support topological ordering via `name` and {@link after} fields,
 * ensuring correct initialization and execution order.
 *
 * @example
 * ```typescript
 * const loggingPlugin: ITrackerPlugin = {
 *   name: 'LoggingPlugin',
 *   onEvent(event) {
 *     console.log(`[${event.type}] ${event.message}`);
 *   },
 * };
 * ```
 *
 * @see `TrackerModuleOptions.plugins`
 * @see {@link ITrackerServiceRef}
 */
export interface ITrackerPlugin {
  /**
   * Unique plugin name -- used for dependency ordering via {@link after}.
   * Optional, but required if other plugins depend on this one.
   */
  name?: string;

  /**
   * Names of plugins that must be initialized before this one.
   * Used for topological sorting of plugin execution order.
   *
   * @example
   * ```typescript
   * { name: 'AlertPlugin', after: ['EventStoragePlugin'] }
   * ```
   */
  after?: string[];

  /**
   * Called once when the NestJS `TrackerModule` initializes.
   *
   * Use to capture the {@link ITrackerServiceRef}, register storage adapters,
   * open connections, or perform async setup.
   *
   * @param trackerService - Minimal service reference for tracking and storage registration.
   */
  onInit?(trackerService: ITrackerServiceRef): void | Promise<void>;

  /**
   * Sequential hook called before deduplication and storage.
   *
   * Return the event (possibly modified) to continue processing,
   * or `null` to veto (silently drop) the event.
   *
   * @param event - The event being ingested.
   * @param ctx - Ingestion context with IP, URL, and headers.
   * @returns The event to continue with, or `null` to drop it.
   */
  onIngest?(event: TrackerEvent, ctx: IngestContext): TrackerEvent | null | Promise<TrackerEvent | null>;

  /**
   * Called after every event is stamped and stored.
   *
   * Fire-and-forget -- errors are caught and swallowed by the service.
   * Plugins in the same topological wave execute concurrently via `Promise.allSettled`.
   *
   * @param event - The fully processed stored event with `id`, `status`, and `receivedAt`.
   */
  onEvent(event: StoredTrackerEvent): void | Promise<void>;

  /**
   * Called when the NestJS module is destroyed.
   *
   * Close database connections, flush buffers, and release resources.
   */
  onDestroy?(): void | Promise<void>;
}
