import type { StoredTrackerEvent, TrackerEventStatus } from '../../../common/types';
import type { DistinctField, ITrackerStorage, ITrackerStorageFilter } from '../ITrackerStorage';

/**
 * Volatile in-memory storage — no persistence across restarts.
 * Useful for development, testing, or short-lived services.
 */
export class InMemoryStorageAdapter implements ITrackerStorage {
  private readonly events: StoredTrackerEvent[] = [];

  async save(event: StoredTrackerEvent): Promise<void> {
    this.events.push(event);
  }

  async saveBatch(events: StoredTrackerEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async find(filters: ITrackerStorageFilter = {}): Promise<StoredTrackerEvent[]> {
    let results = [...this.events];

    // Exact-match filters preserve programmatic-caller semantics.
    if (filters.appId)       results = results.filter(e => e.appId       === filters.appId);
    if (filters.appIds && filters.appIds.length > 0) {
      const set = new Set(filters.appIds);
      results = results.filter(e => e.appId != null && set.has(e.appId));
    }
    if (filters.type)        results = results.filter(e => e.type        === filters.type);
    if (filters.types && filters.types.length > 0) {
      const typeSet = new Set(filters.types);
      results = results.filter(e => typeSet.has(e.type));
    }
    if (filters.status)      results = results.filter(e => e.status      === filters.status);
    if (filters.category)    results = results.filter(e => e.category    === filters.category);
    if (filters.categories && filters.categories.length > 0) {
      const cats = new Set(filters.categories);
      results = results.filter(e => e.category != null && cats.has(e.category));
    }
    if (filters.userId)      results = results.filter(e => e.context?.userId      === filters.userId);
    if (filters.environment) results = results.filter(e => e.context?.environment === filters.environment);
    // Substring filters mirror the SQL adapters' ILIKE behaviour.
    const includes = (h: string | undefined, n: string) =>
      !!h && h.toLowerCase().includes(n.toLowerCase());
    if (filters.appIdContains)       results = results.filter(e => includes(e.appId,                  filters.appIdContains!));
    if (filters.categoryContains)    results = results.filter(e => includes(e.category,               filters.categoryContains!));
    if (filters.userIdContains)      results = results.filter(e => includes(e.context?.userId,        filters.userIdContains!));
    if (filters.environmentContains) results = results.filter(e => includes(e.context?.environment,   filters.environmentContains!));
    if (filters.messageContains)     results = results.filter(e => includes(e.message,                filters.messageContains!));
    if (filters.from)        results = results.filter(e => e.receivedAt >= filters.from!);
    if (filters.to)          results = results.filter(e => e.receivedAt <= filters.to!);
    if (filters.tags?.length) {
      results = results.filter(e => filters.tags!.every(t => e.tags?.includes(t)));
    }

    results.sort((a, b) => b.receivedAt - a.receivedAt);

    const offset = filters.offset ?? 0;
    const limit  = filters.limit  ?? 100;
    return results.slice(offset, offset + limit);
  }

  async findById(id: string): Promise<StoredTrackerEvent | null> {
    return this.events.find(e => e.id === id) ?? null;
  }

  async updateStatus(id: string, status: TrackerEventStatus): Promise<void> {
    const event = this.events.find(e => e.id === id);
    if (event) event.status = status;
  }

  async delete(id: string): Promise<void> {
    const idx = this.events.findIndex(e => e.id === id);
    if (idx !== -1) this.events.splice(idx, 1);
  }

  /**
   * Delete events matching the filter, returning the number removed.
   * Without filters, clears the whole array. Uses the same exact-match
   * filter set the SQL adapters honour for `clear()`.
   */
  async clear(filters: ITrackerStorageFilter = {}): Promise<number> {
    const noFilter =
      !filters.appId && !filters.appIds?.length &&
      !filters.type && !filters.types?.length &&
      !filters.status &&
      !filters.category && !filters.categories?.length &&
      !filters.from && !filters.to &&
      !filters.userId && !filters.environment;

    if (noFilter) {
      const n = this.events.length;
      this.events.length = 0;
      return n;
    }

    const appIdSet = filters.appIds && filters.appIds.length > 0
      ? new Set(filters.appIds) : null;
    const categorySet = filters.categories && filters.categories.length > 0
      ? new Set(filters.categories) : null;
    const typeSet = filters.types && filters.types.length > 0
      ? new Set(filters.types) : null;
    let kept = 0;
    let removed = 0;
    for (const e of this.events) {
      const matches =
        (!filters.appId       || e.appId       === filters.appId)       &&
        (!appIdSet            || (e.appId != null && appIdSet.has(e.appId))) &&
        (!filters.type        || e.type        === filters.type)        &&
        (!typeSet             || typeSet.has(e.type))                    &&
        (!filters.status      || e.status      === filters.status)      &&
        (!filters.category    || e.category    === filters.category)    &&
        (!categorySet         || (e.category != null && categorySet.has(e.category))) &&
        (!filters.userId      || e.context?.userId      === filters.userId)      &&
        (!filters.environment || e.context?.environment === filters.environment) &&
        (filters.from === undefined || e.receivedAt >= filters.from)    &&
        (filters.to   === undefined || e.receivedAt <= filters.to);
      if (matches) {
        removed++;
      } else {
        this.events[kept++] = e;
      }
    }
    this.events.length = kept;
    return removed;
  }

  async distinct(
    field: DistinctField,
    opts?: { limit?: number; sinceMs?: number },
  ): Promise<Array<{ value: string; count: number }>> {
    const accessor: (e: StoredTrackerEvent) => string | undefined =
      field === 'environment' ? (e) => e.context?.environment : (e) => e[field as 'appId' | 'category' | 'type' | 'status'];
    const since = opts?.sinceMs ?? 0;
    const counts = new Map<string, number>();
    for (const e of this.events) {
      if (e.receivedAt < since) continue;
      const v = accessor(e);
      if (v == null || v === '') continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const rows = [...counts.entries()].map(([value, count]) => ({ value, count }));
    rows.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    const limit = Math.max(1, Math.min(opts?.limit ?? 500, 2000));
    return rows.slice(0, limit);
  }

  /** Return all stored events (useful for testing). */
  all(): StoredTrackerEvent[] {
    return [...this.events];
  }
}
