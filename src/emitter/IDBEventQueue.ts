import type { TrackerEvent } from '../common/types';
import { openTrackerDB } from './idb-shared';

let _seq = 0;

function generateId(): string {
  return `${Date.now().toString(36)}-${(++_seq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface QueuedItem {
  id:    string;
  event: TrackerEvent;
  ts:    number;
}

function tx<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const t   = db.transaction(store, mode);
    let result: T | undefined;
    t.oncomplete = () => resolve(result);
    t.onerror    = () => reject(t.error);
    const req = fn(t.objectStore(store));
    if (req) {
      req.onsuccess = () => { result = req.result as T; };
      req.onerror   = () => reject(req.error);
    }
  });
}

export class IDBEventQueue {
  async push(events: TrackerEvent[]): Promise<void> {
    if (events.length === 0) return;
    const db = await openTrackerDB();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('events', 'readwrite');
      t.oncomplete = () => resolve();
      t.onerror    = () => reject(t.error);
      const store = t.objectStore('events');
      for (const event of events) {
        store.put({ id: generateId(), event, ts: Date.now() } satisfies QueuedItem);
      }
    });
  }

  async getAll(): Promise<QueuedItem[]> {
    const db = await openTrackerDB();
    return (await tx<QueuedItem[]>(db, 'events', 'readonly', (s) => s.getAll())) ?? [];
  }

  async removeByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await openTrackerDB();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('events', 'readwrite');
      t.oncomplete = () => resolve();
      t.onerror    = () => reject(t.error);
      const store = t.objectStore('events');
      for (const id of ids) store.delete(id);
    });
  }

  async clear(): Promise<void> {
    const db = await openTrackerDB();
    await tx(db, 'events', 'readwrite', (s) => s.clear());
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const db = await openTrackerDB();
    await tx(db, 'meta', 'readwrite', (s) => s.put(value, key));
  }

  async getMeta(key: string): Promise<unknown> {
    const db = await openTrackerDB();
    return tx<unknown>(db, 'meta', 'readonly', (s) => s.get(key));
  }
}
