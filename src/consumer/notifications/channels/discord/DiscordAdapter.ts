import type { IDiscordAdapter } from '../ChannelConfig';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { DiscordPayload } from '../../formatters/defaultDiscordFormatter';

export interface DiscordAdapterConfig {
  webhookUrl:  string;
  username?:   string;
  avatarUrl?:  string;
  timeoutMs?:  number;
}

export class DiscordAdapter implements IDiscordAdapter {
  readonly channelType = 'discord' as const;

  private constructor(private readonly config: DiscordAdapterConfig) {}

  static create(config: DiscordAdapterConfig): DiscordAdapter {
    return new DiscordAdapter(config);
  }

  async send(payload: FormattedNotification): Promise<void> {
    const raw        = payload.raw as DiscordPayload;
    const controller = new AbortController();
    const timeoutMs  = this.config.timeoutMs ?? 10_000;
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    const body: DiscordPayload = {
      ...raw,
      username:   raw.username   ?? this.config.username,
      avatar_url: raw.avatar_url ?? this.config.avatarUrl,
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
          `Discord webhook responded ${response.status}: ${await response.text()}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
