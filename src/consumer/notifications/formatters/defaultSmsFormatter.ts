import type { NotificationData, SmsPayload } from '../types';
import { truncate } from '../utils/eventFormatters';

export function defaultSmsFormatter(data: NotificationData, to: string[]): SmsPayload {
  const msg = `[${data.subject}]`;
  return { to, body: truncate(msg, 160) };
}
