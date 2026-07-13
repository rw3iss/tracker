import type { StoredTrackerEvent } from '../../common/types';
import type { ITrackerPlugin, ITrackerServiceRef } from '../ITrackerPlugin';

export interface PrometheusPluginConfig {
  /** Whether to expose /tracker/metrics endpoint (via TrackerController). Default: true */
  exposeEndpoint?: boolean;
}

export class PrometheusPlugin implements ITrackerPlugin {
  readonly name = 'PrometheusPlugin';

  /** key: "type:appId:status" → total count */
  private readonly counters = new Map<string, number>();

  private constructor(private readonly config: PrometheusPluginConfig) {}

  static create(config?: PrometheusPluginConfig): PrometheusPlugin {
    return new PrometheusPlugin(config ?? {});
  }

  onInit(service: ITrackerServiceRef): void {
    if (this.config.exposeEndpoint !== false) {
      service.registerMetricsProvider(() => this.renderMetrics());
    }
  }

  onEvent(event: StoredTrackerEvent): void {
    const key = `${event.type}:${event.appId ?? ''}:${event.status}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  renderMetrics(): string {
    const lines: string[] = [
      '# HELP tracker_events_total Total tracker events received',
      '# TYPE tracker_events_total counter',
    ];

    for (const [key, count] of this.counters) {
      const [type, appId, status] = key.split(':');
      const labels = `type="${type}",appId="${appId}",status="${status}"`;
      lines.push(`tracker_events_total{${labels}} ${count}`);
    }

    return lines.join('\n') + '\n';
  }
}
