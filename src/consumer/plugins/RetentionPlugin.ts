import type { StoredTrackerEvent } from '../../common/types';
import type { ITrackerPlugin, ITrackerServiceRef } from '../ITrackerPlugin';
import type { ITrackerStorage } from '../storage/ITrackerStorage';
import type { EventFilterConfig } from '../../common/filters';
import { matchesEventFilter } from '../../common/filters';

export interface RetentionPluginConfig {
  adapter:       ITrackerStorage;
  maxAgeDays:    number;
  /** Default: 3_600_000 (1 hour) */
  scheduleMs?:   number;
  /** Delete N events per purge run. Default: 1000 */
  batchSize?:    number;
  /** Only purge events matching this filter. Default: all events. */
  filter?:       EventFilterConfig;
}

export class RetentionPlugin implements ITrackerPlugin {
  readonly name = 'RetentionPlugin';

  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(private readonly config: RetentionPluginConfig) {}

  static create(config: RetentionPluginConfig): RetentionPlugin {
    return new RetentionPlugin(config);
  }

  onInit(_service: ITrackerServiceRef): void {
    const scheduleMs = this.config.scheduleMs ?? 3_600_000;
    this.purgeTimer = setInterval(() => this.purge(), scheduleMs);
  }

  onEvent(_event: StoredTrackerEvent): void {
    // no-op
  }

  async onDestroy(): Promise<void> {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
  }

  private async purge(): Promise<void> {
    const cutoff    = Date.now() - this.config.maxAgeDays * 86_400_000;
    const batchSize = this.config.batchSize ?? 1_000;

    try {
      const candidates = await this.config.adapter.find({ to: cutoff, limit: batchSize });

      for (const event of candidates) {
        if (this.config.filter && !matchesEventFilter(event, this.config.filter)) continue;
        try {
          await this.config.adapter.delete(event.id);
        } catch {
          // swallow per-event errors to keep purging remaining
        }
      }
    } catch {
      // swallow — purge errors must not surface to callers
    }
  }
}
