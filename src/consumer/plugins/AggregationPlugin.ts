import type { StoredTrackerEvent } from '../../common/types';
import type { ITrackerPlugin, ITrackerServiceRef } from '../ITrackerPlugin';
import type { ITrackerStorage } from '../storage/ITrackerStorage';

export interface AggregationPluginConfig {
  adapter:   ITrackerStorage;
  windowMs:  number;
  /** Default: appId + type + message concatenated */
  key?: (e: StoredTrackerEvent) => string;
}

interface WindowEntry {
  representative: StoredTrackerEvent;
  count:          number;
}

function djb2(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash.toString(36);
}

function defaultKey(e: StoredTrackerEvent): string {
  return djb2(`${e.appId ?? ''}\x00${e.type}\x00${e.message}`);
}

export class AggregationPlugin implements ITrackerPlugin {
  readonly name = 'AggregationPlugin';

  private readonly buffer = new Map<string, WindowEntry>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(private readonly config: AggregationPluginConfig) {}

  static create(config: AggregationPluginConfig): AggregationPlugin {
    return new AggregationPlugin(config);
  }

  onInit(_service: ITrackerServiceRef): void {
    this.flushTimer = setInterval(() => this.flush(), this.config.windowMs);
  }

  onEvent(event: StoredTrackerEvent): void {
    const key = this.config.key ? this.config.key(event) : defaultKey(event);
    const entry = this.buffer.get(key);
    if (entry) {
      entry.count++;
    } else {
      this.buffer.set(key, { representative: event, count: 1 });
    }
  }

  async onDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.size === 0) return;

    const entries = [...this.buffer.values()];
    this.buffer.clear();

    for (const entry of entries) {
      try {
        await this.config.adapter.save({ ...entry.representative, count: entry.count });
      } catch {
        // swallow — storage errors must not crash the flush loop
      }
    }
  }
}
