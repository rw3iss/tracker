import type { ISlackAdapter } from '../ChannelConfig';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { SlackPayload } from '../../formatters/defaultSlackFormatter';

export interface SlackAdapterConfig {
  webhookUrl:  string;
  username?:   string;
  iconEmoji?:  string;
  timeoutMs?:  number;
}

export class SlackAdapter implements ISlackAdapter {
  readonly channelType = 'slack' as const;

  private constructor(private readonly config: SlackAdapterConfig) {}

  static create(config: SlackAdapterConfig): SlackAdapter {
    return new SlackAdapter(config);
  }

  async send(payload: FormattedNotification): Promise<void> {
    const raw        = payload.raw as SlackPayload;
    const controller = new AbortController();
    const timeoutMs  = this.config.timeoutMs ?? 10_000;
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    const body: SlackPayload = {
      ...raw,
      username:   raw.username   ?? this.config.username  ?? 'Tracker',
      icon_emoji: raw.icon_emoji ?? this.config.iconEmoji ?? ':warning:',
    };

    try {
      const response = await fetch(this.config.webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Slack webhook responded ${response.status}: ${await response.text()}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
