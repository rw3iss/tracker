import type { ITrackerPlugin, IngestContext, ITrackerServiceRef } from '../ITrackerPlugin';
import type { TrackerEvent } from '../../common/types';

interface SamplingPluginConfig {
  /**
   * Per-event keep probability (0..1). Default: `1.0` (no sampling).
   * Drops happen *before* enrichers/dedup/storage — sampled events use no
   * downstream resources.
   */
  rate?:           number;
  /**
   * Event names (`message`) that bypass sampling — full fidelity always.
   * Default includes `'session_start'`, `'session_end'`, `'first_visit'`,
   * `'user_identified'`, `'user_anonymized'`, `'purchase'`, plus all `type:
   * 'error'` events.
   */
  alwaysEmit?:     string[];
  /**
   * Predicate variant — return `true` to bypass sampling for this event.
   * Combined with `alwaysEmit` via OR.
   */
  alwaysEmitWhen?: (event: TrackerEvent, ctx: IngestContext) => boolean;
}

const DEFAULT_ALWAYS_EMIT = [
  'session_start', 'session_end', 'first_visit',
  'user_identified', 'user_anonymized', 'purchase',
];

/**
 * Server-side sampling — applies before any other plugin's `onIngest` runs.
 *
 * Mirrors the client-side `AnalyticsPlugin.sampleRate` config but at the
 * consumer. Useful when:
 * - You can't change the client (multiple downstream apps emit at full rate)
 * - You want a single tunable knob across all emitters
 * - You want to keep total event volume manageable independent of source
 *
 * **Trade-off:** consumer-side sampling pays the bandwidth + ingest cost of
 * dropped events, but preserves the option to "store everything, sample on
 * read" by setting `rate: 1.0` here and applying sampling at query time.
 *
 * @example
 * ```typescript
 * TrackerModule.register({
 *   plugins: [
 *     new SamplingPlugin({ rate: 0.1 }),  // drop 90% of low-value events
 *     EventStoragePlugin.create(...),
 *   ],
 * });
 * ```
 */
export class SamplingPlugin implements ITrackerPlugin {
  static readonly PLUGIN_NAME = 'SamplingPlugin';
  readonly name = SamplingPlugin.PLUGIN_NAME;

  private readonly rate:           number;
  private readonly alwaysEmitSet:  Set<string>;
  private readonly alwaysEmitWhen: ((event: TrackerEvent, ctx: IngestContext) => boolean) | undefined;

  constructor(config: SamplingPluginConfig = {}) {
    this.rate = config.rate ?? 1.0;
    this.alwaysEmitSet = new Set([...(config.alwaysEmit ?? DEFAULT_ALWAYS_EMIT)]);
    this.alwaysEmitWhen = config.alwaysEmitWhen;
  }

  onInit(_ref: ITrackerServiceRef): void { /* no setup */ }

  onIngest(event: TrackerEvent, ctx: IngestContext): TrackerEvent | null {
    if (this.rate >= 1.0) return event;
    if (event.type === 'error') return event;
    if (this.alwaysEmitSet.has(event.message)) return event;
    if (this.alwaysEmitWhen?.(event, ctx)) return event;
    return Math.random() < this.rate ? event : null;
  }

  onEvent(_e: import('../../common/types').StoredTrackerEvent): void { /* no-op */ }
}
