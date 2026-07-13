/**
 * Coverage for the dashboard's app-picker plumbing — `distinct()` returns
 * unique values + counts for an allow-listed column, and the `appIds`
 * filter narrows queries to a list of exact matches.
 */

import { InMemoryStorageAdapter } from '../../../../src/consumer/storage/adapters/InMemoryStorageAdapter';
import { TrackerEventStatus, type StoredTrackerEvent } from '../../../../src/common/types';

function ev(over: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent {
  return {
    id: Math.random().toString(36).slice(2),
    type: 'info',
    message: 'm',
    status: TrackerEventStatus.New,
    timestamp: Date.now(),
    receivedAt: Date.now(),
    ...over,
  };
}

describe('InMemoryStorageAdapter — distinct() + appIds filter', () => {
  it('distinct(appId) returns values sorted by count desc, ties alphabetical', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ appId: 'auth' }),
      ev({ appId: 'auth' }),
      ev({ appId: 'auth' }),
      ev({ appId: 'web' }),
      ev({ appId: 'api' }),
      ev({ appId: 'api' }),
    ]);
    const rows = await s.distinct('appId');
    expect(rows).toEqual([
      { value: 'auth', count: 3 },
      { value: 'api',  count: 2 },
      { value: 'web',  count: 1 },
    ]);
  });

  it('distinct() skips null + empty values', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ appId: 'a' }),
      ev({ appId: undefined }),
      ev({ appId: '' }),
      ev({ appId: 'b' }),
    ]);
    const rows = await s.distinct('appId');
    expect(rows.map((r) => r.value)).toEqual(['a', 'b']);
  });

  it('distinct() honors limit', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ appId: 'a' }),
      ev({ appId: 'b' }),
      ev({ appId: 'c' }),
    ]);
    const rows = await s.distinct('appId', { limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it('distinct() filters by sinceMs', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ appId: 'old',    receivedAt: 1_000 }),
      ev({ appId: 'recent', receivedAt: 9_000 }),
    ]);
    const rows = await s.distinct('appId', { sinceMs: 5_000 });
    expect(rows.map((r) => r.value)).toEqual(['recent']);
  });

  it('distinct(environment) reads from context', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ context: { environment: 'production' } }),
      ev({ context: { environment: 'production' } }),
      ev({ context: { environment: 'staging' } }),
    ]);
    const rows = await s.distinct('environment');
    expect(rows).toEqual([
      { value: 'production', count: 2 },
      { value: 'staging',    count: 1 },
    ]);
  });

  it('appIds filter narrows results to the listed ids (OR-matched)', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ appId: 'auth' }),
      ev({ appId: 'web' }),
      ev({ appId: 'api' }),
      ev({ appId: 'mobile' }),
    ]);
    const found = await s.find({ appIds: ['auth', 'api'] });
    expect(found.map((e) => e.appId).sort()).toEqual(['api', 'auth']);
  });

  it('empty appIds array is treated as "no filter"', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([ev({ appId: 'a' }), ev({ appId: 'b' })]);
    const found = await s.find({ appIds: [] });
    expect(found).toHaveLength(2);
  });

  it('categories filter narrows results to the listed categories (OR-matched)', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ category: 'auction:bid' }),
      ev({ category: 'payment:charge' }),
      ev({ category: 'payment:refund' }),
      ev({ category: 'shipping:label' }),
    ]);
    const found = await s.find({ categories: ['payment:charge', 'auction:bid'] });
    expect(found.map((e) => e.category).sort()).toEqual(['auction:bid', 'payment:charge']);
  });

  it('empty categories array is treated as "no filter"', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([ev({ category: 'a' }), ev({ category: 'b' })]);
    const found = await s.find({ categories: [] });
    expect(found).toHaveLength(2);
  });

  it('types filter narrows results to the listed types (OR-matched)', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ type: 'error' }),
      ev({ type: 'warning' }),
      ev({ type: 'info' }),
      ev({ type: 'debug' }),
      ev({ type: 'event' }),
    ]);
    const found = await s.find({ types: ['error', 'warning'] });
    expect(found.map((e) => e.type).sort()).toEqual(['error', 'warning']);
  });

  it('empty types array is treated as "no filter"', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([ev({ type: 'error' }), ev({ type: 'info' })]);
    const found = await s.find({ types: [] });
    expect(found).toHaveLength(2);
  });
});
