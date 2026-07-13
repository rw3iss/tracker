import { EntitySchema } from 'typeorm';
import { TrackerEventStatus } from '../../../common/types';
import type { SerializedError, TrackerContext } from '../../../common/types';

/** Default table name — overridable via `TRACKER_TABLE_NAME` env var. */
export const TRACKER_DEFAULT_TABLE = 'tracker_events';

/**
 * Reads the table name from the environment at import time.
 * Set `TRACKER_TABLE_NAME` before importing this module to customize.
 * TrackerModule.register({ tableName }) sets this automatically.
 */
export const TRACKER_TABLE_NAME = process.env.TRACKER_TABLE_NAME || TRACKER_DEFAULT_TABLE;

/**
 * TypeORM entity interface for tracker events.
 */
export interface TrackerEventRow {
  id:         string;
  type:       string;
  message:    string;
  appId:      string | null;
  category:   string | null;
  status:     TrackerEventStatus;
  payload:    Record<string, unknown> | null;
  error:      SerializedError | null;
  context:    TrackerContext | null;
  tags:       string[];
  timestamp:  number;
  receivedAt: number;
}

/**
 * TypeORM EntitySchema for tracker events.
 *
 * Uses EntitySchema instead of decorators because decorator metadata is
 * stripped by esbuild/tsup bundling. EntitySchema works with any bundler.
 */
export const TrackerEventEntity = new EntitySchema<TrackerEventRow>({
  name: 'TrackerEventEntity',
  tableName: TRACKER_TABLE_NAME,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    type: {
      type: 'varchar',
    },
    message: {
      type: 'text',
    },
    appId: {
      type: 'varchar',
      nullable: true,
    },
    category: {
      type: 'varchar',
      nullable: true,
    },
    status: {
      type: 'varchar',
      default: TrackerEventStatus.New,
    },
    payload: {
      type: 'jsonb',
      nullable: true,
    },
    error: {
      type: 'jsonb',
      nullable: true,
    },
    context: {
      type: 'jsonb',
      nullable: true,
    },
    tags: {
      type: 'simple-array',
      nullable: true,
    },
    timestamp: {
      type: 'bigint',
      transformer: { to: (v: number) => v, from: (v: string) => Number(v) },
    },
    receivedAt: {
      type: 'bigint',
      transformer: { to: (v: number) => v, from: (v: string) => Number(v) },
    },
  },
  indices: [
    { columns: ['type'] },
    { columns: ['appId'] },
    { columns: ['category'] },
    { columns: ['status'] },
    { columns: ['receivedAt'] },
    // Composite index for the primary dashboard query pattern
    { columns: ['appId', 'type', 'receivedAt'] },
    // Note: GIN indexes on payload/context JSONB and expression indexes on
    // context fields are created by ensureTrackerTable() but can't be
    // expressed in EntitySchema. If using TypeORM migrations, add them manually.
  ],
});
