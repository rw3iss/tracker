import { DefaultStrategy } from '../../../../src/consumer/notifications/strategies/DefaultStrategy';
import { TrackerEventStatus } from '../../../../src/common/types';
import type { StoredTrackerEvent } from '../../../../src/common/types';
import type { NotificationDispatcher } from '../../../../src/consumer/notifications/NotificationDispatcher';

function makeEvent(overrides: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent {
  return {
    id: 'e1', type: 'error', message: 'boom',
    status: TrackerEventStatus.New, timestamp: 1, receivedAt: 1,
    ...overrides,
  };
}

function makeDispatcher(): jest.Mocked<Pick<NotificationDispatcher, 'notify'>> {
  return { notify: jest.fn().mockResolvedValue(undefined) };
}

describe('DefaultStrategy', () => {
  it('calls dispatcher.notify with default subject template', async () => {
    const strategy   = new DefaultStrategy();
    const dispatcher = makeDispatcher();
    await strategy.onEvent(makeEvent({ type: 'error', message: 'DB down' }), dispatcher as any);
    expect(dispatcher.notify).toHaveBeenCalledTimes(1);
    const [data, opts] = dispatcher.notify.mock.calls[0];
    expect(data.subject).toBe('[error] DB down');
    expect(opts).toBeUndefined();
  });

  it('resolves custom subject template', async () => {
    const strategy   = new DefaultStrategy({ subject: 'ALERT: {{type}} — {{message}}' });
    const dispatcher = makeDispatcher();
    await strategy.onEvent(makeEvent({ type: 'warning', message: 'high latency' }), dispatcher as any);
    expect(dispatcher.notify.mock.calls[0][0].subject).toBe('ALERT: warning — high latency');
  });

  it('passes include: channels when channels config is set', async () => {
    const strategy   = new DefaultStrategy({ channels: ['email', 'webhook'] });
    const dispatcher = makeDispatcher();
    await strategy.onEvent(makeEvent(), dispatcher as any);
    const [, opts] = dispatcher.notify.mock.calls[0];
    expect(opts).toEqual({ include: ['email', 'webhook'] });
  });

  it('passes no dispatch options when channels is not configured', async () => {
    const strategy   = new DefaultStrategy();
    const dispatcher = makeDispatcher();
    await strategy.onEvent(makeEvent(), dispatcher as any);
    const [, opts] = dispatcher.notify.mock.calls[0];
    expect(opts).toBeUndefined();
  });

  it('exposes events from config as a readonly property', () => {
    const strategy = new DefaultStrategy({ events: ['error', 'warning'] });
    expect(strategy.events).toEqual(['error', 'warning']);
  });

  it('exposes channels from config as a readonly property', () => {
    const strategy = new DefaultStrategy({ channels: ['sms'] });
    expect(strategy.channels).toEqual(['sms']);
  });

  it('truncates long messages to 100 characters in subject', async () => {
    const longMessage = 'x'.repeat(150);
    const strategy   = new DefaultStrategy();
    const dispatcher = makeDispatcher();
    await strategy.onEvent(makeEvent({ message: longMessage }), dispatcher as any);
    const subject = dispatcher.notify.mock.calls[0][0].subject;
    // '[error] ' + 100 chars = 108 chars max
    expect(subject).toBe(`[error] ${'x'.repeat(100)}`);
  });

  it('passes event body to dispatcher.notify', async () => {
    const event      = makeEvent({ message: 'test' });
    const strategy   = new DefaultStrategy();
    const dispatcher = makeDispatcher();
    await strategy.onEvent(event, dispatcher as any);
    expect(dispatcher.notify.mock.calls[0][0].body).toBe(event);
  });
});
