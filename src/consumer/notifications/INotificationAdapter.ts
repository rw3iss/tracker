export type ChannelType = 'email' | 'sms' | 'webhook' | 'firebase' | 'slack' | 'discord';

export interface FormattedNotification {
  channelType: ChannelType;
  /** Channel-specific payload (EmailPayload, SmsPayload, etc.) */
  raw: unknown;
}

export interface INotificationAdapter {
  readonly channelType: ChannelType;
  send(payload: FormattedNotification): Promise<void>;
}
