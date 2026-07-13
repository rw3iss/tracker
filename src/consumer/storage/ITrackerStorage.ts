import type { EventType, StoredTrackerEvent, TrackerEventStatus } from '../../common/types';

/**
 * Query filter options for retrieving stored tracker events.
 *
 * All fields are optional. When multiple fields are specified, they are
 * combined with AND semantics. Unset fields match all events.
 *
 * @see {@link ITrackerStorage.find}
 * @see `TrackerService.query()`
 */
export interface ITrackerStorageFilter {
  /** Filter by application identifier (exact match). */
  appId?:       string;
  /**
   * Filter to events whose appId is in this list (exact match, OR'd).
   * Used by the dashboard's multi-select app picker — `appIdContains` is
   * substring search and doesn't compose with multi-select.
   */
  appIds?:      string[];
  /**
   * Filter where appId contains the given substring (case-insensitive).
   * Used by the dashboard's loose search; programmatic callers that need
   * an exact match should use {@link appId}.
   */
  appIdContains?: string;
  /** Filter by event type (error, warning, info, debug, event). */
  type?:        EventType;
  /**
   * Filter to events whose type is in this list (exact match, OR'd).
   * Used by the dashboard's type multi-select picker.
   */
  types?:       EventType[];
  /** Filter by lifecycle status. */
  status?:      TrackerEventStatus;
  /** Filter by user ID (matches `context.userId` exactly). */
  userId?:      string;
  /** Filter where `context.userId` contains the given substring (case-insensitive). */
  userIdContains?: string;
  /** Filter by deployment environment (matches `context.environment` exactly). */
  environment?: string;
  /** Filter where `context.environment` contains the given substring (case-insensitive). */
  environmentContains?: string;
  /**
   * Filter where `message` contains the given substring (case-insensitive).
   * Used by the dashboard's free-text search box.
   *
   * The query runs as `message ILIKE '%term%'`. Backed by a `pg_trgm` GIN
   * index when the extension is available (created by
   * {@link ensureTrackerTable}); falls back to a sequential scan on the
   * filtered subset otherwise.
   */
  messageContains?: string;
  /** Filter by event category (exact match). */
  category?:    string;
  /**
   * Filter to events whose category is in this list (exact match,
   * OR'd). Used by the dashboard's category multi-select picker.
   */
  categories?:  string[];
  /** Filter where category contains the given substring (case-insensitive). */
  categoryContains?: string;
  /** Start of time range filter (Unix ms, inclusive). Matches against `receivedAt`. */
  from?:        number;
  /** End of time range filter (Unix ms, inclusive). Matches against `receivedAt`. */
  to?:          number;
  /** Filter events that include ALL of these tags. */
  tags?:        string[];
  /**
   * Maximum number of events to return.
   * @defaultValue `100`
   */
  limit?:       number;
  /**
   * Number of events to skip (for pagination).
   * @defaultValue `0`
   */
  offset?:      number;
  /**
   * Column to sort results by.
   * Allowed values: `'id'`, `'type'`, `'message'`, `'appId'`, `'category'`, `'status'`, `'timestamp'`, `'receivedAt'`.
   * @defaultValue `'receivedAt'`
   */
  sortBy?:      string;
  /**
   * Sort direction.
   * @defaultValue `'desc'`
   */
  sortDir?:     'asc' | 'desc';
  /**
   * Key-value pairs to match against the event's `payload` JSONB field.
   * Uses PostgreSQL `@>` containment operator for GIN index efficiency.
   *
   * @example
   * ```typescript
   * { payloadFilters: { orderId: '123', status: 'failed' } }
   * ```
   */
  payloadFilters?: Record<string, string>;
}

/**
 * Storage adapter interface for persisting and querying tracker events.
 *
 * Implement this interface to create custom storage backends (e.g. PostgreSQL,
 * MongoDB, DynamoDB, in-memory). The adapter is registered with
 * `TrackerService` via a storage plugin's `onInit` hook.
 *
 * Built-in adapters:
 * - {@link DataSourceTrackerStorage} -- raw SQL via TypeORM DataSource (no entity registration)
 * - `TypeOrmTrackerStorage` -- TypeORM Repository-based
 * - `InMemoryTrackerStorage` -- for testing
 * - `ConsoleTrackerStorage` -- logs to stdout
 *
 * @see {@link EventStoragePlugin}
 * @see {@link ITrackerStorageFilter}
 */
export interface ITrackerStorage {
  /**
   * Persist a single fully-formed stored event.
   *
   * The event's `id`, `status`, and `receivedAt` are already set by
   * `TrackerService` before this method is called.
   *
   * @param event - The stored event to persist.
   */
  save(event: StoredTrackerEvent): Promise<void>;

  /**
   * Persist multiple events in a batch.
   *
   * @param events - Array of stored events to persist.
   */
  saveBatch(events: StoredTrackerEvent[]): Promise<void>;

  /**
   * Query stored events with optional filters.
   *
   * @param filters - Optional query filters (type, status, date range, pagination, etc.).
   * @returns Array of matching stored events.
   */
  find(filters?: ITrackerStorageFilter): Promise<StoredTrackerEvent[]>;

  /**
   * Find a single event by its UUID.
   *
   * @param id - The event UUID.
   * @returns The stored event, or `null` if not found.
   */
  findById(id: string): Promise<StoredTrackerEvent | null>;

  /**
   * Update an event's lifecycle status.
   *
   * @param id - The event UUID.
   * @param status - The new {@link TrackerEventStatus} to set.
   */
  updateStatus(id: string, status: TrackerEventStatus): Promise<void>;

  /**
   * Delete an event by its UUID.
   *
   * @param id - The event UUID to delete.
   */
  delete(id: string): Promise<void>;

  /**
   * Delete events. With no filter, drops every row in the events table —
   * exposed so admin tooling (CLI, dashboard "wipe" button) can run a
   * full reset against a single shared code path.
   *
   * The filter has the same shape as {@link find}, so callers can
   * narrow to "every error from app X older than 30 days" and so on.
   * Adapters MAY ignore filter fields they don't support (e.g. payload
   * containment) — they should treat unknowns as "no constraint" and
   * delete the matching superset.
   *
   * @returns The number of rows deleted, or `-1` when the adapter
   *          can't compute it cheaply (SQS, console).
   */
  clear(filters?: ITrackerStorageFilter): Promise<number>;

  /**
   * Return distinct values for a column, with their event counts. Powers
   * dashboard widgets like the App-ID multi-select picker.
   *
   * @param field - Top-level column name. Allow-listed by the caller —
   *                adapters trust whatever they're given here.
   * @param opts.limit   - Cap on the number of values returned (default 500).
   * @param opts.sinceMs - If set, only consider events with
   *                       `receivedAt >= sinceMs` (useful for "active in
   *                       the last 30 days").
   * @returns Array of `{ value, count }` ordered by count descending.
   */
  distinct(
    field:  DistinctField,
    opts?:  { limit?: number; sinceMs?: number },
  ): Promise<Array<{ value: string; count: number }>>;
}

/** Columns the storage layer is willing to return distinct values for. */
export type DistinctField =
  | 'appId'
  | 'category'
  | 'type'
  | 'status'
  | 'environment';

export const DISTINCT_FIELDS: DistinctField[] = ['appId', 'category', 'type', 'status', 'environment'];
