import 'reflect-metadata';
import { RetentionPlugin } from '../../../../src/consumer/plugins/RetentionPlugin';
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

function makeOldEvent(id: string): StoredTrackerEvent {
  const tenDaysAgo = Date.now() - 10 * 86_400_000;
  return {
    id,
    type:       'error',
    message:    'old',
    status:     TrackerEventStatus.New,
    timestamp:  tenDaysAgo,
    receivedAt: tenDaysAgo,
  };
}

describe('RetentionPlugin', () => {
  it('purges events older than maxAgeDays', async () => {
    const storage = makeStorage();
    storage.find.mockResolvedValue([makeOldEvent('old-1'), makeOldEvent('old-2')]);

    const plugin = RetentionPlugin.create({ adapter: storage, maxAgeDays: 7 });
    // Invoke purge directly by triggering onDestroy (timer never fires in unit tests)
    // Instead, call the private method via a workaround: short scheduleMs + fake timers
    jest.useFakeTimers();
    plugin.onInit({ track: jest.fn(), setStorage: jest.fn(), registerMetricsProvider: jest.fn() });

    jest.advanceTimersByTime(3_600_001); // trigger first purge
    await Promise.resolve();
    await Promise.resolve(); // allow inner async calls

    expect(storage.find).toHaveBeenCalled();
    const findCall = storage.find.mock.calls[0][0] as any;
    expect(findCall.to).toBeLessThan(Date.now());
    expect(findCall.limit).toBe(1_000);

    expect(storage.delete).toHaveBeenCalledWith('old-1');
    expect(storage.delete).toHaveBeenCalledWith('old-2');
    jest.useRealTimers();
  });

  it('respects a filter — skips events that do not match', async () => {
    const storage = makeStorage();
    const infoEvent = makeOldEvent('info-1');
    infoEvent.type  = 'info';
    const errEvent  = makeOldEvent('err-1');
    storage.find.mockResolvedValue([infoEvent, errEvent]);

    jest.useFakeTimers();
    const plugin = RetentionPlugin.create({
      adapter:    storage,
      maxAgeDays: 7,
      filter:     { type: ['error'] }, // only purge errors
    });
    plugin.onInit({ track: jest.fn(), setStorage: jest.fn(), registerMetricsProvider: jest.fn() });

    jest.advanceTimersByTime(3_600_001);
    await Promise.resolve();
    await Promise.resolve();

    expect(storage.delete).toHaveBeenCalledWith('err-1');
    expect(storage.delete).not.toHaveBeenCalledWith('info-1');
    jest.useRealTimers();
  });

  it('respects a custom scheduleMs', async () => {
    const storage = makeStorage();
    storage.find.mockResolvedValue([]);

    jest.useFakeTimers();
    const plugin = RetentionPlugin.create({
      adapter:     storage,
      maxAgeDays:  7,
      scheduleMs:  500,
    });
    plugin.onInit({ track: jest.fn(), setStorage: jest.fn(), registerMetricsProvider: jest.fn() });

    jest.advanceTimersByTime(499);
    expect(storage.find).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2);
    await Promise.resolve();
    expect(storage.find).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('onDestroy clears the timer', async () => {
    const storage = makeStorage();
    jest.useFakeTimers();
    const plugin = RetentionPlugin.create({ adapter: storage, maxAgeDays: 7 });
    plugin.onInit({ track: jest.fn(), setStorage: jest.fn(), registerMetricsProvider: jest.fn() });
    await plugin.onDestroy();

    jest.advanceTimersByTime(10_000_000);
    expect(storage.find).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('onEvent is a no-op and does not throw', () => {
    const plugin = RetentionPlugin.create({ adapter: makeStorage(), maxAgeDays: 7 });
    expect(() =>
      plugin.onEvent(makeOldEvent('x')),
    ).not.toThrow();
  });
});
