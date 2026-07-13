import 'reflect-metadata';
import { AggregationPlugin } from '../../../../src/consumer/plugins/AggregationPlugin';
import { TrackerEventStatus } from '../../../../src/common/types';
import type { StoredTrackerEvent } from '../../../../src/common/types';
import type { ITrackerStorage } from '../../../../src/consumer/storage/ITrackerStorage';

function makeStorage(): jest.Mocked<ITrackerStorage> {
  return {
    save:         jest.fn().mockResolvedValue(undefined),
    saveBatch:    jest.fn().mockResolvedValue(undefined),
    find:         jest.fn().mockResolvedValue([]),
    findById:     jest.fn().mockResolvedValue(null),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    delete:       jest.fn().mockResolvedValue(undefined),
    distinct:     jest.fn().mockResolvedValue([]),
    clear:        jest.fn().mockResolvedValue(0),
  };
}

function makeEvent(overrides: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent {
  return {
    id:         'evt-1',
    type:       'error',
    message:    'boom',
    status:     TrackerEventStatus.New,
    timestamp:  Date.now(),
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe('AggregationPlugin', () => {
  it('buffers events and flushes with count after windowMs', async () => {
    jest.useFakeTimers();
    const storage = makeStorage();
    const plugin  = AggregationPlugin.create({ adapter: storage, windowMs: 1_000 });
    plugin.onInit({ track: jest.fn(), setStorage: jest.fn(), registerMetricsProvider: jest.fn() });

    const event = makeEvent();
    plugin.onEvent(event);
    plugin.onEvent(event);
    plugin.onEvent(event);

    expect(storage.save).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_001);
    await Promise.resolve(); // flush microtask queue

    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.save.mock.calls[0][0].count).toBe(3);
    jest.useRealTimers();
  });

  it('groups distinct events into separate buckets', async () => {
    jest.useFakeTimers();
    const storage = makeStorage();
    const plugin  = AggregationPlugin.create({ adapter: storage, windowMs: 1_000 });
    plugin.onInit({ track: jest.fn(), setStorage: jest.fn(), registerMetricsProvider: jest.fn() });

    plugin.onEvent(makeEvent({ message: 'err-a' }));
    plugin.onEvent(makeEvent({ message: 'err-b' }));

    jest.advanceTimersByTime(1_001);
    await Promise.resolve();

    expect(storage.save).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('onDestroy flushes buffered events and clears the timer', async () => {
    jest.useFakeTimers();
    const storage = makeStorage();
    const plugin  = AggregationPlugin.create({ adapter: storage, windowMs: 60_000 });
    plugin.onInit({ track: jest.fn(), setStorage: jest.fn(), registerMetricsProvider: jest.fn() });

    plugin.onEvent(makeEvent());
    plugin.onEvent(makeEvent());

    await plugin.onDestroy();

    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.save.mock.calls[0][0].count).toBe(2);
    jest.useRealTimers();
  });

  it('respects a custom key function', async () => {
    jest.useFakeTimers();
    const storage = makeStorage();
    const plugin  = AggregationPlugin.create({
      adapter:  storage,
      windowMs: 1_000,
      key:      (e) => e.type, // all events of same type aggregated together
    });
    plugin.onInit({ track: jest.fn(), setStorage: jest.fn(), registerMetricsProvider: jest.fn() });

    plugin.onEvent(makeEvent({ message: 'msg-a' }));
    plugin.onEvent(makeEvent({ message: 'msg-b' }));

    jest.advanceTimersByTime(1_001);
    await Promise.resolve();

    // Both events have type='error' so they merge into one bucket
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.save.mock.calls[0][0].count).toBe(2);
    jest.useRealTimers();
  });

  it('does nothing on flush when buffer is empty', async () => {
    const storage = makeStorage();
    const plugin  = AggregationPlugin.create({ adapter: storage, windowMs: 1_000 });
    await plugin.onDestroy();
    expect(storage.save).not.toHaveBeenCalled();
  });
});
