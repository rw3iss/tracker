/**
 * @jest-environment jsdom
 */
import { RateLimiter } from '../../../src/emitter/RateLimiter';

describe('RateLimiter', () => {
  it('allow() returns true when no config is set for the event type', () => {
    const limiter = new RateLimiter({}, jest.fn());
    expect(limiter.allow('error')).toBe(true);
  });

  it('allow() returns true while within burst capacity', () => {
    const limiter = new RateLimiter({ error: { capacity: 3, refillPerSec: 0 } }, jest.fn());
    expect(limiter.allow('error')).toBe(true);
    expect(limiter.allow('error')).toBe(true);
    expect(limiter.allow('error')).toBe(true);
  });

  it('allow() returns false when capacity is exhausted', () => {
    const limiter = new RateLimiter({ error: { capacity: 2, refillPerSec: 0 } }, jest.fn());
    limiter.allow('error');
    limiter.allow('error');
    expect(limiter.allow('error')).toBe(false);
  });

  it('tracks dropped events separately per type', () => {
    const onSummary = jest.fn();
    const limiter   = new RateLimiter({
      error:   { capacity: 1, refillPerSec: 0 },
      warning: { capacity: 2, refillPerSec: 0 },
    }, onSummary);

    limiter.allow('error');
    limiter.allow('error'); // dropped
    limiter.allow('warning');
    limiter.allow('warning');
    limiter.allow('warning'); // dropped

    limiter.stop();
    expect(onSummary).toHaveBeenCalledWith({ error: 1, warning: 1 });
  });

  it('refills tokens over time', () => {
    jest.useFakeTimers();
    const limiter = new RateLimiter({ error: { capacity: 1, refillPerSec: 10 } }, jest.fn());
    limiter.allow('error'); // consume the token
    expect(limiter.allow('error')).toBe(false);

    jest.advanceTimersByTime(200); // 0.2s → 2 tokens refilled
    expect(limiter.allow('error')).toBe(true);
    jest.useRealTimers();
  });

  it('start() fires the summary callback at the configured interval', () => {
    jest.useFakeTimers();
    const onSummary = jest.fn();
    const limiter   = new RateLimiter({
      info: { capacity: 0, refillPerSec: 0 },
      summaryIntervalMs: 500,
    }, onSummary);

    limiter.allow('info'); // dropped
    limiter.start();
    jest.advanceTimersByTime(501);
    expect(onSummary).toHaveBeenCalledTimes(1);
    limiter.stop();
    jest.useRealTimers();
  });

  it('stop() does not fire summary when no events were dropped', () => {
    const onSummary = jest.fn();
    const limiter   = new RateLimiter({ error: { capacity: 10, refillPerSec: 1 } }, onSummary);
    limiter.allow('error');
    limiter.stop();
    expect(onSummary).not.toHaveBeenCalled();
  });

  it('stop() emits a final summary when events were dropped', () => {
    const onSummary = jest.fn();
    const limiter   = new RateLimiter({ error: { capacity: 1, refillPerSec: 0 } }, onSummary);
    limiter.allow('error'); // ok
    limiter.allow('error'); // dropped
    limiter.stop();
    expect(onSummary).toHaveBeenCalledWith({ error: 1 });
  });

  it('start() with summaryIntervalMs=0 does not start a timer', () => {
    jest.useFakeTimers();
    const onSummary = jest.fn();
    const limiter   = new RateLimiter({ summaryIntervalMs: 0, error: { capacity: 1, refillPerSec: 0 } }, onSummary);
    limiter.allow('error');
    limiter.allow('error'); // dropped
    limiter.start();
    jest.advanceTimersByTime(100_000);
    // onSummary fires on stop, not via interval
    expect(onSummary).not.toHaveBeenCalled();
    limiter.stop();
    jest.useRealTimers();
  });

  it('does not start a second timer if start() is called twice', () => {
    jest.useFakeTimers();
    const onSummary = jest.fn();
    const limiter   = new RateLimiter({
      error: { capacity: 0, refillPerSec: 0 },
      summaryIntervalMs: 500,
    }, onSummary);

    limiter.allow('error'); // drop
    limiter.start();
    limiter.start(); // second call — no-op
    jest.advanceTimersByTime(501);
    expect(onSummary).toHaveBeenCalledTimes(1);
    limiter.stop();
    jest.useRealTimers();
  });
});
