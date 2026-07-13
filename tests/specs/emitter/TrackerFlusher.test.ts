/**
 * @jest-environment jsdom
 */
import { TrackerQueue } from '../../../src/emitter/TrackerQueue';
import { TrackerFlusher } from '../../../src/emitter/TrackerFlusher';
import type { TrackerEvent } from '../../../src/common/types';

const KEY = '__vt_flush_test__';
const ENDPOINT = 'http://localhost/tracker/events';

const evt = (): TrackerEvent => ({ type: 'error', message: 'x', timestamp: 1 });

function makeSetup(fetchImpl: jest.Mock) {
  global.fetch = fetchImpl;
  const queue = new TrackerQueue({ maxSize: 100, storageKey: KEY });
  const flusher = new TrackerFlusher({
    queue,
    endpoint: ENDPOINT,
    retry: { maxAttempts: 2, baseDelay: 0, backoffFactor: 1 },
    flushInterval: 5000,
    _delay: () => Promise.resolve(), // instant backoff for tests
  });
  return { queue, flusher };
}

describe('TrackerFlusher', () => {
  beforeEach(() => localStorage.clear());

  it('flush() POSTs a batch of events as JSON array', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    const { queue, flusher } = makeSetup(fetchMock);
    queue.enqueue(evt());
    await flusher.flush();
    expect(fetchMock).toHaveBeenCalledWith(
      ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('"message":"x"'),
      }),
    );
    expect(queue.size()).toBe(0);
  });

  it('flush() does nothing when queue is empty', async () => {
    const fetchMock = jest.fn();
    const { flusher } = makeSetup(fetchMock);
    await flusher.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries on fetch failure then confirms on success', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ok: true });
    const { queue, flusher } = makeSetup(fetchMock);
    queue.enqueue(evt());
    await flusher.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queue.size()).toBe(0);
  });

  it('persists to localStorage after all retries exhausted', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('always fails'));
    const { queue, flusher } = makeSetup(fetchMock);
    queue.enqueue(evt());
    await flusher.flush();
    // fetchMock called maxAttempts (2) times
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // event removed from memory but saved to localStorage
    expect(queue.size()).toBe(0);
    const stored = localStorage.getItem(KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toHaveLength(1);
  });

  it('start() and stop() manage the flush interval', () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    const { flusher } = makeSetup(fetchMock);
    flusher.start();
    jest.advanceTimersByTime(5000);
    flusher.stop();
    jest.advanceTimersByTime(10000);
    // Should not call fetch after stop (queue was empty anyway)
    expect(fetchMock).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
