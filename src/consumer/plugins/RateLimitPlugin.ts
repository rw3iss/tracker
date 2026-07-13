import type { StoredTrackerEvent, TrackerEvent } from '../../common/types';
import type { IngestContext, ITrackerPlugin } from '../ITrackerPlugin';

export interface RateLimitPluginConfig {
  windowMs:  number;
  maxEvents: number;
  /** Default: appId ?? ctx.ip ?? 'unknown' */
  keyFn?: (event: TrackerEvent, ctx: IngestContext) => string;
  /** Emit a tracker event when rate limit is hit. Default: false */
  trackDropped?: boolean;
}

interface WindowEntry {
  count:   number;
  resetAt: number;
}

export class RateLimitPlugin implements ITrackerPlugin {
  readonly name = 'RateLimitPlugin';

  private readonly windows = new Map<string, WindowEntry>();

  private constructor(private readonly config: RateLimitPluginConfig) {}

  static create(config: RateLimitPluginConfig): RateLimitPlugin {
    return new RateLimitPlugin(config);
  }

  onIngest(event: TrackerEvent, ctx: IngestContext): TrackerEvent | null {
    const key = this.config.keyFn
      ? this.config.keyFn(event, ctx)
      : (event.appId ?? ctx.ip ?? 'unknown');

    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || now >= entry.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.config.windowMs });
      return event;
    }

    if (entry.count >= this.config.maxEvents) {
      return null;
    }

    entry.count++;
    return event;
  }

  onEvent(_event: StoredTrackerEvent): void {
    // no-op — rate limiting happens in onIngest
  }
}
