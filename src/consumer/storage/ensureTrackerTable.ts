import type { DataSource } from 'typeorm';
import { TRACKER_DEFAULT_TABLE } from './adapters/TrackerEventEntity';

/**
 * Create the tracker events table if it doesn't exist.
 *
 * If TimescaleDB is available, the table is converted to a hypertable
 * partitioned by `receivedAt` for efficient time-range queries and
 * automatic chunk management.
 *
 * Creates optimized indexes for common query patterns:
 * - B-tree: individual columns (type, appId, category, status, receivedAt)
 * - B-tree composite: (appId, type, receivedAt DESC) — the primary dashboard query
 * - GIN: payload and context JSONB — enables fast `->>'key'` lookups
 * - B-tree expression: context.userId, context.environment, context.sessionId
 *
 * @param dataSource - An initialized TypeORM DataSource.
 * @param tableName - Custom table name (default: `process.env.TRACKER_TABLE_NAME` or `'tracker_events'`).
 *
 * @example
 * ```typescript
 * await ensureTrackerTable(dataSource);
 * await ensureTrackerTable(dataSource, 'my_events');
 * ```
 */
export async function ensureTrackerTable(
  dataSource: DataSource,
  tableName: string = process.env.TRACKER_TABLE_NAME || TRACKER_DEFAULT_TABLE,
): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const exists = await qr.hasTable(tableName);
    if (exists) {
      // Existing-deployment upgrade path: ensure indexes that were added
      // after the initial table-create migration exist on already-created
      // tables. Each step is idempotent and gated by IF NOT EXISTS.
      await ensureMessageSearchIndex(qr, tableName);
      return;
    }

    // Check if TimescaleDB is available
    let hasTimescale = false;
    try {
      const result = await qr.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'`
      );
      hasTimescale = result.length > 0;
    } catch {
      // extension check failed — assume not available
    }

    // TimescaleDB requires the partitioning column (receivedAt) to be part of
    // any UNIQUE/PRIMARY KEY constraint. Use a composite PK when TimescaleDB
    // is available, simple UUID PK otherwise.
    const pkConstraint = hasTimescale
      ? `CONSTRAINT "PK_${tableName}_id" PRIMARY KEY ("id", "receivedAt")`
      : `CONSTRAINT "PK_${tableName}_id" PRIMARY KEY ("id")`;

    await qr.query(`
      CREATE TABLE "${tableName}" (
        "id"         uuid NOT NULL DEFAULT uuid_generate_v4(),
        "type"       character varying NOT NULL,
        "message"    text NOT NULL,
        "appId"      character varying,
        "category"   character varying,
        "status"     character varying NOT NULL DEFAULT 'new',
        "payload"    jsonb,
        "error"      jsonb,
        "context"    jsonb,
        "tags"       text,
        "timestamp"  bigint NOT NULL,
        "receivedAt" bigint NOT NULL,
        ${pkConstraint}
      )
    `);

    // Convert to hypertable if TimescaleDB is available
    if (hasTimescale) {
      await qr.query(
        `SELECT create_hypertable('${tableName}', 'receivedAt',
          chunk_time_interval => 86400000,
          migrate_data => true
        )`
      );
      // chunk_time_interval = 86400000ms = 1 day
      // Each chunk covers one day of events for efficient time-range queries

      // Enable compression on chunks older than 7 days (90%+ storage reduction)
      try {
        await qr.query(`ALTER TABLE "${tableName}" SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = 'appId,type',
          timescaledb.compress_orderby = 'receivedAt DESC'
        )`);
        await qr.query(
          `SELECT add_compression_policy('${tableName}', INTERVAL '7 days')`
        );
      } catch {
        // compression policy may already exist or not be supported
      }
    }

    // ── B-tree indexes on individual columns ────────────────────────────
    await qr.query(`CREATE INDEX "IDX_${tableName}_type"       ON "${tableName}" ("type")`);
    await qr.query(`CREATE INDEX "IDX_${tableName}_appId"      ON "${tableName}" ("appId")`);
    await qr.query(`CREATE INDEX "IDX_${tableName}_category"   ON "${tableName}" ("category")`);
    await qr.query(`CREATE INDEX "IDX_${tableName}_status"     ON "${tableName}" ("status")`);
    await qr.query(`CREATE INDEX "IDX_${tableName}_receivedAt" ON "${tableName}" ("receivedAt" DESC)`);

    // ── Composite index for the primary dashboard query ─────────────────
    await qr.query(`CREATE INDEX "IDX_${tableName}_app_type_time" ON "${tableName}" ("appId", "type", "receivedAt" DESC)`);

    // ── GIN indexes on JSONB columns ────────────────────────────────────
    await qr.query(`CREATE INDEX "IDX_${tableName}_payload_gin"  ON "${tableName}" USING GIN ("payload" jsonb_path_ops)`);
    await qr.query(`CREATE INDEX "IDX_${tableName}_context_gin"  ON "${tableName}" USING GIN ("context" jsonb_path_ops)`);

    // ── Expression indexes for common context lookups ───────────────────
    await qr.query(`CREATE INDEX "IDX_${tableName}_ctx_userId"   ON "${tableName}" (("context"->>'userId'))`);
    await qr.query(`CREATE INDEX "IDX_${tableName}_ctx_env"      ON "${tableName}" (("context"->>'environment'))`);
    await qr.query(`CREATE INDEX "IDX_${tableName}_ctx_session"  ON "${tableName}" (("context"->>'sessionId'))`);

    // ── Full-text index on tags ─────────────────────────────────────────
    await qr.query(`CREATE INDEX "IDX_${tableName}_tags"         ON "${tableName}" USING GIN (to_tsvector('simple', COALESCE("tags", '')))`);

    // ── Trigram index for message ILIKE search (dashboard free-text) ────
    await ensureMessageSearchIndex(qr, tableName);

  } finally {
    await qr.release();
  }
}

/**
 * Trigram GIN index on `message` so the dashboard's free-text search
 * (`messageContains` → `message ILIKE '%term%'`) can use an index instead
 * of sequential-scanning the table.
 *
 * Safe to call repeatedly:
 *   - `CREATE EXTENSION IF NOT EXISTS pg_trgm` is idempotent.
 *   - The index is created with `IF NOT EXISTS`.
 *   - Both are wrapped — if the deployment doesn't grant CREATE EXTENSION
 *     privilege (some managed Postgres setups), ILIKE still works, just
 *     without index acceleration.
 *
 * Trigram indexes accelerate `ILIKE '%substr%'` patterns where prefix /
 * suffix btree indexes can't help, at the cost of ~5–15% extra disk per
 * indexed text column. Worth it for human search.
 */
async function ensureMessageSearchIndex(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- typeorm's QueryRunner type isn't worth importing at the type layer for one call
  qr: any,
  tableName: string,
): Promise<void> {
  try {
    await qr.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await qr.query(
      `CREATE INDEX IF NOT EXISTS "IDX_${tableName}_message_trgm" ` +
      `ON "${tableName}" USING GIN ("message" gin_trgm_ops)`
    );
  } catch {
    // Permission denied (managed PG without pg_trgm) — silently fall back
    // to sequential scan. The feature still works; it's just slower.
  }
}
