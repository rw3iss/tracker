import { NotificationDeduplicator } from '../../../../src/consumer/notifications/NotificationDeduplicator';
import { TrackerEventStatus } from '../../../../src/common/types';
import type { StoredTrackerEvent } from '../../../../src/common/types';

function makeEvent(overrides: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent {
  return {
    id:         'evt-1',
    type:       'error',
    message:    'something broke',
    status:     TrackerEventStatus.New,
    timestamp:  Date.now(),
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe('NotificationDeduplicator', () => {
  it('returns false on first call (not seen)', () => {
    const d = new NotificationDeduplicator(60_000);
    expect(d.seen('evt-1:email')).toBe(false);
  });

  it('returns true on second call within window (seen)', () => {
    const d = new NotificationDeduplicator(60_000);
    d.seen('evt-1:email');
    expect(d.seen('evt-1:email')).toBe(true);
  });

  it('returns false after window expires', () => {
    jest.useFakeTimers();
    const d = new NotificationDeduplicator(500);
    d.seen('evt-1:email');
    jest.advanceTimersByTime(501);
    expect(d.seen('evt-1:email')).toBe(false);
    jest.useRealTimers();
  });

  it('different keys do not collide', () => {
    const d = new NotificationDeduplicator(60_000);
    d.seen('evt-1:email');
    expect(d.seen('evt-1:sms')).toBe(false);
    expect(d.seen('evt-2:email')).toBe(false);
  });

  it('clear() resets all entries', () => {
    const d = new NotificationDeduplicator(60_000);
    d.seen('evt-1:email');
    d.clear();
    expect(d.seen('evt-1:email')).toBe(false);
  });
});

describe('NotificationDeduplicator — coarse deduplication', () => {
  it('seenCoarse always returns false when no coarseConfig is provided', () => {
    const d = new NotificationDeduplicator(60_000);
    expect(d.seenCoarse(makeEvent())).toBe(false);
    expect(d.seenCoarse(makeEvent())).toBe(false);
  });

  it('seenCoarse returns false on first call and true on second for same type+message', () => {
    const d     = new NotificationDeduplicator(60_000, { windowMs: 60_000 });
    const event = makeEvent();
    expect(d.seenCoarse(event)).toBe(false);
    expect(d.seenCoarse(event)).toBe(true);
  });

  it('seenCoarse does not collide across different type+message combos', () => {
    const d = new NotificationDeduplicator(60_000, { windowMs: 60_000 });
    d.seenCoarse(makeEvent({ type: 'error', message: 'err-a' }));
    expect(d.seenCoarse(makeEvent({ type: 'error', message: 'err-b' }))).toBe(false);
    expect(d.seenCoarse(makeEvent({ type: 'info',  message: 'err-a' }))).toBe(false);
  });

  it('seenCoarse uses the default key: type + message prefix', () => {
    const d = new NotificationDeduplicator(60_000, { windowMs: 60_000 });
    // Two events with same type+message are considered coarse duplicates
    d.seenCoarse(makeEvent({ type: 'warning', message: 'quota exceeded' }));
    expect(d.seenCoarse(makeEvent({ type: 'warning', message: 'quota exceeded' }))).toBe(true);
  });

  it('seenCoarse respects the coarse window expiry', () => {
    jest.useFakeTimers();
    const d = new NotificationDeduplicator(60_000, { windowMs: 500 });
    const event = makeEvent();
    d.seenCoarse(event);
    jest.advanceTimersByTime(501);
    expect(d.seenCoarse(event)).toBe(false);
    jest.useRealTimers();
  });

  it('seenCoarse supports a custom key function', () => {
    const d = new NotificationDeduplicator(60_000, {
      windowMs: 60_000,
      key:      (e) => e.appId ?? 'no-app',
    });
    // Same appId → same coarse key → second call returns true
    d.seenCoarse(makeEvent({ appId: 'app-a' }));
    expect(d.seenCoarse(makeEvent({ appId: 'app-a' }))).toBe(true);
    // Different appId → independent
    expect(d.seenCoarse(makeEvent({ appId: 'app-b' }))).toBe(false);
  });

  it('clear() also resets the coarse map', () => {
    const d = new NotificationDeduplicator(60_000, { windowMs: 60_000 });
    const event = makeEvent();
    d.seenCoarse(event);
    d.clear();
    expect(d.seenCoarse(event)).toBe(false);
  });
});
