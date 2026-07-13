import type { NotificationData, WebhookPayload } from '../types';

export function defaultWebhookFormatter(data: NotificationData): WebhookPayload {
  return { ...data } as WebhookPayload;
}
