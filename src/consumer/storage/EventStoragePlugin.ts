import type { DataSource } from 'typeorm';
import type { StoredTrackerEvent } from '../../common/types';
import type { ITrackerPlugin, ITrackerServiceRef } from '../ITrackerPlugin';
import type { ITrackerStorage } from './ITrackerStorage';
import { DataSourceTrackerStorage } from './adapters/DataSourceTrackerStorage';
import { ensureTrackerTable } from './ensureTrackerTable';

/**
 * Plugin that persists every tracker event to a storage adapter.
 *
 * This is the primary storage plugin for the tracker server. It registers
 * a storage adapter with `TrackerService` (enabling query and status
 * update endpoints) and persists every event via its `onEvent` hook.
 *
 * Two ways to create:
 *
 * ```typescript
 * // Simple -- pass a DataSource, the plugin handles everything:
 * const plugin = await EventStoragePlugin.fromDataSource(ds);
 *
 * // Advanced -- bring your own storage adapter:
 * const plugin = EventStoragePlugin.create(new TypeOrmTrackerStorage(repo));
 * ```
 *
 * @see {@link ITrackerStorage}
 * @see {@link DataSourceTrackerStorage}
 * @see `TrackerModuleOptions.plugins`
 */
export class EventStoragePlugin implements ITrackerPlugin {
  readonly name = 'EventStoragePlugin';

  private constructor(private readonly adapter: ITrackerStorage) {}

  /**
   * Create an EventStoragePlugin with a custom storage adapter.
   *
   * @param adapter - The storage adapter to use for persisting and querying events.
   * @returns A new EventStoragePlugin instance.
   *
   * @example
   * ```typescript
   * const plugin = EventStoragePlugin.create(new InMemoryTrackerStorage());
   * ```
   */
  static create(adapter: ITrackerStorage): EventStoragePlugin {
    return new EventStoragePlugin(adapter);
  }

  /**
   * Create an EventStoragePlugin from a TypeORM DataSource with zero configuration.
   *
   * Automatically creates the tracker table (with indexes) if it does not exist,
   * then wraps the DataSource in a {@link DataSourceTrackerStorage} adapter that
   * uses raw SQL queries -- no entity registration needed in the consumer's
   * DataSource entities array.
   *
   * @param ds - An initialized TypeORM DataSource.
   * @param tableName - Optional custom table name.
   * @defaultValue tableName is `'tracker_events'` or `process.env.TRACKER_TABLE_NAME`.
   * @returns A Promise resolving to the configured EventStoragePlugin.
   *
   * @example
   * ```typescript
   * const plugin = await EventStoragePlugin.fromDataSource(dataSource);
   * TrackerModule.register({ plugins: [plugin] });
   * ```
   */
  static async fromDataSource(ds: DataSource, tableName?: string): Promise<EventStoragePlugin> {
    await ensureTrackerTable(ds, tableName);
    return new EventStoragePlugin(new DataSourceTrackerStorage(ds, tableName));
  }

  /**
   * Register the storage adapter with the tracker service.
   *
   * @param service - The tracker service reference for storage registration.
   */
  onInit(service: ITrackerServiceRef): void {
    service.setStorage(this.adapter);
  }

  /**
   * Persist a stored event to the storage adapter.
   *
   * @param event - The fully processed event to persist.
   */
  async onEvent(event: StoredTrackerEvent): Promise<void> {
    await this.adapter.save(event);
  }
}
