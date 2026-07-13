import type { INotificationAdapter } from '../INotificationAdapter';
import type {
  EmailFormatter, SmsFormatter, WebhookFormatter, FirebaseFormatter,
  SlackFormatter, DiscordFormatter,
} from '../types';

export interface IEmailAdapter extends INotificationAdapter {
  readonly channelType: 'email';
}

export interface ISmsAdapter extends INotificationAdapter {
  readonly channelType: 'sms';
}

export interface IWebhookAdapter extends INotificationAdapter {
  readonly channelType: 'webhook';
}

export interface IFirebaseAdapter extends INotificationAdapter {
  readonly channelType: 'firebase';
}

export interface ISlackAdapter extends INotificationAdapter {
  readonly channelType: 'slack';
}

export interface IDiscordAdapter extends INotificationAdapter {
  readonly channelType: 'discord';
}

export interface EmailChannelConfig {
  adapter:     IEmailAdapter;
  recipients:  string[];
  from:        string;
  formatter?:  EmailFormatter;
}

export interface SmsChannelConfig {
  adapter:    ISmsAdapter;
  to:         string[];
  formatter?: SmsFormatter;
}

export interface WebhookChannelConfig {
  adapter:    IWebhookAdapter;
  formatter?: WebhookFormatter;
}

export interface FirebaseChannelConfig {
  adapter:    IFirebaseAdapter;
  tokens:     string[];
  formatter?: FirebaseFormatter;
}

export interface SlackChannelConfig {
  adapter:    ISlackAdapter;
  formatter?: SlackFormatter;
}

export interface DiscordChannelConfig {
  adapter:    IDiscordAdapter;
  formatter?: DiscordFormatter;
}

export interface ChannelConfigMap {
  email:    EmailChannelConfig;
  sms:      SmsChannelConfig;
  webhook:  WebhookChannelConfig;
  firebase: FirebaseChannelConfig;
  slack:    SlackChannelConfig;
  discord:  DiscordChannelConfig;
}
