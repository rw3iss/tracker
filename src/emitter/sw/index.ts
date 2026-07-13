/// <reference lib="webworker" />
import { openTrackerDB, resetTrackerDB } from '../idb-shared';
import type { QueuedItem } from '../IDBEventQueue';

// SyncEvent is part of the Background Sync API — not yet in all TS lib defs.
interface SyncEvent extends ExtendableEvent {
  readonly tag:         string;
  readonly lastChance:  boolean;
}

export interface TrackerSWConfig {
  /** Background Sync tag to listen for. Default: `'__vt_sync__'` */
  syncTag?: string;
  /**
   * Fallback endpoint URL — used when the endpoint stored in IDB meta is absent.
   * Not needed when TrackerClient stores the endpoint via `IDBEventQueue.setMeta('endpoint', ...)`.
   */
  endpoint?: string;
}

/**
 * Install a Background Sync handler inside a Service Worker.
 *
 * Call this once from your SW entry file:
 * ```ts
 * // my-sw.ts
 * import { setupTrackerSync } from '@rw3iss/tracker/sw';
 * setupTrackerSync();
 * ```
 *
 * Or register the standalone SW (`tracker-sw.js`) that calls this automatically.
 */
export function setupTrackerSync(config: TrackerSWConfig = {}): void {
  const syncTag = config.syncTag ?? '__vt_sync__';
  const sw      = self as unknown as ServiceWorkerGlobalScope;

  sw.addEventListener('sync', (event) => {
    const syncEvent = event as SyncEvent;
    if (syncEvent.tag !== syncTag) return;
    syncEvent.waitUntil(flushTrackerEvents(config.endpoint));
  });
}

async function flushTrackerEvents(fallbackEndpoint?: string): Promise<void> {
  // Each SW context has its own module state — reset the cached DB handle so
  // we open a fresh connection on first call inside the SW.
  const db = await openTrackerDB();

  const items = await new Promise<QueuedItem[]>((resolve, reject) => {
    const t   = db.transaction('events', 'readonly');
    const req = t.objectStore('events').getAll();
    req.onsuccess = () => resolve(req.result as QueuedItem[]);
    req.onerror   = () => reject(req.error);
  });

  if (items.length === 0) return;

  const endpoint: string | undefined =
    fallbackEndpoint ??
    (await new Promise<string | undefined>((resolve, reject) => {
      const t   = db.transaction('meta', 'readonly');
      const req = t.objectStore('meta').get('endpoint');
      req.onsuccess = () => resolve(req.result as string | undefined);
      req.onerror   = () => reject(req.error);
    }));

  if (!endpoint) return;

  const events = items.map((i) => i.event);
  const res    = await fetch(endpoint, {
    method:    'POST',
    headers:   { 'Content-Type': 'application/json' },
    body:      JSON.stringify(events),
    keepalive: true,
  });

  if (!res.ok) {
    // Throw so the browser retries the sync tag
    throw new Error(`[tracker-sw] flush failed: HTTP ${res.status}`);
  }

  const ids = items.map((i) => i.id);
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('events', 'readwrite');
    t.oncomplete = () => resolve();
    t.onerror    = () => reject(t.error);
    const store  = t.objectStore('events');
    for (const id of ids) store.delete(id);
  });
}

// Re-export for standalone SW entry
export { resetTrackerDB };
