import type { GaEventEnvelope } from '../core/EventMapper';
import type { GaConfigOptions, GaConsentState } from '../core/types';

/**
 * Thin abstraction every GA delivery mechanism implements: gtag.js (browser),
 * GTM dataLayer (browser), and Measurement Protocol (server).
 *
 * Adapters are stateless from the plugin's perspective — they receive
 * config / consent / events from the orchestrator, never call back. The
 * plugin owns batching + identity sync; the adapter owns "how does it
 * actually reach Google".
 */
export interface ITransportAdapter {
  /** Adapter implementation name — `'gtag'`, `'gtm'`, `'measurement-protocol'`. */
  readonly name: string;

  /**
   * Lazy-load any external scripts and prepare the adapter for use.
   *
   * Must be idempotent — repeated calls (e.g. from overlapping plugins)
   * mustn't double-load the script. Returns when the adapter can accept
   * `event()` calls; for gtag, that's when `window.dataLayer` exists.
   */
  init(measurementIds: string[], config: GaConfigOptions): Promise<void>;

  /**
   * Push a config update to all configured measurement IDs (e.g. after
   * `client_id` is known, or on a runtime config change like `debug_mode`).
   */
  config(measurementId: string, opts: GaConfigOptions): void;

  /**
   * Apply a consent state. `op === 'default'` is called once at init before
   * gtag.js loads; `op === 'update'` is called on user consent changes.
   */
  consent(op: 'default' | 'update', state: GaConsentState): void;

  /**
   * Send a batch of events. Implementations decide whether to fire one call
   * per event (gtag, GTM) or coalesce them (Measurement Protocol).
   *
   * Each event is dispatched to ALL configured measurement IDs.
   */
  send(events: GaEventEnvelope[]): Promise<void> | void;

  /** Detach listeners, stop timers, etc. */
  destroy(): void;
}
