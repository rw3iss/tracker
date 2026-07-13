import type { StoredTrackerEvent } from '../../../common/types';
import type { EventType } from '../../../common/types';
import { NotificationCategory } from '../NotificationCategory';

export function isErrorEvent(event: StoredTrackerEvent): boolean {
  return event.type === 'error';
}

export function isNotificationFailedEvent(event: StoredTrackerEvent): boolean {
  return event.category === NotificationCategory.NotificationFailed;
}

export function matchesCategory(event: StoredTrackerEvent, category: string): boolean {
  return event.category === category;
}

export function matchesType(event: StoredTrackerEvent, type: EventType): boolean {
  return event.type === type;
}

export function matchesAppId(event: StoredTrackerEvent, appId: string): boolean {
  return event.appId === appId;
}
