import type { TrackerEvent } from '../../common/types';
import type { ITransportAdapter } from '../adapters/ITransportAdapter';
import { BatchQueue } from './BatchQueue';
import { ConsentManager } from './ConsentManager';
import { EventMapper, type GaEventEnvelope } from './EventMapper';
import { IdentityManager, type IIdentitySource } from './IdentityManager';
import type {
  BatchingStrategy,
  EnhancedMeasurementSettings,
  ForwardMode,
  ForwardRule,
  GaConfigOptions,
  GaConsentState,
} from './types';

/** Shared options the orchestrator owns across browser + server plugin variants. */
export interface GaCoreOptions {
  /** Required. One or more measurement IDs (`G-XXXX`) or container IDs (`GTM-XXXX`). */
  measurementIds: string[];
  /** Operating mode — see {@link ForwardMode}. */
  mode:           ForwardMode;
  /** Base config forwarded to `gtag('config', id, ...)` for every measurement ID. */
  config?:        GaConfigOptions;
  /** Consent defaults + waitFor. */
  consent?: {
    defaults?:          GaConsentState;
    waitFor?:           Promise<GaConsentState | undefined>;
    respectDoNotTrack?: boolean;
  };
  /** Forward-mode rule. Ignored when `mode !== 'forward'`. */
  forward?: ForwardRule;
  /** Batching strategy for forward mode. Default: `'size-or-time'`. */
  batching?: {
    strategy?:       BatchingStrategy;
    batchSize?:      number;
    batchTimeoutMs?: number;
    maxSize?:        number;
  };
  /** Enhanced-measurement toggle block. Translates to `gtag('config', id, { enhanced_measurement_settings: ... })`. */
  enhancedMeasurement?: EnhancedMeasurementSettings;
  /** Optional identity source — usually `AnalyticsPlugin`. */
  identitySource?: IIdentitySource;
  /** Override for `respectDoNotTrack`. Default: `true` — the ConsentManager does the actual gating. */
  respectDoNotTrack?: boolean;
}

/**
 * Cross-platform orchestrator. Owns the four pieces shared by the browser
 * plugin and the server plugin:
 *
 * 1. **ConsentManager** — Consent Mode v2 dance (default + update).
 * 2. **IdentityManager** — `client_id` / `session_id` / `user_id` sync.
 * 3. **EventMapper** — `TrackerEvent` → GA event with filtering.
 * 4. **BatchQueue** — coalescing for forward mode.
 *
 * The platform-specific plugins (browser `GoogleAnalyticsPlugin`, server
 * `GoogleAnalyticsServerPlugin`) compose this with an
 * `ITransportAdapter` (gtag, GTM, or Measurement Protocol) and the
 * matching `ITrackerClientPlugin` / `ITrackerPlugin` host interface.
 */
export class GaCore {
  readonly consent: ConsentManager;
  readonly identity: IdentityManager;
  readonly mapper:  EventMapper;
  readonly mode:    ForwardMode;
  readonly measurementIds: string[];

  private readonly adapter: ITransportAdapter;
  private readonly batchQueue: BatchQueue<GaEventEnvelope> | null;
  private readonly enhancedMeasurement: EnhancedMeasurementSettings | undefined;
  private readonly baseConfig: GaConfigOptions;

  private initialized = false;

  constructor(adapter: ITransportAdapter, opts: GaCoreOptions) {
    if (!opts.measurementIds || opts.measurementIds.length === 0) {
      throw new Error('GaCore requires at least one measurement ID');
    }
    this.adapter = adapter;
    this.measurementIds = [...opts.measurementIds];
    this.mode = opts.mode;
    this.enhancedMeasurement = opts.enhancedMeasurement;
    this.baseConfig = { ...(opts.config ?? {}) };
    if (opts.enhancedMeasurement) this.baseConfig.enhanced_measurement_settings = opts.enhancedMeasurement;
    // In forward mode, GA's auto page-view fires alongside our forwarded
    // page_view → double-counted. Disable GA's page-view auto unless the
    // host explicitly overrode it.
    if (this.mode === 'forward' && this.baseConfig.send_page_view === undefined) {
      this.baseConfig.send_page_view = false;
    }

    this.consent = new ConsentManager({
      defaults:          opts.consent?.defaults,
      waitFor:           opts.consent?.waitFor,
      respectDoNotTrack: opts.consent?.respectDoNotTrack ?? opts.respectDoNotTrack ?? true,
    });
    this.identity = new IdentityManager(opts.identitySource ?? null);
    this.mapper   = new EventMapper(opts.forward ?? {});

    // Batch queue only for forward mode. Adapter's `send` is the sink.
    this.batchQueue = this.mode === 'forward'
      ? new BatchQueue<GaEventEnvelope>({
          strategy:       opts.batching?.strategy       ?? 'size-or-time',
          batchSize:      opts.batching?.batchSize      ?? 10,
          batchTimeoutMs: opts.batching?.batchTimeoutMs ?? 5_000,
          maxSize:        opts.batching?.maxSize        ?? 1_000,
          onFlush:        (batch) => Promise.resolve(this.adapter.send(batch)),
        })
      : null;

    // Subscribe to consent — adapter calls happen here, not in subscribers.
    this.consent.subscribe((op, state) => this.adapter.consent(op, state));
  }

  /** Lazy-init the adapter. Calls beyond the first are no-ops. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const cfg = this.stampedConfig(this.baseConfig);
    await this.adapter.init(this.measurementIds, cfg);
  }

  /**
   * Forward an event into GA. In `'forward'` mode goes through the batch
   * queue; in `'tandem'` and `'ga-only'` modes each event is sent
   * immediately (those modes don't normally call this — the host's gtag
   * auto-tracking handles them).
   */
  forwardEvent(event: TrackerEvent): void {
    if (this.mode === 'ga-only') return; // no forwarding in ga-only mode
    const envelope = this.mapper.map(event);
    if (!envelope) return;

    // Stamp identity from the source if present and missing on the envelope.
    const id = this.identity.get();
    const params = { ...envelope.params };
    if (id.clientId  && params.client_id  === undefined) params.client_id  = id.clientId;
    if (id.sessionId && params.session_id === undefined) params.session_id = id.sessionId;
    if (id.userId    && params.user_id    === undefined) params.user_id    = id.userId;
    const final: GaEventEnvelope = { name: envelope.name, params };

    if (this.batchQueue) this.batchQueue.push(final);
    else                 this.adapter.send([final]);
  }

  /** Send a single event via the adapter — used by typed wrapper API methods. */
  sendDirect(event: GaEventEnvelope): void {
    this.adapter.send([event]);
  }

  /** Update GA config at runtime. Fans out across every measurement ID. */
  updateConfig(opts: GaConfigOptions): void {
    for (const id of this.measurementIds) this.adapter.config(id, opts);
  }

  /** Imperatively set consent. Triggers the adapter's `consent` listener. */
  setConsent(state: GaConsentState): void {
    this.consent.setConsent(state);
  }

  /** Drain the forward batch queue (e.g. before page hide). */
  async flush(): Promise<void> {
    await this.batchQueue?.flush();
  }

  /** Synchronous flush — for `pagehide` listeners. Returns the drained batch. */
  flushNow(): GaEventEnvelope[] | undefined {
    return this.batchQueue?.flushNow();
  }

  /** Tear everything down. */
  destroy(): void {
    this.batchQueue?.destroy();
    this.adapter.destroy();
    this.initialized = false;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Stamp identity onto the config if available — gives GA the correct `client_id` from the start. */
  private stampedConfig(base: GaConfigOptions): GaConfigOptions {
    const id = this.identity.get();
    return {
      ...base,
      ...(id.clientId  && base.client_id  === undefined ? { client_id:  id.clientId  } : {}),
      ...(id.sessionId && base.session_id === undefined ? { session_id: id.sessionId } : {}),
      ...(id.userId    && base.user_id    === undefined ? { user_id:    id.userId    } : {}),
    };
  }
}
