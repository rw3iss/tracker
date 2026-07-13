import type { NotificationData, EmailPayload } from '../types';
import { serializeEventToHtml, serializeEventToText } from '../utils/eventFormatters';
import type { StoredTrackerEvent } from '../../../common/types';

export function defaultEmailFormatter(
  data: NotificationData,
  recipients: string[],
  from: string,
): EmailPayload {
  const event = data.body as StoredTrackerEvent;
  return {
    from,
    to: recipients,
    subject: data.subject,
    html: serializeEventToHtml(event),
    text: serializeEventToText(event),
  };
}
