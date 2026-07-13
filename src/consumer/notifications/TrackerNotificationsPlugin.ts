import type { EventType, StoredTrackerEvent } from '../../common/types';
import type { ITrackerPlugin, ITrackerServiceRef } from '../ITrackerPlugin';
import type { INotificationStrategy } from './INotificationStrategy';
import type { IUnsentNotificationStorage } from './storage/IUnsentNotificationStorage';
import type { ChannelConfigMap } from './channels/ChannelConfig';
import type { NotificationTemplates } from './TemplateEngine';
import { NotificationDeduplicator } from './NotificationDeduplicator';
import type { CoarseDeduplicationConfig } from './NotificationDeduplicator';
import { NotificationDispatcher } from './NotificationDispatcher';

export interface TrackerNotificationsConfig {
  /** Must match the appId used in TrackerModule — used in error tracking. */
  appId?: string;
  /** One or more strategies to run per event. Executed in order, independently. */
  strategies: INotificationStrategy[];
  /** Channel configurations. Only configured channels can be dispatched to. */
  channels?: Partial<ChannelConfigMap>;
  /** Deduplication window. Default: 60_000 ms. */
  deduplication?: { windowMs: number };
  /** Optional coarse (type+message) deduplication layer applied before exact dedup. */
  coarseDeduplication?: CoarseDeduplicationConfig;
  /** Optional notification templates (currently scoped to email channel). */
  templates?: NotificationTemplates;
  /** Optional storage for failed notifications. */
  unsentStorage?: IUnsentNotificationStorage;
  /**
   * Plugin-level event type filter. When set, only events whose `type` is in this list
   * are forwarded to any strategy. Individual strategies can override with their own
   * `events` property.
   */
  events?: EventType[];
}

export class TrackerNotificationsPlugin implements ITrackerPlugin {
  private dispatcher: NotificationDispatcher | null = null;

  private constructor(private readonly config: TrackerNotificationsConfig) {}

  static create(config: TrackerNotificationsConfig): TrackerNotificationsPlugin {
    return new TrackerNotificationsPlugin(config);
  }

  async onInit(trackerService: ITrackerServiceRef): Promise<void> {
    const deduplicator = new NotificationDeduplicator(
      this.config.deduplication?.windowMs ?? 60_000,
      this.config.coarseDeduplication,
    );
    this.dispatcher = new NotificationDispatcher({
      channels:      this.config.channels,
      deduplicator,
      trackerService,
      appId:         this.config.appId,
      unsentStorage: this.config.unsentStorage,
      templates:     this.config.templates,
    });
  }

  async onEvent(event: StoredTrackerEvent): Promise<void> {
    if (!this.dispatcher) {
      throw new Error(
        'TrackerNotificationsPlugin.onInit() must be called before onEvent(). ' +
          'Ensure the plugin is registered in TrackerModule.register({ plugins: [...] }).',
      );
    }

    for (const strategy of this.config.strategies) {
      // Strategy-level events override plugin-level events
      const effectiveEvents = strategy.events ?? this.config.events;
      if (effectiveEvents && !effectiveEvents.includes(event.type)) continue;

      try {
        await strategy.onEvent(event, this.dispatcher);
      } catch {
        // Individual strategy errors must not block others or interrupt ingestion
      }
    }
  }

  onDestroy(): void {
    this.dispatcher = null;
  }
}
