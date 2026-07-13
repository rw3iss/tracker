import type { ITransportAdapter } from './ITransportAdapter';
import type { GaConfigOptions, GaConsentState } from '../core/types';
import type { GaEventEnvelope } from '../core/EventMapper';

interface MeasurementProtocolAdapterOptions {
  /** GA Measurement Protocol API secret (created in GA admin → Data Streams → Measurement Protocol API secrets). */
  apiSecret: string;
  /** Override the endpoint — defaults to `https://www.google-analytics.com/mp/collect`. */
  endpoint?: string;
  /** Custom fetch implementation — useful when the host wraps fetch (logging, signing, etc.). */
  fetch?:    typeof fetch;
  /** Send events to the debug endpoint (`/debug/mp/collect`) instead of `/mp/collect`. Useful for testing. */
  debug?:    boolean;
}

interface MpEventPayload {
  client_id?:  string;
  user_id?:    string;
  events:      Array<{ name: string; params?: Record<string, unknown> }>;
  user_properties?: Record<string, { value: string | number | boolean | null }>;
  timestamp_micros?: number;
  consent?:    GaConsentState;
}

/**
 * Server-side and browser-side adapter using GA's
 * [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4).
 *
 * Sends events as HTTP POST to `https://www.google-analytics.com/mp/collect`
 * with a measurement ID + API secret. Suitable for:
 * - Backend services (where gtag.js doesn't run) that want to attribute
 *   purchases / conversions / off-page events
 * - Hardening against ad blockers (the call origins from your server, not
 *   from the browser to googletagmanager.com)
 * - Native apps and other non-DOM environments
 *
 * **Multi-ID:** the Measurement Protocol takes a single measurement ID per
 * call. For multi-ID setups, the adapter fans out by issuing one POST per
 * configured ID per batch. Failures on one ID don't affect the others.
 *
 * **Batching note:** GA's Measurement Protocol accepts up to 25 events per
 * payload. The orchestrator's `BatchQueue` should be configured with
 * `batchSize <= 25` when using this adapter.
 */
export class MeasurementProtocolAdapter implements ITransportAdapter {
  readonly name = 'measurement-protocol';
  static readonly MAX_EVENTS_PER_PAYLOAD = 25;

  private measurementIds: string[] = [];
  private latestConfig: GaConfigOptions = {};
  private latestConsent: GaConsentState | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(private readonly opts: MeasurementProtocolAdapterOptions) {
    if (!opts.apiSecret) throw new Error('MeasurementProtocolAdapter requires `apiSecret`');
    this.fetchImpl = opts.fetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null as unknown as typeof fetch);
    if (!this.fetchImpl) {
      throw new Error('MeasurementProtocolAdapter: no `fetch` available — pass `opts.fetch` (e.g. node-fetch) or use Node 18+');
    }
    this.endpoint = opts.endpoint ?? `https://www.google-analytics.com/${opts.debug ? 'debug/' : ''}mp/collect`;
  }

  init(measurementIds: string[], config: GaConfigOptions): Promise<void> {
    this.measurementIds = [...measurementIds];
    this.latestConfig = { ...config };
    return Promise.resolve();
  }

  config(_measurementId: string, opts: GaConfigOptions): void {
    // Latest config wins — passed in on each send().
    this.latestConfig = { ...this.latestConfig, ...opts };
  }

  consent(_op: 'default' | 'update', state: GaConsentState): void {
    this.latestConsent = { ...this.latestConsent, ...state };
  }

  async send(events: GaEventEnvelope[]): Promise<void> {
    if (events.length === 0 || this.measurementIds.length === 0) return;

    // Group identity per event so client_id / user_id mismatches don't get
    // collapsed (rare in practice — most batches share one identity — but
    // important for correctness).
    const groups = groupByIdentity(events, this.latestConfig);

    const tasks: Promise<unknown>[] = [];
    for (const [, group] of groups.entries()) {
      // Chunk by GA's 25-event-per-payload cap.
      for (let i = 0; i < group.events.length; i += MeasurementProtocolAdapter.MAX_EVENTS_PER_PAYLOAD) {
        const slice = group.events.slice(i, i + MeasurementProtocolAdapter.MAX_EVENTS_PER_PAYLOAD);
        const payload: MpEventPayload = {
          client_id: group.clientId,
          user_id:   group.userId,
          events:    slice,
          user_properties: this.latestConfig.user_properties
            ? Object.fromEntries(Object.entries(this.latestConfig.user_properties).map(([k, v]) => [k, { value: v as string | number | boolean | null }]))
            : undefined,
          timestamp_micros: Date.now() * 1000,
          consent: this.latestConsent ?? undefined,
        };
        for (const id of this.measurementIds) {
          tasks.push(this.postOne(id, payload));
        }
      }
    }

    const results = await Promise.allSettled(tasks);
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      // Surface the first error — caller (BatchQueue.onError) will log.
      throw (failed[0] as PromiseRejectedResult).reason;
    }
  }

  destroy(): void { /* nothing to clean up */ }

  // ── Internals ──────────────────────────────────────────────────────────

  private async postOne(measurementId: string, payload: MpEventPayload): Promise<void> {
    const url = `${this.endpoint}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(this.opts.apiSecret)}`;
    const res = await this.fetchImpl(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`MeasurementProtocol HTTP ${res.status} for ${measurementId}`);
    }
  }
}

interface IdentityGroup {
  clientId?: string;
  userId?:   string;
  events:    Array<{ name: string; params?: Record<string, unknown> }>;
}

/**
 * Group events by `client_id` + `user_id`. Identity-bearing fields are
 * stripped from individual `params` objects since the MP wraps them at the
 * envelope level.
 */
function groupByIdentity(envelopes: GaEventEnvelope[], baseConfig: GaConfigOptions): Map<string, IdentityGroup> {
  const groups = new Map<string, IdentityGroup>();
  for (const env of envelopes) {
    const clientId = (env.params.client_id as string | undefined) ?? baseConfig.client_id;
    const userId   = (env.params.user_id   as string | undefined) ?? baseConfig.user_id;
    const sessionId = env.params.session_id as string | undefined;
    const key = `${clientId ?? ''}::${userId ?? ''}`;
    const params: Record<string, unknown> = { ...env.params };
    delete params.client_id;
    delete params.user_id;
    // session_id is reported as an event-level param in GA4 MP.
    if (sessionId !== undefined) params.session_id = sessionId;
    const event = { name: env.name, params: Object.keys(params).length > 0 ? params : undefined };
    const existing = groups.get(key);
    if (existing) existing.events.push(event);
    else          groups.set(key, { clientId, userId, events: [event] });
  }
  return groups;
}
