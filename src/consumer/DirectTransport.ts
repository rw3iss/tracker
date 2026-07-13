import type { TrackerEvent } from '../common/types';
import type { ITrackerTransport } from '../emitter/ITrackerTransport';
import type { TrackerService } from './TrackerService';

/**
 * Transport that delivers events directly to a {@link TrackerService} instance
 * without any network roundtrip.
 *
 * Use this when the `TrackerClient` runs in the same process as the
 * {@link TrackerService} (e.g. a backend tracking its own errors). This avoids
 * the overhead of HTTP serialization and localhost networking.
 *
 * The handler is resolved lazily via a getter function so the transport
 * can be created before TrackerService is available (e.g. during NestJS
 * module bootstrap).
 *
 * @remarks
 * Never use `TrackerClient` with `endpoint` pointed at the same server --
 * that creates a wasteful localhost HTTP loop. Use `DirectTransport` instead.
 *
 * @example
 * ```typescript
 * import { TrackerClient } from '@rw3iss/tracker';
 * import { TrackerService, DirectTransport } from '@rw3iss/tracker/consumer';
 *
 * // Wire up after NestJS bootstraps:
 * TrackerClient.init({
 *   appId: 'api-server',
 *   transport: new DirectTransport(() => TrackerService.instance()),
 * });
 *
 * // Now use the same API everywhere:
 * tracker.error(new Error('something broke'));
 * tracker.info('server started');
 * tracker.track('auction:stale-state', { auctionId: 123 });
 * ```
 *
 * @see {@link ITrackerTransport}
 * @see {@link TrackerService.instance}
 */
export class DirectTransport implements ITrackerTransport {
  private readonly getService: () => TrackerService | null;

  /**
   * Create a DirectTransport with a lazy service getter.
   *
   * @param getService - Lazy getter for the {@link TrackerService} instance.
   *   Called on every {@link send}. If it returns `null`, events are silently
   *   dropped (module not initialized yet or already destroyed).
   *
   * @example
   * ```typescript
   * const transport = new DirectTransport(() => TrackerService.instance());
   * ```
   */
  constructor(getService: () => TrackerService | null) {
    this.getService = getService;
  }

  /**
   * Deliver events directly to the TrackerService without network I/O.
   *
   * @param events - Array of events to deliver.
   * @returns A promise that resolves when all events are processed.
   */
  async send(events: TrackerEvent[]): Promise<void> {
    const svc = this.getService();
    if (!svc) return;
    await svc.trackBatch(events);
  }
}
