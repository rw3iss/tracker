import { TrackerNotificationsPlugin } from '../../../../src/consumer/notifications/TrackerNotificationsPlugin';
import { TrackerEventStatus } from '../../../../src/common/types';
import type { StoredTrackerEvent } from '../../../../src/common/types';
import type { ITrackerServiceRef } from '../../../../src/consumer/ITrackerPlugin';
import type { INotificationStrategy } from '../../../../src/consumer/notifications/INotificationStrategy';
import type { NotificationDispatcher } from '../../../../src/consumer/notifications/NotificationDispatcher';

function makeEvent(): StoredTrackerEvent {
  return {
    id: 'evt-1', type: 'error', message: 'boom',
    status: TrackerEventStatus.New, timestamp: 1, receivedAt: 1,
  };
}

function makeTrackerService(): jest.Mocked<ITrackerServiceRef> {
  return {
    track:                   jest.fn().mockResolvedValue(undefined),
    setStorage:              jest.fn(),
    registerMetricsProvider: jest.fn(),
  };
}

function makeStrategy(): jest.Mocked<INotificationStrategy> {
  return { onEvent: jest.fn().mockResolvedValue(undefined) };
}

describe('TrackerNotificationsPlugin', () => {
  it('onInit stores tracker service reference', async () => {
    const strategy = makeStrategy();
    const plugin   = TrackerNotificationsPlugin.create({ strategies: [strategy] });
    const svc      = makeTrackerService();
    await plugin.onInit(svc);
    await plugin.onEvent(makeEvent());
    expect(strategy.onEvent).toHaveBeenCalledTimes(1);
  });

  it('onEvent calls all strategies independently', async () => {
    const s1 = makeStrategy();
    const s2 = makeStrategy();
    const plugin = TrackerNotificationsPlugin.create({ strategies: [s1, s2] });
    await plugin.onInit(makeTrackerService());
    await plugin.onEvent(makeEvent());
    expect(s1.onEvent).toHaveBeenCalledTimes(1);
    expect(s2.onEvent).toHaveBeenCalledTimes(1);
  });

  it('onEvent continues even if one strategy throws', async () => {
    const s1 = makeStrategy();
    s1.onEvent.mockRejectedValue(new Error('strategy failed'));
    const s2 = makeStrategy();
    const plugin = TrackerNotificationsPlugin.create({ strategies: [s1, s2] });
    await plugin.onInit(makeTrackerService());
    await expect(plugin.onEvent(makeEvent())).resolves.toBeUndefined();
    expect(s2.onEvent).toHaveBeenCalledTimes(1);
  });

  it('throws if onEvent called before onInit', async () => {
    const plugin = TrackerNotificationsPlugin.create({ strategies: [] });
    await expect(plugin.onEvent(makeEvent())).rejects.toThrow('TrackerNotificationsPlugin.onInit');
  });

  it('plugin-level events filter skips non-matching event types', async () => {
    const strategy = makeStrategy();
    const plugin   = TrackerNotificationsPlugin.create({ strategies: [strategy], events: ['error'] });
    await plugin.onInit(makeTrackerService());

    await plugin.onEvent({ ...makeEvent(), type: 'info' });
    expect(strategy.onEvent).not.toHaveBeenCalled();

    await plugin.onEvent(makeEvent()); // type: 'error'
    expect(strategy.onEvent).toHaveBeenCalledTimes(1);
  });

  it('strategy-level events override plugin-level events', async () => {
    const s1 = { onEvent: jest.fn().mockResolvedValue(undefined), events: ['warning' as const] };
    const s2 = makeStrategy();
    const plugin = TrackerNotificationsPlugin.create({
      strategies: [s1, s2],
      events: ['error'],
    });
    await plugin.onInit(makeTrackerService());

    await plugin.onEvent(makeEvent()); // type: 'error'
    expect(s1.onEvent).not.toHaveBeenCalled(); // s1 only accepts 'warning'
    expect(s2.onEvent).toHaveBeenCalledTimes(1); // s2 inherits plugin events: ['error']
  });

  it('strategy with no events and no plugin events runs for all types', async () => {
    const strategy = makeStrategy();
    const plugin   = TrackerNotificationsPlugin.create({ strategies: [strategy] });
    await plugin.onInit(makeTrackerService());

    await plugin.onEvent({ ...makeEvent(), type: 'info' });
    await plugin.onEvent({ ...makeEvent(), type: 'warning' });
    await plugin.onEvent(makeEvent()); // type: 'error'
    expect(strategy.onEvent).toHaveBeenCalledTimes(3);
  });
});
