import 'reflect-metadata';
import { RateLimitPlugin } from '../../../../src/consumer/plugins/RateLimitPlugin';
import type { TrackerEvent } from '../../../../src/common/types';
import type { IngestContext } from '../../../../src/consumer/ITrackerPlugin';

const baseEvent: TrackerEvent = { type: 'error', message: 'boom', timestamp: 1 };
const ctx: IngestContext = { ip: '1.2.3.4' };

describe('RateLimitPlugin', () => {
  it('allows events within the window limit', () => {
    const plugin = RateLimitPlugin.create({ windowMs: 1_000, maxEvents: 3 });
    expect(plugin.onIngest(baseEvent, ctx)).not.toBeNull();
    expect(plugin.onIngest(baseEvent, ctx)).not.toBeNull();
    expect(plugin.onIngest(baseEvent, ctx)).not.toBeNull();
  });

  it('returns null when maxEvents is exceeded', () => {
    const plugin = RateLimitPlugin.create({ windowMs: 1_000, maxEvents: 2 });
    plugin.onIngest(baseEvent, ctx);
    plugin.onIngest(baseEvent, ctx);
    expect(plugin.onIngest(baseEvent, ctx)).toBeNull();
  });

  it('resets the window after windowMs elapses', () => {
    jest.useFakeTimers();
    const plugin = RateLimitPlugin.create({ windowMs: 500, maxEvents: 1 });
    plugin.onIngest(baseEvent, ctx);
    expect(plugin.onIngest(baseEvent, ctx)).toBeNull();
    jest.advanceTimersByTime(501);
    expect(plugin.onIngest(baseEvent, ctx)).not.toBeNull();
    jest.useRealTimers();
  });

  it('uses appId as the default rate-limit key', () => {
    const plugin = RateLimitPlugin.create({ windowMs: 1_000, maxEvents: 1 });
    const appEvent: TrackerEvent = { ...baseEvent, appId: 'app-a' };
    plugin.onIngest(appEvent, ctx);
    // Second call for same appId should be rejected
    expect(plugin.onIngest(appEvent, ctx)).toBeNull();
    // Different appId has its own window
    const appBEvent: TrackerEvent = { ...baseEvent, appId: 'app-b' };
    expect(plugin.onIngest(appBEvent, ctx)).not.toBeNull();
  });

  it('uses ctx.ip as key when appId is absent', () => {
    const plugin = RateLimitPlugin.create({ windowMs: 1_000, maxEvents: 1 });
    plugin.onIngest(baseEvent, ctx);
    expect(plugin.onIngest(baseEvent, ctx)).toBeNull();
    // Different IP is independent
    expect(plugin.onIngest(baseEvent, { ip: '9.9.9.9' })).not.toBeNull();
  });

  it('respects a custom keyFn', () => {
    const plugin = RateLimitPlugin.create({
      windowMs:  1_000,
      maxEvents: 1,
      keyFn:     (e) => e.type,
    });
    plugin.onIngest(baseEvent, ctx);
    expect(plugin.onIngest(baseEvent, ctx)).toBeNull();
    // Different type has its own window
    const infoEvent: TrackerEvent = { ...baseEvent, type: 'info' };
    expect(plugin.onIngest(infoEvent, ctx)).not.toBeNull();
  });

  it('onEvent is a no-op and does not throw', () => {
    const plugin = RateLimitPlugin.create({ windowMs: 1_000, maxEvents: 5 });
    expect(() =>
      plugin.onEvent({
        ...baseEvent,
        id: 'x', status: 'new' as any, receivedAt: 0,
      }),
    ).not.toThrow();
  });
});
