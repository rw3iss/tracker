import type { EventType, StoredTrackerEvent } from '../../common/types';
import type { ChannelType } from './INotificationAdapter';
import type { NotificationDispatcher } from './NotificationDispatcher';

export interface INotificationStrategy {
  /**
   * If set, this strategy is only invoked for events whose `type` is in this list.
   * Takes precedence over any plugin-level `events` filter.
   */
  events?: EventType[];
  /**
   * If set, `dispatcher.notify()` is called with `{ include: channels }`.
   * Only the listed channels receive the notification.
   */
  channels?: ChannelType[];
  onEvent(
    event: StoredTrackerEvent,
    dispatcher: NotificationDispatcher,
  ): void | Promise<void>;
}
