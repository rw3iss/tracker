import type { StoredTrackerEvent } from '../../common/types';
import type { ITrackerPlugin } from '../ITrackerPlugin';
import type { EventFilter } from '../../common/filters';
import { matchesEventFilter } from '../../common/filters';

export interface ForwardingPluginConfig {
  endpoint:    string;
  filter?:     EventFilter;
  headers?:    Record<string, string>;
  timeoutMs?:  number;
  /** Buffer and send in batches. Default: 0 (immediate). */
  batchSize?:  number;
}

export class ForwardingPlugin implements ITrackerPlugin {
  readonly name = 'ForwardingPlugin';

  private readonly batch: StoredTrackerEvent[] = [];

  private constructor(private readonly config: ForwardingPluginConfig) {}

  static create(config: ForwardingPluginConfig): ForwardingPlugin {
    return new ForwardingPlugin(config);
  }

  async onEvent(event: StoredTrackerEvent): Promise<void> {
    if (this.config.filter && !matchesEventFilter(event, this.config.filter)) return;

    const batchSize = this.config.batchSize ?? 0;

    if (batchSize > 0) {
      this.batch.push(event);
      if (this.batch.length >= batchSize) {
        const toSend = this.batch.splice(0, this.batch.length);
        await this.send(toSend);
      }
    } else {
      await this.send([event]);
    }
  }

  async onDestroy(): Promise<void> {
    if (this.batch.length > 0) {
      const toSend = this.batch.splice(0, this.batch.length);
      await this.send(toSend);
    }
  }

  private async send(events: StoredTrackerEvent[]): Promise<void> {
    const { endpoint, headers = {}, timeoutMs } = this.config;

    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller && timeoutMs
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body:    JSON.stringify(events.length === 1 ? events[0] : events),
        signal:  controller?.signal,
      });
    } catch {
      // swallow — forwarding errors must not surface to callers
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
