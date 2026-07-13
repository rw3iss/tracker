import type { IWebhookAdapter } from '../ChannelConfig';
import type { FormattedNotification } from '../../INotificationAdapter';

export interface WebhookAdapterConfig {
  url:        string;
  headers?:   Record<string, string>;
  timeoutMs?: number;
}

export class WebhookAdapter implements IWebhookAdapter {
  readonly channelType = 'webhook' as const;

  constructor(private readonly config: WebhookAdapterConfig) {}

  async send(payload: FormattedNotification): Promise<void> {
    const controller = new AbortController();
    const timeoutMs  = this.config.timeoutMs ?? 10_000;
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.config.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(this.config.headers ?? {}) },
        body:    JSON.stringify(payload.raw),
        signal:  controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Webhook ${this.config.url} responded ${response.status}: ${await response.text()}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
