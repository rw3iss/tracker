import { NotificationDispatcher } from '../../../../src/consumer/notifications/NotificationDispatcher';
import { NotificationDeduplicator } from '../../../../src/consumer/notifications/NotificationDeduplicator';
import { NotificationCategory } from '../../../../src/consumer/notifications/NotificationCategory';
import { TrackerEventStatus } from '../../../../src/common/types';
import type { StoredTrackerEvent } from '../../../../src/common/types';
import type { ChannelConfigMap } from '../../../../src/consumer/notifications/channels/ChannelConfig';
import type { ITrackerServiceRef } from '../../../../src/consumer/ITrackerPlugin';
import type { FormattedNotification } from '../../../../src/consumer/notifications/INotificationAdapter';

function makeSlackAdapter(fail = false) {
  return {
    channelType: 'slack' as const,
    send: jest.fn(async (_p: FormattedNotification) => {
      if (fail) throw new Error('slack error');
    }),
  };
}

function makeDiscordAdapter(fail = false) {
  return {
    channelType: 'discord' as const,
    send: jest.fn(async (_p: FormattedNotification) => {
      if (fail) throw new Error('discord error');
    }),
  };
}

function makeEvent(overrides: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent {
  return {
    id: 'evt-1', type: 'error', message: 'something broke',
    status: TrackerEventStatus.New, timestamp: Date.now(), receivedAt: Date.now(),
    ...overrides,
  };
}

function makeEmailAdapter(fail = false) {
  return {
    channelType: 'email' as const,
    send: jest.fn(async (_p: FormattedNotification) => {
      if (fail) throw new Error('smtp timeout');
    }),
  };
}

function makeWebhookAdapter(fail = false) {
  return {
    channelType: 'webhook' as const,
    send: jest.fn(async (_p: FormattedNotification) => {
      if (fail) throw new Error('connection refused');
    }),
  };
}

function makeTrackerService(): jest.Mocked<ITrackerServiceRef> {
  return {
    track:                   jest.fn().mockResolvedValue(undefined),
    setStorage:              jest.fn(),
    registerMetricsProvider: jest.fn(),
  };
}

describe('NotificationDispatcher', () => {
  it('calls configured channel adapter with formatted payload', async () => {
    const emailAdapter = makeEmailAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator: new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId: 'test-app',
    });

    await dispatcher.notify({ subject: 'Test error', body: makeEvent() });
    expect(emailAdapter.send).toHaveBeenCalledTimes(1);
    const call = emailAdapter.send.mock.calls[0][0];
    expect(call.channelType).toBe('email');
  });

  it('omit skips the specified channel', async () => {
    const emailAdapter = makeEmailAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator: new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId: 'test-app',
    });

    await dispatcher.notify({ subject: 'Test', body: makeEvent() }, { omit: ['email'] });
    expect(emailAdapter.send).not.toHaveBeenCalled();
  });

  it('omit takes precedence over include', async () => {
    const emailAdapter = makeEmailAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator: new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId: 'test-app',
    });

    await dispatcher.notify(
      { subject: 'Test', body: makeEvent() },
      { include: ['email'], omit: ['email'] },
    );
    expect(emailAdapter.send).not.toHaveBeenCalled();
  });

  it('deduplicates identical (eventId, channelType) within window', async () => {
    const emailAdapter = makeEmailAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator: new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId: 'test-app',
    });

    const event = makeEvent();
    await dispatcher.notify({ subject: 'Test', body: event });
    await dispatcher.notify({ subject: 'Test', body: event });
    expect(emailAdapter.send).toHaveBeenCalledTimes(1);
  });

  it('uses originalEventId as dedup key for notification-failed events', async () => {
    const emailAdapter = makeEmailAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const deduplicator = new NotificationDeduplicator(60_000);
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator,
      trackerService: makeTrackerService(),
      appId: 'test-app',
    });

    const originalEvent = makeEvent({ id: 'evt-1' });
    await dispatcher.notify({ subject: 'Original', body: originalEvent });
    expect(emailAdapter.send).toHaveBeenCalledTimes(1);

    const failedEvent = makeEvent({
      id: 'evt-failed-1',
      category: NotificationCategory.NotificationFailed,
      payload: { originalEventId: 'evt-1', failedChannel: 'webhook' },
    });
    await dispatcher.notify({ subject: 'Retry', body: failedEvent });
    expect(emailAdapter.send).toHaveBeenCalledTimes(1);
  });

  it('include restricts dispatch to the specified channels only', async () => {
    const emailAdapter   = makeEmailAdapter();
    const webhookAdapter = makeWebhookAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email:   { adapter: emailAdapter,   recipients: ['ops@example.com'], from: 'noreply@example.com' },
      webhook: { adapter: webhookAdapter },
    };
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator:   new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId:          'test-app',
    });

    await dispatcher.notify({ subject: 'Test', body: makeEvent() }, { include: ['email'] });
    expect(emailAdapter.send).toHaveBeenCalledTimes(1);
    expect(webhookAdapter.send).not.toHaveBeenCalled();
  });

  it('records tracker error event on adapter failure', async () => {
    const emailAdapter = makeEmailAdapter(true);
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const trackerService = makeTrackerService();
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator: new NotificationDeduplicator(60_000),
      trackerService,
      appId: 'test-app',
    });

    await dispatcher.notify({ subject: 'Test', body: makeEvent() });
    expect(trackerService.track).toHaveBeenCalledTimes(1);
    const call = trackerService.track.mock.calls[0][0];
    expect(call.type).toBe('error');
    expect(call.category).toBe(NotificationCategory.NotificationFailed);
    expect(call.payload?.failedChannel).toBe('email');
  });
});

describe('NotificationDispatcher — Slack channel', () => {
  it('calls slack adapter with formatted payload', async () => {
    const slackAdapter = makeSlackAdapter();
    const channels: Partial<ChannelConfigMap> = {
      slack: { adapter: slackAdapter },
    };
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator:   new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId:          'test-app',
    });

    await dispatcher.notify({ subject: 'Slack alert', body: makeEvent() });
    expect(slackAdapter.send).toHaveBeenCalledTimes(1);
    const call = slackAdapter.send.mock.calls[0][0];
    expect(call.channelType).toBe('slack');
  });

  it('records error event when slack adapter fails', async () => {
    const slackAdapter   = makeSlackAdapter(true);
    const channels: Partial<ChannelConfigMap> = {
      slack: { adapter: slackAdapter },
    };
    const trackerService = makeTrackerService();
    const dispatcher     = new NotificationDispatcher({
      channels,
      deduplicator:   new NotificationDeduplicator(60_000),
      trackerService,
      appId:          'test-app',
    });

    await dispatcher.notify({ subject: 'Slack alert', body: makeEvent() });
    expect(trackerService.track).toHaveBeenCalledTimes(1);
    const failCall = trackerService.track.mock.calls[0][0];
    expect(failCall.payload?.failedChannel).toBe('slack');
  });
});

describe('NotificationDispatcher — Discord channel', () => {
  it('calls discord adapter with formatted payload', async () => {
    const discordAdapter = makeDiscordAdapter();
    const channels: Partial<ChannelConfigMap> = {
      discord: { adapter: discordAdapter },
    };
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator:   new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId:          'test-app',
    });

    await dispatcher.notify({ subject: 'Discord alert', body: makeEvent() });
    expect(discordAdapter.send).toHaveBeenCalledTimes(1);
    const call = discordAdapter.send.mock.calls[0][0];
    expect(call.channelType).toBe('discord');
  });

  it('records error event when discord adapter fails', async () => {
    const discordAdapter = makeDiscordAdapter(true);
    const channels: Partial<ChannelConfigMap> = {
      discord: { adapter: discordAdapter },
    };
    const trackerService = makeTrackerService();
    const dispatcher     = new NotificationDispatcher({
      channels,
      deduplicator:   new NotificationDeduplicator(60_000),
      trackerService,
      appId:          'test-app',
    });

    await dispatcher.notify({ subject: 'Discord alert', body: makeEvent() });
    expect(trackerService.track).toHaveBeenCalledTimes(1);
    expect(trackerService.track.mock.calls[0][0].payload?.failedChannel).toBe('discord');
  });
});

describe('NotificationDispatcher — email templates', () => {
  it('renders subject and body from templates', async () => {
    const emailAdapter = makeEmailAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const event      = makeEvent({ appId: 'my-app', message: 'disk full' });
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator:   new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId:          'test-app',
      templates: {
        email: {
          subject: 'Alert: {{event.appId}}',
          html:    '<p>{{event.message}}</p>',
          text:    '{{event.message}}',
        },
      },
    });

    await dispatcher.notify({ subject: 'Raw subject', body: event });

    expect(emailAdapter.send).toHaveBeenCalledTimes(1);
    const payload = (emailAdapter.send.mock.calls[0][0] as any).raw as any;
    expect(payload.subject).toBe('Alert: my-app');
    expect(payload.html).toBe('<p>disk full</p>');
    expect(payload.text).toBe('disk full');
  });
});
