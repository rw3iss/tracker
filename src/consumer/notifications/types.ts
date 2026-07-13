import type { StoredTrackerEvent } from '../../common/types';
import type { ChannelType } from './INotificationAdapter';
import type { SlackPayload } from './formatters/defaultSlackFormatter';
import type { DiscordPayload } from './formatters/defaultDiscordFormatter';

export interface NotificationData {
  subject: string;
  body: StoredTrackerEvent | Record<string, unknown>;
  [key: string]: unknown;
}

export interface NotificationDispatchOptions {
  /** Skip these channels even if configured. Omit takes precedence over include. */
  omit?: ChannelType[];
  /** Force-include these channels (still requires adapter to be configured). */
  include?: ChannelType[];
}

export type EmailFormatter    = (data: NotificationData, recipients: string[], from: string) => EmailPayload;
export type SmsFormatter      = (data: NotificationData, to: string[]) => SmsPayload;
export type WebhookFormatter  = (data: NotificationData) => WebhookPayload;
export type FirebaseFormatter = (data: NotificationData, tokens: string[]) => FirebasePayload;
export type SlackFormatter    = (data: NotificationData) => SlackPayload;
export type DiscordFormatter  = (data: NotificationData) => DiscordPayload;

export interface EmailPayload {
  from:    string;
  to:      string[];
  subject: string;
  html:    string;
  text:    string;
}

export interface SmsPayload {
  to:   string[];
  body: string;
}

export interface WebhookPayload {
  [key: string]: unknown;
}

export interface FirebasePayload {
  tokens: string[];
  title:  string;
  body:   string;
  data?:  Record<string, string>;
}

export type AnyPayload = EmailPayload | SmsPayload | WebhookPayload | FirebasePayload | SlackPayload | DiscordPayload;
