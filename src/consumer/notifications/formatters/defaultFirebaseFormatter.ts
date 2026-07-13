import type { NotificationData, FirebasePayload } from '../types';
import { truncate } from '../utils/eventFormatters';
import type { StoredTrackerEvent } from '../../../common/types';

export function defaultFirebaseFormatter(
  data: NotificationData,
  tokens: string[],
): FirebasePayload {
  const event = data.body as StoredTrackerEvent;
  return {
    tokens,
    title: truncate(data.subject, 100),
    body: truncate(event.message ?? data.subject, 200),
    data: { eventId: event.id ?? '', type: event.type },
  };
}
