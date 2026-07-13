export { EventStoragePlugin } from './EventStoragePlugin';
export type { ITrackerStorage, ITrackerStorageFilter } from './ITrackerStorage';
export { ensureTrackerTable } from './ensureTrackerTable';

// Convenience query wrapper — dashboards, troubleshooting, health snapshots.
export { TrackerQueryHelpers } from './TrackerQueryHelpers';
export type {
    RecentOpts,
    AggregateOpts,
    TopNOpts,
    TimelineOpts,
    TopEntry,
    HealthSnapshot,
} from './TrackerQueryHelpers';

// Analytics-specific query helpers — DAU/MAU, top pages, funnels, cohorts.
export { AnalyticsQueryHelpers } from './AnalyticsQueryHelpers';
export type { AnalyticsWindowOpts } from './AnalyticsQueryHelpers';

// Adapters
export { DataSourceTrackerStorage } from './adapters/DataSourceTrackerStorage';
export { TypeOrmTrackerStorage } from './adapters/TypeOrmTrackerStorage';
export { QueuedStoragePlugin } from './adapters/QueuedStoragePlugin';
export type { QueuedStorageConfig } from './adapters/QueuedStoragePlugin';
export { RedisIngestConsumer } from './adapters/RedisIngestConsumer';
export type { RedisIngestConsumerConfig } from './adapters/RedisIngestConsumer';
export { TrackerEventEntity, TRACKER_TABLE_NAME, TRACKER_DEFAULT_TABLE } from './adapters/TrackerEventEntity';
export type { TrackerEventRow } from './adapters/TrackerEventEntity';
export { InMemoryStorageAdapter } from './adapters/InMemoryStorageAdapter';
export { ConsoleStorageAdapter } from './adapters/ConsoleStorageAdapter';
export type { ConsoleStorageAdapterOptions } from './adapters/ConsoleStorageAdapter';
export { SqsStorageAdapter } from './adapters/SqsStorageAdapter';
export type { SqsStorageAdapterConfig, ISqsClient } from './adapters/SqsStorageAdapter';
