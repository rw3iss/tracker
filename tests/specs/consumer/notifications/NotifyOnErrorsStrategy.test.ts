import { NotifyOnErrorsStrategy } from '../../../../src/consumer/notifications/strategies/NotifyOnErrorsStrategy';
import { NotificationCategory } from '../../../../src/consumer/notifications/NotificationCategory';
import { TrackerEventStatus } from '../../../../src/common/types';
import type { StoredTrackerEvent } from '../../../../src/common/types';
import type { NotificationDispatcher } from '../../../../src/consumer/notifications/NotificationDispatcher';

function makeEvent(overrides: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent {
  return {
    id: 'evt-1', type: 'error', message: 'something broke',
    status: TrackerEventStatus.New, timestamp: Date.now(), receivedAt: Date.now(),
    ...overrides,
  };
}

function makeDispatcher() {
  return { notify: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<NotificationDispatcher>;
}

describe('NotifyOnErrorsStrategy', () => {
  it('calls dispatcher.notify for error events', async () => {
    const strategy   = new NotifyOnErrorsStrategy();
    const dispatcher = makeDispatcher();
    await strategy.onEvent(makeEvent({ type: 'error' }), dispatcher);
    expect(dispatcher.notify).toHaveBeenCalledTimes(1);
  });

  it('skips non-error events', async () => {
    const strategy   = new NotifyOnErrorsStrategy();
    const dispatcher = makeDispatcher();
    await strategy.onEvent(makeEvent({ type: 'info' }), dispatcher);
    expect(dispatcher.notify).not.toHaveBeenCalled();
  });

  it('includes email and webhook in opts.include', async () => {
    const strategy   = new NotifyOnErrorsStrategy();
    const dispatcher = makeDispatcher();
    await strategy.onEvent(makeEvent(), dispatcher);
    const opts = dispatcher.notify.mock.calls[0][1];
    expect(opts?.include).toContain('email');
    expect(opts?.include).toContain('webhook');
  });

  it('omits the failed channel for notification-failed events', async () => {
    const strategy   = new NotifyOnErrorsStrategy();
    const dispatcher = makeDispatcher();
    const event = makeEvent({
      category: NotificationCategory.NotificationFailed,
      payload: { failedChannel: 'email', originalEventId: 'evt-0' },
    });
    await strategy.onEvent(event, dispatcher);
    const opts = dispatcher.notify.mock.calls[0][1];
    expect(opts?.omit).toContain('email');
  });
});
