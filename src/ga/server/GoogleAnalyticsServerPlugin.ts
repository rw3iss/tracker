import type { StoredTrackerEvent, TrackerEvent } from '../../common/types';
import type { ITrackerPlugin, ITrackerServiceRef } from '../../consumer/ITrackerPlugin';
import { GaCore } from '../core/GaCore';
import { MeasurementProtocolAdapter } from '../adapters/MeasurementProtocolAdapter';
import type { ITransportAdapter } from '../adapters/ITransportAdapter';
import type {
  ForwardMode,
  ForwardRule,
  GaConfigOptions,
  GaConsentState,
  BatchingStrategy,
} from '../core/types';

/** Server-side GA plugin options. */
export interface GoogleAnalyticsServerPluginOptions {
  /** Required. One or more measurement IDs (`G-XXXX`). */
  measurementIds: string[];
  /** Required for the default Measurement Protocol adapter. */
  apiSecret?:     string;
  /** Operating mode. Default: `'forward'` — server-side ga-only doesn't make much sense. */
  mode?:          ForwardMode;
  /** Optional custom adapter — use to inject a stubbed transport in tests. Defaults to `MeasurementProtocolAdapter`. */
  adapter?:       ITransportAdapter;
  /** Optional `fetch` override for the default MP adapter. */
  fetch?:         typeof fetch;
  /** Send to GA's debug endpoint instead of production. Default: `false`. */
  debug?:         boolean;
  /** GA config options forwarded with every batch (e.g. `user_properties`). */
  config?:        GaConfigOptions;
  /** Forwarding rule. */
  forward?:       ForwardRule;
  /** Batching strategy — defaults to `'size-or-time'`, batchSize 25 (MP cap). */
  batching?:      {
    strategy?:       BatchingStrategy;
    batchSize?:      number;
    batchTimeoutMs?: number;
    maxSize?:        number;
  };
  /** Consent defaults — applied to every Measurement Protocol payload. */
  consent?:       {
    defaults?: GaConsentState;
    waitFor?:  Promise<GaConsentState | undefined>;
  };
}

/**
 * Server-side GA plugin. Fits into `TrackerModule.register({ plugins: [...] })`.
 *
 * Use this when:
 * - You're running `tracker-server` (or your own consumer) and want events
 *   forwarded to GA *from* the server, not the client. Useful for events
 *   that originate server-side (a webhook'd purchase event, a backend
 *   action) where there's no browser to fire `gtag()`.
 * - You want belt-and-suspenders coverage — let both the browser GA plugin
 *   and the server one fire on the same events. GA's deduplication handles
 *   the overlap when `client_id` + `session_id` match.
 * - You're doing server-side-only analytics for a non-DOM service (worker,
 *   batch job, native app backend).
 *
 * Sends via the GA4 Measurement Protocol (`MeasurementProtocolAdapter` by
 * default). Each event in the consumer pipeline that matches the
 * `forward` rule gets queued, batched (`BatchQueue`), and POSTed to GA.
 *
 * @example
 * ```typescript
 * import { TrackerModule } from '@rw3iss/tracker/consumer';
 * import { GoogleAnalyticsServerPlugin } from '@rw3iss/tracker/ga/server';
 *
 * TrackerModule.register({
 *   plugins: [
 *     new GoogleAnalyticsServerPlugin({
 *       measurementIds: ['G-XXXXXXXX'],
 *       apiSecret:      process.env.GA_MP_API_SECRET,
 *       forward: {
 *         events: ['purchase', 'refund', 'sign_up'],  // server-only conversion events
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
export class GoogleAnalyticsServerPlugin implements ITrackerPlugin {
  static readonly PLUGIN_NAME = 'GoogleAnalyticsServerPlugin';
  readonly name = GoogleAnalyticsServerPlugin.PLUGIN_NAME;

  private readonly core: GaCore;
  private readonly mode: ForwardMode;

  constructor(opts: GoogleAnalyticsServerPluginOptions) {
    if (!opts.adapter && !opts.apiSecret) {
      throw new Error('GoogleAnalyticsServerPlugin requires `apiSecret` (for the default MeasurementProtocolAdapter) or a custom `adapter`');
    }

    const adapter = opts.adapter ?? new MeasurementProtocolAdapter({
      apiSecret: opts.apiSecret!,
      fetch:     opts.fetch,
      debug:     opts.debug,
    });

    this.mode = opts.mode ?? 'forward';

    this.core = new GaCore(adapter, {
      measurementIds:    opts.measurementIds,
      mode:              this.mode,
      config:            opts.config,
      consent:           opts.consent,
      forward:           opts.forward,
      batching: {
        // GA caps MP payloads at 25 events; default to that.
        batchSize: 25,
        ...opts.batching,
      },
      // No identity source on the server — events arrive with their own
      // client_id / session_id from the emitter. The mapper picks them up.
      respectDoNotTrack: false,
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  //  ITrackerPlugin lifecycle
  // ──────────────────────────────────────────────────────────────────────

  async onInit(_ref: ITrackerServiceRef): Promise<void> {
    await this.core.init();
  }

  /**
   * Forward each post-stamp event into GA via the batch queue. Errors are
   * swallowed inside the queue; surfacing them would break the consumer
   * pipeline for one bad GA upstream.
   */
  onEvent(event: StoredTrackerEvent): void {
    if (this.mode === 'ga-only') return; // server-side ga-only doesn't make sense; treat as no-op
    // Server-side events have all the same fields as client-emitted ones —
    // pass straight through the mapper.
    const trackerEvent: TrackerEvent = {
      type:      event.type,
      message:   event.message,
      timestamp: event.timestamp,
      appId:     event.appId,
      payload:   event.payload,
      error:     event.error,
      context:   event.context,
      tags:      event.tags,
      category:  event.category,
    };
    try { this.core.forwardEvent(trackerEvent); }
    catch { /* never break ingest */ }
  }

  async onDestroy(): Promise<void> {
    await this.core.flush();
    this.core.destroy();
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Public API — for direct emission outside the pipeline
  // ──────────────────────────────────────────────────────────────────────

  /** Send a custom event directly to GA, bypassing the consumer pipeline. */
  event(name: string, params: Record<string, unknown> = {}): void {
    this.core.sendDirect({ name, params });
  }

  /** Update GA config at runtime. */
  updateConfig(opts: GaConfigOptions): void {
    this.core.updateConfig(opts);
  }

  /** Imperatively update consent. */
  setConsent(state: GaConsentState): void {
    this.core.setConsent(state);
  }

  /** Drain the forward queue. */
  async flush(): Promise<void> {
    return this.core.flush();
  }
}
