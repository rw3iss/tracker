import type { StoredTrackerEvent, TrackerEventStatus } from '../../../common/types';
import type { ITrackerStorage, ITrackerStorageFilter } from '../ITrackerStorage';

export type ConsoleStorageAdapterOptions = {
  /** Custom formatter. Defaults to a compact timestamped line. */
  format?: (event: StoredTrackerEvent) => string;
  /** Logger function. Defaults to console.log. */
  log?: (line: string) => void;
};

/**
 * Write-only adapter that prints every event to the console.
 * Query methods always return empty — there is no persistence.
 * Useful for development or as a secondary adapter alongside a real store.
 */
export class ConsoleStorageAdapter implements ITrackerStorage {
  private readonly format: (event: StoredTrackerEvent) => string;
  private readonly log:    (line: string) => void;

  constructor(options: ConsoleStorageAdapterOptions = {}) {
    this.format = options.format ?? defaultFormat;
    this.log    = options.log    ?? console.log;
  }

  async save(event: StoredTrackerEvent): Promise<void> {
    this.log(this.format(event));
  }

  async saveBatch(events: StoredTrackerEvent[]): Promise<void> {
    for (const e of events) await this.save(e);
  }

  async find(_filters?: ITrackerStorageFilter): Promise<StoredTrackerEvent[]> {
    return [];
  }

  async findById(_id: string): Promise<StoredTrackerEvent | null> {
    return null;
  }

  async updateStatus(_id: string, _status: TrackerEventStatus): Promise<void> {
    // no-op — console adapter has no persistent state
  }

  async delete(_id: string): Promise<void> {
    // no-op
  }

  async distinct(): Promise<Array<{ value: string; count: number }>> {
    // Console adapter has no persistent store, so there's nothing to
    // enumerate — return empty.
    return [];
  }

  async clear(): Promise<number> {
    // No persistent store to clear. -1 signals "indeterminate count"
    // so admin tooling can report "completed; n/a rows" rather than
    // implying nothing happened.
    return -1;
  }
}

function defaultFormat(event: StoredTrackerEvent): string {
  const ts  = new Date(event.receivedAt).toISOString();
  const app = event.appId ? `[${event.appId}] ` : '';
  const err = event.error ? ` — ${event.error.name}: ${event.error.message}` : '';
  return `[tracker] ${ts} ${app}${event.type.toUpperCase()} ${event.message}${err}`;
}
