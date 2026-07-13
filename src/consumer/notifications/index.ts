// Plugin
export { TrackerNotificationsPlugin } from './TrackerNotificationsPlugin';
export type { TrackerNotificationsConfig } from './TrackerNotificationsPlugin';

// Category constants
export { NotificationCategory } from './NotificationCategory';
export type { NotificationCategoryValue } from './NotificationCategory';

// Interfaces
export type { INotificationStrategy } from './INotificationStrategy';
export type { INotificationAdapter, ChannelType, FormattedNotification } from './INotificationAdapter';

// Types
export type {
  NotificationData, NotificationDispatchOptions,
  EmailPayload, SmsPayload, WebhookPayload, FirebasePayload,
  EmailFormatter, SmsFormatter, WebhookFormatter, FirebaseFormatter,
  SlackFormatter, DiscordFormatter,
} from './types';

// Channel config types
export type {
  IEmailAdapter, ISmsAdapter, IWebhookAdapter, IFirebaseAdapter,
  ISlackAdapter, IDiscordAdapter,
  EmailChannelConfig, SmsChannelConfig, WebhookChannelConfig, FirebaseChannelConfig,
  SlackChannelConfig, DiscordChannelConfig,
  ChannelConfigMap,
} from './channels/ChannelConfig';

// Built-in strategies
export { NotifyOnErrorsStrategy } from './strategies/NotifyOnErrorsStrategy';
export { DefaultStrategy } from './strategies/DefaultStrategy';
export type { DefaultStrategyConfig } from './strategies/DefaultStrategy';

// Email adapters
export { SmtpAdapter } from './channels/email/SmtpAdapter';
export type { SmtpAdapterConfig } from './channels/email/SmtpAdapter';
export { SendGridApiAdapter } from './channels/email/SendGridApiAdapter';
export type { SendGridApiAdapterConfig } from './channels/email/SendGridApiAdapter';
export { MailgunAdapter } from './channels/email/MailgunAdapter';
export type { MailgunAdapterConfig } from './channels/email/MailgunAdapter';
export { PostmarkAdapter } from './channels/email/PostmarkAdapter';
export type { PostmarkAdapterConfig } from './channels/email/PostmarkAdapter';

// SMS adapters
export { TwilioSmsAdapter } from './channels/sms/TwilioSmsAdapter';
export type { TwilioSmsAdapterConfig } from './channels/sms/TwilioSmsAdapter';

// Webhook adapters
export { WebhookAdapter } from './channels/webhook/WebhookAdapter';
export type { WebhookAdapterConfig } from './channels/webhook/WebhookAdapter';

// Slack adapters
export { SlackAdapter } from './channels/slack/SlackAdapter';
export type { SlackAdapterConfig } from './channels/slack/SlackAdapter';

// Discord adapters
export { DiscordAdapter } from './channels/discord/DiscordAdapter';
export type { DiscordAdapterConfig } from './channels/discord/DiscordAdapter';

// Firebase adapters
export { FirebaseAdapter } from './channels/firebase/FirebaseAdapter';
export type { FirebaseAdapterConfig } from './channels/firebase/FirebaseAdapter';

// Default formatters
export { defaultEmailFormatter } from './formatters/defaultEmailFormatter';
export { defaultSmsFormatter } from './formatters/defaultSmsFormatter';
export { defaultWebhookFormatter } from './formatters/defaultWebhookFormatter';
export { defaultFirebaseFormatter } from './formatters/defaultFirebaseFormatter';
export { defaultSlackFormatter } from './formatters/defaultSlackFormatter';
export type { SlackPayload, SlackBlock } from './formatters/defaultSlackFormatter';
export { defaultDiscordFormatter } from './formatters/defaultDiscordFormatter';
export type { DiscordPayload, DiscordEmbed } from './formatters/defaultDiscordFormatter';

// Unsent storage
export type { IUnsentNotificationStorage, UnsentNotificationRecord, StoredUnsentNotification } from './storage/IUnsentNotificationStorage';
export { UnsentNotificationEntity } from './storage/UnsentNotificationEntity';
export { TypeOrmUnsentNotificationStorage } from './storage/TypeOrmUnsentNotificationStorage';

// Utilities
export { isErrorEvent, isNotificationFailedEvent, matchesCategory, matchesType, matchesAppId } from './utils/eventFilters';
export { serializeEventToText, serializeEventToHtml, truncate } from './utils/eventFormatters';
export { resolveOmitFromFailedEvent } from './utils/resolveOmit';

// Event filter types (re-exported from common for convenience)
export type { EventFilterFn, EventFilterConfig, EventFilter } from '../../common/filters';
export { matchesEventFilter } from '../../common/filters';

// Dispatcher (exported for custom strategy implementations)
export { NotificationDispatcher } from './NotificationDispatcher';
export type { NotificationDispatcherConfig } from './NotificationDispatcher';
export { NotificationDeduplicator } from './NotificationDeduplicator';
export type { CoarseDeduplicationConfig } from './NotificationDeduplicator';

// Retry worker
export { NotificationRetryWorker } from './NotificationRetryWorker';
export type { NotificationRetryWorkerConfig } from './NotificationRetryWorker';

// Template engine
export { renderTemplate, buildTemplateContext } from './TemplateEngine';
export type { TemplateContext, NotificationTemplates } from './TemplateEngine';
