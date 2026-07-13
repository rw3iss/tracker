import type { TrackerEvent } from '../common/types';

/**
 * Pluggable delivery mechanism for {@link TrackerClient}.
 *
 * The client pipeline (enrichers -> plugins -> beforeSend) runs identically
 * regardless of transport. The transport only controls HOW the final event
 * reaches the processing backend.
 *
 * Built-in transports:
 * - **HttpTransport** (implicit) -- queue + periodic flush + POST to endpoint
 * - **`DirectTransport`** -- call a handler function directly, no network
 *
 * @remarks
 * Implement this interface to create custom delivery mechanisms (e.g. WebSocket,
 * UDP, or file-based transport for offline scenarios).
 *
 * @example
 * ```typescript
 * const myTransport: ITrackerTransport = {
 *   async send(events) {
 *     await myCustomDelivery(events);
 *   },
 * };
 *
 * TrackerClient.init({ transport: myTransport, appId: 'my-app' });
 * ```
 *
 * @see {@link TrackerConfig.transport}
 */
export interface ITrackerTransport {
  /**
   * Deliver one or more events to the backend.
   *
   * @param events - Array of tracker events to deliver.
   * @returns A promise that resolves when delivery is complete.
   */
  send(events: TrackerEvent[]): Promise<void>;

  /**
   * Called when the tracker starts. Optional setup (e.g. open connections,
   * start flush timers).
   */
  start?(): void;

  /**
   * Called when the tracker is destroyed. Optional teardown (e.g. close
   * connections, release resources).
   */
  stop?(): void;

  /**
   * Flush any buffered events immediately.
   *
   * @returns A promise that resolves when all buffered events are delivered.
   */
  flush?(): Promise<void>;
}
