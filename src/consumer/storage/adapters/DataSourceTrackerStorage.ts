import type { DataSource } from 'typeorm';
import type { StoredTrackerEvent, TrackerEventStatus } from '../../../common/types';
import type { DistinctField, ITrackerStorage, ITrackerStorageFilter } from '../ITrackerStorage';
import { TRACKER_DEFAULT_TABLE } from './TrackerEventEntity';

/**
 * Allow-list of column expressions that {@link DataSourceTrackerStorage.distinct}
 * will accept. Locked to the `DistinctField` type so the SQL is never
 * built from arbitrary user input. Identifiers are double-quoted so that
 * camel-cased columns like `appId` aren't lower-cased by Postgres.
 */
const DISTINCT_COLUMNS: Record<DistinctField, string> = {
    appId:       '"appId"',
    category:    '"category"',
    type:        '"type"',
    status:      '"status"',
    environment: `"context"->>'environment'`,
};

/**
 * Storage adapter that uses raw SQL via `DataSource.query()`.
 *
 * Unlike `TypeOrmTrackerStorage` (which needs a Repository and entity registration),
 * this adapter works with any TypeORM DataSource -- no entity metadata required.
 * This makes it ideal for zero-config setups where the consuming application
 * does not want to register tracker entities in its DataSource configuration.
 *
 * Used by {@link EventStoragePlugin.fromDataSource} for zero-config setup.
 *
 * @remarks
 * Supports PostgreSQL JSONB queries for payload filtering using the `@>` containment
 * operator, which leverages GIN `jsonb_path_ops` indexes for efficient lookups.
 *
 * @see {@link ITrackerStorage}
 * @see {@link EventStoragePlugin.fromDataSource}
 */
export class DataSourceTrackerStorage implements ITrackerStorage {
  private readonly table: string;

  /**
   * @param ds - An initialized TypeORM DataSource for raw SQL queries.
   * @param tableName - Optional custom table name. Falls back to
   *   `process.env.TRACKER_TABLE_NAME` or `'tracker_events'`.
   */
  constructor(
    private readonly ds: DataSource,
    tableName?: string,
  ) {
    this.table = tableName || process.env.TRACKER_TABLE_NAME || TRACKER_DEFAULT_TABLE;
  }

  /**
   * Persist a single stored event via raw SQL INSERT.
   *
   * @param event - The event to persist.
   */
  async save(event: StoredTrackerEvent): Promise<void> {
    await this.ds.query(
      `INSERT INTO "${this.table}" ("id", "type", "message", "appId", "category", "status", "payload", "error", "context", "tags", "timestamp", "receivedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        event.id,
        event.type,
        event.message,
        event.appId ?? null,
        event.category ?? null,
        event.status,
        event.payload ? JSON.stringify(event.payload) : null,
        event.error ? JSON.stringify(event.error) : null,
        event.context ? JSON.stringify(event.context) : null,
        event.tags?.join(',') || null,
        event.timestamp,
        event.receivedAt,
      ],
    );
  }

  /**
   * Persist multiple events sequentially.
   *
   * @param events - Array of events to persist.
   */
  async saveBatch(events: StoredTrackerEvent[]): Promise<void> {
    for (const event of events) {
      await this.save(event);
    }
  }

  /**
   * Query stored events with optional filters.
   *
   * Builds a parameterized SQL query from the provided filters.
   * Supports pagination, sorting, date range, and JSONB payload filtering.
   *
   * @param filters - Query filters. All fields are optional.
   * @returns Array of matching stored events.
   *
   * @see {@link ITrackerStorageFilter}
   */
  async find(filters: ITrackerStorageFilter = {}): Promise<StoredTrackerEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    // Exact-match scalar filters (preserve programmatic-caller semantics —
    // e.g. TrackerQueryHelpers app-scoping must not bleed across appIds).
    if (filters.appId)       { conditions.push(`"appId" = $${idx++}`);               params.push(filters.appId); }
    if (filters.appIds && filters.appIds.length > 0) {
      // ANY($n::text[]) lets us bind the whole list as a single parameter
      // without per-value placeholder interpolation.
      conditions.push(`"appId" = ANY($${idx++}::text[])`);
      params.push(filters.appIds);
    }
    if (filters.type)        { conditions.push(`"type" = $${idx++}`);                params.push(filters.type); }
    if (filters.types && filters.types.length > 0) {
      conditions.push(`"type" = ANY($${idx++}::text[])`);
      params.push(filters.types);
    }
    if (filters.status)      { conditions.push(`"status" = $${idx++}`);              params.push(filters.status); }
    if (filters.category)    { conditions.push(`"category" = $${idx++}`);            params.push(filters.category); }
    if (filters.categories && filters.categories.length > 0) {
      conditions.push(`"category" = ANY($${idx++}::text[])`);
      params.push(filters.categories);
    }
    if (filters.from)        { conditions.push(`"receivedAt" >= $${idx++}`);         params.push(filters.from); }
    if (filters.to)          { conditions.push(`"receivedAt" <= $${idx++}`);         params.push(filters.to); }
    if (filters.userId)      { conditions.push(`"context"->>'userId' = $${idx++}`);          params.push(filters.userId); }
    if (filters.environment) { conditions.push(`"context"->>'environment' = $${idx++}`);     params.push(filters.environment); }
    // Substring (ILIKE) filters used by the dashboard's loose search. The
    // helper escapes %, _, and \ so user input can't smuggle in wildcards.
    const like = (v: string) => `%${v.replace(/[\\%_]/g, m => '\\' + m)}%`;
    if (filters.appIdContains)       { conditions.push(`"appId" ILIKE $${idx++}`);           params.push(like(filters.appIdContains)); }
    if (filters.categoryContains)    { conditions.push(`"category" ILIKE $${idx++}`);        params.push(like(filters.categoryContains)); }
    if (filters.userIdContains)      { conditions.push(`"context"->>'userId' ILIKE $${idx++}`);      params.push(like(filters.userIdContains)); }
    if (filters.environmentContains) { conditions.push(`"context"->>'environment' ILIKE $${idx++}`); params.push(like(filters.environmentContains)); }
    if (filters.messageContains)     { conditions.push(`"message" ILIKE $${idx++}`);         params.push(like(filters.messageContains)); }
    if (filters.payloadFilters) {
      // Use @> containment operator to hit the GIN jsonb_path_ops index.
      // Each filter becomes: "payload" @> '{"key":"value"}'::jsonb
      for (const [key, value] of Object.entries(filters.payloadFilters)) {
        conditions.push(`"payload" @> $${idx++}::jsonb`);
        params.push(JSON.stringify({ [key]: value }));
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    // Validate sortBy against allowed columns
    const allowedSortColumns = ['id', 'type', 'message', 'appId', 'category', 'status', 'timestamp', 'receivedAt'];
    const sortBy = filters.sortBy && allowedSortColumns.includes(filters.sortBy) ? filters.sortBy : 'receivedAt';
    const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';

    const rows = await this.ds.query(
      `SELECT * FROM "${this.table}" ${where} ORDER BY "${sortBy}" ${sortDir} LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return rows.map((r: Record<string, unknown>) => this.toStored(r));
  }

  /**
   * Find a single event by UUID.
   *
   * @param id - The event UUID.
   * @returns The stored event, or `null` if not found.
   */
  async findById(id: string): Promise<StoredTrackerEvent | null> {
    const rows = await this.ds.query(
      `SELECT * FROM "${this.table}" WHERE "id" = $1 LIMIT 1`,
      [id],
    );
    return rows.length > 0 ? this.toStored(rows[0]) : null;
  }

  /**
   * Update an event's lifecycle status.
   *
   * @param id - The event UUID.
   * @param status - The new status value.
   */
  async updateStatus(id: string, status: TrackerEventStatus): Promise<void> {
    await this.ds.query(
      `UPDATE "${this.table}" SET "status" = $1 WHERE "id" = $2`,
      [status, id],
    );
  }

  /**
   * Delete an event by UUID.
   *
   * @param id - The event UUID to delete.
   */
  async delete(id: string): Promise<void> {
    await this.ds.query(
      `DELETE FROM "${this.table}" WHERE "id" = $1`,
      [id],
    );
  }

  /**
   * Delete events matching the filter. Without filters, runs a
   * `TRUNCATE` (fast, resets sequences); with filters, runs a `DELETE
   * WHERE …` so partial wipes are supported without touching adjacent
   * tables. Returns the row count when Postgres reports it, else 0.
   *
   * Only the scalar filter fields are honoured — the same set `find()`
   * supports for exact match (appId, type, status, category, userId,
   * environment) plus the from/to time range. Substring `*Contains`
   * filters are silently ignored to keep the SQL simple; if you need
   * to clear a substring set, do a `find()` first and delete by id.
   */
  async clear(filters: ITrackerStorageFilter = {}): Promise<number> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filters.appId)       { conditions.push(`"appId" = $${idx++}`);    params.push(filters.appId); }
    if (filters.appIds && filters.appIds.length > 0) {
      conditions.push(`"appId" = ANY($${idx++}::text[])`);
      params.push(filters.appIds);
    }
    if (filters.type)        { conditions.push(`"type" = $${idx++}`);     params.push(filters.type); }
    if (filters.types && filters.types.length > 0) {
      conditions.push(`"type" = ANY($${idx++}::text[])`);
      params.push(filters.types);
    }
    if (filters.status)      { conditions.push(`"status" = $${idx++}`);   params.push(filters.status); }
    if (filters.category)    { conditions.push(`"category" = $${idx++}`); params.push(filters.category); }
    if (filters.categories && filters.categories.length > 0) {
      conditions.push(`"category" = ANY($${idx++}::text[])`);
      params.push(filters.categories);
    }
    if (filters.from)        { conditions.push(`"receivedAt" >= $${idx++}`); params.push(filters.from); }
    if (filters.to)          { conditions.push(`"receivedAt" <= $${idx++}`); params.push(filters.to); }
    if (filters.userId)      { conditions.push(`"context"->>'userId' = $${idx++}`);      params.push(filters.userId); }
    if (filters.environment) { conditions.push(`"context"->>'environment' = $${idx++}`); params.push(filters.environment); }

    if (conditions.length === 0) {
      // Full wipe — TRUNCATE is much faster than DELETE for large tables
      // and resets autoincrement sequences. We can't get a row count
      // from TRUNCATE so return 0 — callers that care should COUNT(*)
      // before calling.
      await this.ds.query(`TRUNCATE TABLE "${this.table}"`);
      return 0;
    }

    const result = await this.ds.query(
      `DELETE FROM "${this.table}" WHERE ${conditions.join(' AND ')}`,
      params,
    );
    // pg's `query` returns either an array (SELECT) or a `[rows, count]`
    // tuple for DELETE/UPDATE. TypeORM's wrapper normalises to either an
    // empty array + a separate "affected" promise, depending on driver
    // version. Best-effort extract: the second element of a tuple, or 0.
    if (Array.isArray(result) && result.length === 2 && typeof result[1] === 'number') {
      return result[1];
    }
    return 0;
  }

  /**
   * Distinct values for a column with their event counts. Backed by
   * GROUP BY + ORDER BY count DESC. Empty / null values are skipped so
   * the dashboard doesn't get a blank row in the picker.
   */
  async distinct(
    field: DistinctField,
    opts?: { limit?: number; sinceMs?: number },
  ): Promise<Array<{ value: string; count: number }>> {
    const expr  = DISTINCT_COLUMNS[field];
    const limit = Math.max(1, Math.min(opts?.limit ?? 500, 2000));
    const params: unknown[] = [];
    let idx = 1;
    const whereParts: string[] = [`${expr} IS NOT NULL`, `${expr} <> ''`];
    if (opts?.sinceMs !== undefined) {
      whereParts.push(`"receivedAt" >= $${idx++}`);
      params.push(opts.sinceMs);
    }
    const where = `WHERE ${whereParts.join(' AND ')}`;

    const rows = await this.ds.query(
      `SELECT ${expr} AS value, COUNT(*)::int AS count
         FROM "${this.table}"
         ${where}
         GROUP BY ${expr}
         ORDER BY count DESC, value ASC
         LIMIT $${idx}`,
      [...params, limit],
    );
    return rows.map((r: { value: string; count: number | string }) => ({
      value: r.value,
      count: Number(r.count),
    }));
  }

  private toStored(r: Record<string, unknown>): StoredTrackerEvent {
    return {
      id:         r.id as string,
      type:       r.type as StoredTrackerEvent['type'],
      message:    r.message as string,
      appId:      (r.appId as string) ?? undefined,
      category:   (r.category as string) ?? undefined,
      status:     r.status as StoredTrackerEvent['status'],
      payload:    (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<string, unknown> | undefined,
      error:      (typeof r.error === 'string' ? JSON.parse(r.error) : r.error) as StoredTrackerEvent['error'],
      context:    (typeof r.context === 'string' ? JSON.parse(r.context) : r.context) as StoredTrackerEvent['context'],
      tags:       typeof r.tags === 'string' ? (r.tags as string).split(',').filter(Boolean) : [],
      timestamp:  Number(r.timestamp),
      receivedAt: Number(r.receivedAt),
    };
  }
}
