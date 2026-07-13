import type { StoredTrackerEvent, TrackerEvent } from '../../common/types';
import type { ITrackerServiceRef } from '../ITrackerPlugin';
import type { ChannelType } from './INotificationAdapter';
import type { NotificationData, NotificationDispatchOptions } from './types';
import type { ChannelConfigMap } from './channels/ChannelConfig';
import type { IUnsentNotificationStorage } from './storage/IUnsentNotificationStorage';
import type { NotificationTemplates } from './TemplateEngine';
import { NotificationDeduplicator } from './NotificationDeduplicator';
import { NotificationCategory } from './NotificationCategory';
import { defaultEmailFormatter } from './formatters/defaultEmailFormatter';
import { defaultSmsFormatter } from './formatters/defaultSmsFormatter';
import { defaultWebhookFormatter } from './formatters/defaultWebhookFormatter';
import { defaultFirebaseFormatter } from './formatters/defaultFirebaseFormatter';
import { defaultSlackFormatter } from './formatters/defaultSlackFormatter';
import { defaultDiscordFormatter } from './formatters/defaultDiscordFormatter';
import { renderTemplate, buildTemplateContext } from './TemplateEngine';

export interface NotificationDispatcherConfig {
  channels?:      Partial<ChannelConfigMap>;
  deduplicator:   NotificationDeduplicator;
  trackerService: ITrackerServiceRef;
  appId?:         string;
  unsentStorage?: IUnsentNotificationStorage;
  templates?:     NotificationTemplates;
}

export class NotificationDispatcher {
  constructor(private readonly cfg: NotificationDispatcherConfig) {}

  async notify(
    data: NotificationData,
    opts?: NotificationDispatchOptions,
  ): Promise<void> {
    const channels = this.cfg.channels ?? {};
    const omit     = new Set<ChannelType>(opts?.omit ?? []);

    let effective: ChannelType[];

    if (opts?.include) {
      // include restricts dispatch to only the listed channels
      effective = [];
      for (const ch of opts.include) {
        if (omit.has(ch)) continue;
        if (!channels[ch]) {
          await this.cfg.trackerService.track(this.buildUnconfiguredChannelError(ch, data));
          continue;
        }
        effective.push(ch);
      }
    } else {
      // no include: dispatch to all configured channels except omitted ones
      effective = (Object.keys(channels) as ChannelType[]).filter(ch => !omit.has(ch));
    }

    const body = data.body as StoredTrackerEvent;
    const canonicalId =
      body.category === NotificationCategory.NotificationFailed
        ? ((body.payload?.originalEventId as string | undefined) ?? body.id)
        : body.id;

    const channelSends = effective.map(async (channelType) => {
      if (this.cfg.deduplicator.seenCoarse(body)) return;
      const dedupKey = `${canonicalId}:${channelType}`;
      if (this.cfg.deduplicator.seen(dedupKey)) return;

      const formatted = this.format(channelType, data, channels);
      const adapter   = (channels[channelType] as { adapter: { send(p: any): Promise<void> } }).adapter;
      await adapter.send({ channelType, raw: formatted });
    });

    const results = await Promise.allSettled(channelSends);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const channelType = effective[i];
        const error       = result.reason as Error;
        await this.handleFailure(channelType, data, error, channels);
      }
    }
  }

  private format(
    channelType: ChannelType,
    data: NotificationData,
    channels: Partial<ChannelConfigMap>,
  ): unknown {
    switch (channelType) {
      case 'email': {
        const cfg       = channels.email!;
        const tmpl      = this.cfg.templates?.email;
        if (tmpl) {
          const event = data.body as StoredTrackerEvent;
          const ctx   = buildTemplateContext(event);
          return {
            from:    cfg.from,
            to:      cfg.recipients,
            subject: tmpl.subject ? renderTemplate(tmpl.subject, ctx) : data.subject,
            html:    tmpl.html    ? renderTemplate(tmpl.html,    ctx) : '',
            text:    tmpl.text    ? renderTemplate(tmpl.text,    ctx) : '',
          };
        }
        const fmt = cfg.formatter ?? defaultEmailFormatter;
        return fmt(data, cfg.recipients, cfg.from);
      }
      case 'sms': {
        const cfg = channels.sms!;
        const fmt = cfg.formatter ?? defaultSmsFormatter;
        return fmt(data, cfg.to);
      }
      case 'webhook': {
        const cfg = channels.webhook!;
        const fmt = cfg.formatter ?? defaultWebhookFormatter;
        return fmt(data);
      }
      case 'firebase': {
        const cfg = channels.firebase!;
        const fmt = cfg.formatter ?? defaultFirebaseFormatter;
        return fmt(data, cfg.tokens);
      }
      case 'slack': {
        const cfg = channels.slack!;
        const fmt = cfg.formatter ?? defaultSlackFormatter;
        return fmt(data);
      }
      case 'discord': {
        const cfg = channels.discord!;
        const fmt = cfg.formatter ?? defaultDiscordFormatter;
        return fmt(data);
      }
    }
  }

  private async handleFailure(
    channelType: ChannelType,
    data: NotificationData,
    error: Error,
    channels: Partial<ChannelConfigMap>,
  ): Promise<void> {
    const body = data.body as StoredTrackerEvent;
    const failureEvent: TrackerEvent = {
      type:      'error',
      category:  NotificationCategory.NotificationFailed,
      appId:     this.cfg.appId,
      message:   `Notification failed [${channelType}]: ${error.message}`,
      timestamp: Date.now(),
      payload: {
        failedChannel:       channelType,
        originalEventId:     body.id,
        adapterError:        error.message,
        notificationSubject: data.subject,
      },
    };

    await this.cfg.trackerService.track(failureEvent);

    if (this.cfg.unsentStorage) {
      const formatted = this.format(channelType, data, channels);
      const cfg = channels[channelType] as
        | { recipients?: string[]; to?: string[]; url?: string; tokens?: string[] }
        | undefined;
      const recipientInfo = JSON.stringify(
        cfg?.recipients ??
        cfg?.to ??
        (cfg as any)?.url ??
        (cfg as any)?.webhookUrl ??
        cfg?.tokens ??
        [],
      );
      await this.cfg.unsentStorage
        .save({
          channelType,
          appId:            this.cfg.appId,
          recipientInfo,
          formattedPayload: JSON.stringify(formatted),
          errorMessage:     error.message,
          originalEventId:  body.id,
          retryCount:       0,
        })
        .catch(() => {});
    }
  }

  private buildUnconfiguredChannelError(ch: ChannelType, data: NotificationData): TrackerEvent {
    return {
      type:      'error',
      category:  NotificationCategory.NotificationFailed,
      appId:     this.cfg.appId,
      message:   `Notification channel '${ch}' is not configured`,
      timestamp: Date.now(),
      payload: {
        requestedChannel:    ch,
        notificationSubject: data.subject,
      },
    };
  }
}
