/**
 * Coverage for the dashboard / CLI clear-events plumbing —
 * `clear(filters)` deletes events that match the filter (or every row
 * when no filter is passed) and returns the deletion count.
 */

import { InMemoryStorageAdapter } from '../../../../src/consumer/storage/adapters/InMemoryStorageAdapter';
import { TrackerEventStatus, type StoredTrackerEvent } from '../../../../src/common/types';

const ev = (over: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent => ({
  id: Math.random().toString(36).slice(2),
  type: 'info',
  message: 'm',
  status: TrackerEventStatus.New,
  timestamp: Date.now(),
  receivedAt: Date.now(),
  ...over,
});

describe('InMemoryStorageAdapter — clear()', () => {
  it('with no filter, drops every row and returns the count', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([ev(), ev(), ev()]);
    const removed = await s.clear();
    expect(removed).toBe(3);
    expect(s.all()).toHaveLength(0);
  });

  it('clears just the matching rows when a filter is given', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ appId: 'a', type: 'error' }),
      ev({ appId: 'a', type: 'info' }),
      ev({ appId: 'b', type: 'error' }),
    ]);
    const removed = await s.clear({ appId: 'a' });
    expect(removed).toBe(2);
    const left = s.all();
    expect(left).toHaveLength(1);
    expect(left[0].appId).toBe('b');
  });

  it('combines multiple filter fields with AND semantics', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ appId: 'a', type: 'error' }),
      ev({ appId: 'a', type: 'info' }),
      ev({ appId: 'b', type: 'error' }),
    ]);
    const removed = await s.clear({ appId: 'a', type: 'error' });
    expect(removed).toBe(1);
    expect(s.all()).toHaveLength(2);
  });

  it('appIds list filter drops every event with a listed appId', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ appId: 'auth' }),
      ev({ appId: 'web' }),
      ev({ appId: 'api' }),
      ev({ appId: 'mobile' }),
    ]);
    const removed = await s.clear({ appIds: ['auth', 'api'] });
    expect(removed).toBe(2);
    expect(s.all().map(e => e.appId).sort()).toEqual(['mobile', 'web']);
  });

  it('time range only deletes within [from, to]', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([
      ev({ id: 'old',    receivedAt: 1_000 }),
      ev({ id: 'mid',    receivedAt: 5_000 }),
      ev({ id: 'recent', receivedAt: 9_000 }),
    ]);
    const removed = await s.clear({ from: 4_000, to: 6_000 });
    expect(removed).toBe(1);
    expect(s.all().map(e => e.id).sort()).toEqual(['old', 'recent']);
  });

  it('non-matching filter is a no-op (returns 0, leaves events intact)', async () => {
    const s = new InMemoryStorageAdapter();
    await s.saveBatch([ev({ appId: 'a' }), ev({ appId: 'b' })]);
    const removed = await s.clear({ appId: 'nope' });
    expect(removed).toBe(0);
    expect(s.all()).toHaveLength(2);
  });
});
