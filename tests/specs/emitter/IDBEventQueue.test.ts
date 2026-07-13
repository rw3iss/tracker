/**
 * @jest-environment jsdom
 */
import { IDBFactory } from 'fake-indexeddb';
import { IDBEventQueue } from '../../../src/emitter/IDBEventQueue';
import { resetTrackerDB } from '../../../src/emitter/idb-shared';
import type { TrackerEvent } from '../../../src/common/types';

function makeEvent(overrides: Partial<TrackerEvent> = {}): TrackerEvent {
  return { type: 'error', message: 'boom', timestamp: Date.now(), ...overrides };
}

beforeEach(() => {
  // Fresh fake IDB + fresh DB-promise cache for full isolation between tests
  (global as any).indexedDB = new IDBFactory();
  resetTrackerDB();
});

describe('IDBEventQueue', () => {
  it('push then getAll returns the events', async () => {
    const q = new IDBEventQueue();
    await q.push([makeEvent({ message: 'e1' }), makeEvent({ message: 'e2' })]);
    const items = await q.getAll();
    expect(items).toHaveLength(2);
    const messages = items.map((i) => i.event.message).sort();
    expect(messages).toEqual(['e1', 'e2']);
  });

  it('each item has a unique id', async () => {
    const q = new IDBEventQueue();
    await q.push([makeEvent(), makeEvent(), makeEvent()]);
    const items = await q.getAll();
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('getAll on empty store returns []', async () => {
    const q     = new IDBEventQueue();
    const items = await q.getAll();
    expect(items).toEqual([]);
  });

  it('removeByIds removes only the specified items', async () => {
    const q = new IDBEventQueue();
    await q.push([makeEvent({ message: 'keep' }), makeEvent({ message: 'remove' })]);
    const before = await q.getAll();
    const removeId = before.find((i) => i.event.message === 'remove')!.id;
    await q.removeByIds([removeId]);
    const after = await q.getAll();
    expect(after).toHaveLength(1);
    expect(after[0].event.message).toBe('keep');
  });

  it('removeByIds is a no-op for empty array', async () => {
    const q = new IDBEventQueue();
    await q.push([makeEvent()]);
    await expect(q.removeByIds([])).resolves.toBeUndefined();
    expect(await q.getAll()).toHaveLength(1);
  });

  it('clear removes all events', async () => {
    const q = new IDBEventQueue();
    await q.push([makeEvent(), makeEvent()]);
    await q.clear();
    expect(await q.getAll()).toEqual([]);
  });

  it('setMeta and getMeta round-trip arbitrary values', async () => {
    const q = new IDBEventQueue();
    await q.setMeta('endpoint', 'https://api.example.com/track');
    await q.setMeta('count', 42);
    expect(await q.getMeta('endpoint')).toBe('https://api.example.com/track');
    expect(await q.getMeta('count')).toBe(42);
  });

  it('getMeta returns undefined for missing key', async () => {
    const q = new IDBEventQueue();
    expect(await q.getMeta('missing')).toBeUndefined();
  });

  it('push is a no-op for empty array', async () => {
    const q = new IDBEventQueue();
    await expect(q.push([])).resolves.toBeUndefined();
    expect(await q.getAll()).toEqual([]);
  });

  it('items have a ts timestamp', async () => {
    const before = Date.now();
    const q      = new IDBEventQueue();
    await q.push([makeEvent()]);
    const [item] = await q.getAll();
    expect(item.ts).toBeGreaterThanOrEqual(before);
    expect(item.ts).toBeLessThanOrEqual(Date.now());
  });
});
