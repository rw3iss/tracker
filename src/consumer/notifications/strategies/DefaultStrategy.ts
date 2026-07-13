import type { EventType, StoredTrackerEvent } from '../../../common/types';
import type { ChannelType } from '../INotificationAdapter';
import type { NotificationDispatcher } from '../NotificationDispatcher';
import type { INotificationStrategy } from '../INotificationStrategy';

export interface DefaultStrategyConfig {
  /**
   * Subject template. Supports `{{type}}` and `{{message}}` placeholders.
   * Default: `'[{{type}}] {{message}}'`.
   */
  subject?: string;
  /**
   * Limit this strategy to the given event types.
   * Overrides the plugin-level `events` filter for this strategy instance.
   * Default: all types (or whatever the plugin-level filter allows).
   */
  events?: EventType[];
  /**
   * Restrict dispatch to these channels — passed as `include` to `dispatcher.notify()`.
   * If omitted, all configured channels receive the notification.
   */
  channels?: ChannelType[];
}

/**
 * Zero-code default strategy.
 *
 * Forwards events to configured channels without custom filtering logic.
 * Use `events` to restrict which types it handles and `channels` to target specific channels.
 *
 * ```typescript
 * new DefaultStrategy({ events: ['error', 'warning'], channels: ['email', 'webhook'] })
 * ```
 */
export class DefaultStrategy implements INotificationStrategy {
  readonly events?:   EventType[];
  readonly channels?: ChannelType[];

  constructor(private readonly config: DefaultStrategyConfig = {}) {
    this.events   = config.events;
    this.channels = config.channels;
  }

  async onEvent(
    event: StoredTrackerEvent,
    dispatcher: NotificationDispatcher,
  ): Promise<void> {
    const subject = this.resolveSubject(event);
    await dispatcher.notify(
      { subject, body: event },
      this.channels ? { include: this.channels } : undefined,
    );
  }

  private resolveSubject(event: StoredTrackerEvent): string {
    const tpl = this.config.subject ?? '[{{type}}] {{message}}';
    return tpl
      .replace('{{type}}',    event.type)
      .replace('{{message}}', event.message.slice(0, 100));
  }
}
