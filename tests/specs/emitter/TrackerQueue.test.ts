/**
 * @jest-environment jsdom
 */
import { TrackerQueue } from '../../../src/emitter/TrackerQueue';
import type { TrackerEvent } from '../../../src/common/types';

const evt = (msg: string): TrackerEvent => ({ type: 'error', message: msg, timestamp: 1 });

const KEY = '__vt_test__';

describe('TrackerQueue', () => {
  beforeEach(() => localStorage.clear());

  it('enqueues events and reports size', () => {
    const q = new TrackerQueue({ maxSize: 10, storageKey: KEY });
    q.enqueue(evt('a'));
    q.enqueue(evt('b'));
    expect(q.size()).toBe(2);
  });

  it('snapshot() returns a copy — does not modify queue', () => {
    const q = new TrackerQueue({ maxSize: 10, storageKey: KEY });
    q.enqueue(evt('a'));
    const snap = q.snapshot();
    expect(snap).toHaveLength(1);
    expect(q.size()).toBe(1); // unchanged
  });

  it('confirm() removes acknowledged events from memory', () => {
    const q = new TrackerQueue({ maxSize: 10, storageKey: KEY });
    q.enqueue(evt('a'));
    q.enqueue(evt('b'));
    const snap = q.snapshot();
    q.confirm(snap);
    expect(q.size()).toBe(0);
  });

  it('drops oldest event when maxSize exceeded', () => {
    const q = new TrackerQueue({ maxSize: 2, storageKey: KEY });
    q.enqueue(evt('a'));
    q.enqueue(evt('b'));
    q.enqueue(evt('c'));
    expect(q.size()).toBe(2);
    expect(q.snapshot()[0].message).toBe('b');
    expect(q.snapshot()[1].message).toBe('c');
  });

  it('persistFallback() writes batch to localStorage', () => {
    const q = new TrackerQueue({ maxSize: 10, storageKey: KEY });
    q.enqueue(evt('a'));
    const batch = q.snapshot();
    q.persistFallback(batch);
    const raw = localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    const parsed: TrackerEvent[] = JSON.parse(raw!);
    expect(parsed[0].message).toBe('a');
  });

  it('persistFallback() appends to existing storage', () => {
    const q = new TrackerQueue({ maxSize: 10, storageKey: KEY });
    q.enqueue(evt('a'));
    q.persistFallback(q.snapshot());
    q.enqueue(evt('b'));
    q.persistFallback(q.snapshot());
    const parsed: TrackerEvent[] = JSON.parse(localStorage.getItem(KEY)!);
    expect(parsed).toHaveLength(2);
  });

  it('drainStorage() loads persisted events and clears localStorage', () => {
    localStorage.setItem(KEY, JSON.stringify([evt('persisted')]));
    const q = new TrackerQueue({ maxSize: 10, storageKey: KEY });
    q.drainStorage();
    expect(q.size()).toBe(1);
    expect(q.snapshot()[0].message).toBe('persisted');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('drainStorage() is a no-op when localStorage is empty', () => {
    const q = new TrackerQueue({ maxSize: 10, storageKey: KEY });
    q.drainStorage();
    expect(q.size()).toBe(0);
  });
});
