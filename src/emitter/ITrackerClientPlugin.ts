import type { TrackerEvent, TrackerContext } from '../common/types';

/**
 * Minimal `TrackerClient` surface exposed to plugins.
 *
 * Decouples the plugin interface from the full TrackerClient implementation,
 * preventing circular dependencies and limiting what plugins can do.
 *
 * @see {@link ITrackerClientPlugin.onInit}
 */
export interface ITrackerClientRef {
  /**
   * Capture a new tracker event.
   *
   * The event will pass through enrichers, other plugins' `onCapture`, and
   * `beforeSend` before being queued -- exactly like a direct call to
   * `TrackerClient.capture()`.
   *
   * @param event - The event to capture (timestamp, context, and appId are auto-set).
   */
  capture(event: Omit<TrackerEvent, 'timestamp' | 'context' | 'appId'>): void;

  /**
   * Read the current merged context.
   *
   * @returns A shallow copy of the current {@link TrackerContext}.
   */
  getContext(): TrackerContext;
}

/**
 * Plugin interface for client-side `TrackerClient` extensions.
 *
 * Plugins can inject behavior at two lifecycle points:
 *
 * 1. **{@link onInit}** -- called once after TrackerClient is configured.
 *    Install event listeners, set up state, or capture the client ref here.
 * 2. **{@link onCapture}** -- called synchronously before each event is enqueued.
 *    Use to transform, tag, or enrich events.
 * 3. **{@link onDestroy}** -- called when `TrackerClient.destroy()` is invoked.
 *    Remove all listeners and clean up resources.
 *
 * @example
 * ```typescript
 * const timingPlugin: ITrackerClientPlugin = {
 *   onInit(client) {
 *     // Plugin initialized
 *   },
 *   onCapture(event) {
 *     return { ...event, payload: { ...event.payload, capturedAt: performance.now() } };
 *   },
 * };
 * ```
 *
 * @see {@link TrackerConfig.plugins}
 * @see {@link ITrackerClientRef}
 */
export interface ITrackerClientPlugin {
  /**
   * Called once after `TrackerClient` is fully configured and started.
   *
   * Use this to install event listeners, capture the client reference, or
   * perform async setup (e.g. loading remote configuration).
   *
   * @param client - Minimal client reference for capturing events and reading context.
   * @returns Void or a Promise for async initialization.
   */
  onInit(client: ITrackerClientRef): void | Promise<void>;

  /**
   * Transform an event before it enters the send queue.
   *
   * Must be synchronous. Return the event unchanged if no mutation is needed.
   * Called after enrichers but before `beforeSend`.
   *
   * @param event - The event to transform.
   * @returns The (possibly modified) event.
   */
  onCapture?(event: TrackerEvent): TrackerEvent;

  /**
   * Called when `TrackerClient.destroy()` is invoked.
   *
   * Remove all event listeners and release any resources acquired in {@link onInit}.
   */
  onDestroy?(): void;
}
