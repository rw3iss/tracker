import type { StoredTrackerEvent } from '../../../common/types';
import type { ChannelType } from '../INotificationAdapter';
import { NotificationCategory } from '../NotificationCategory';

export function resolveOmitFromFailedEvent(event: StoredTrackerEvent): ChannelType[] {
  if (event.category !== NotificationCategory.NotificationFailed) return [];
  const failedChannel = event.payload?.failedChannel as ChannelType | undefined;
  return failedChannel ? [failedChannel] : [];
}
