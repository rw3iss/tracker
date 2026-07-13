import 'reflect-metadata';
import { ForwardingPlugin } from '../../../../src/consumer/plugins/ForwardingPlugin';
import { TrackerEventStatus } from '../../../../src/common/types';
import type { StoredTrackerEvent } from '../../../../src/common/types';

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn().mockResolvedValue({ ok: true });
  global.fetch = fetchMock;
});

afterEach(() => {
  jest.restoreAllMocks();
});

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

describe('ForwardingPlugin', () => {
  it('POSTs a single event to the configured endpoint', async () => {
    const plugin = ForwardingPlugin.create({ endpoint: 'https://example.com/hook' });
    await plugin.onEvent(makeEvent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body).type).toBe('error');
  });

  it('sends custom headers', async () => {
    const plugin = ForwardingPlugin.create({
      endpoint: 'https://example.com/hook',
      headers:  { 'X-Api-Key': 'secret' },
    });
    await plugin.onEvent(makeEvent());
    const opts = fetchMock.mock.calls[0][1];
    expect(opts.headers['X-Api-Key']).toBe('secret');
  });

  it('skips events that do not pass the filter', async () => {
    const plugin = ForwardingPlugin.create({
      endpoint: 'https://example.com/hook',
      filter:   { type: ['error'] },
    });
    await plugin.onEvent(makeEvent({ type: 'info' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes events that match the filter', async () => {
    const plugin = ForwardingPlugin.create({
      endpoint: 'https://example.com/hook',
      filter:   { type: ['error'] },
    });
    await plugin.onEvent(makeEvent({ type: 'error' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('buffers events until batchSize is reached', async () => {
    const plugin = ForwardingPlugin.create({
      endpoint:  'https://example.com/hook',
      batchSize: 3,
    });
    await plugin.onEvent(makeEvent());
    await plugin.onEvent(makeEvent());
    expect(fetchMock).not.toHaveBeenCalled();

    await plugin.onEvent(makeEvent());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(3);
  });

  it('onDestroy flushes remaining buffered events', async () => {
    const plugin = ForwardingPlugin.create({
      endpoint:  'https://example.com/hook',
      batchSize: 10,
    });
    await plugin.onEvent(makeEvent());
    await plugin.onEvent(makeEvent());
    expect(fetchMock).not.toHaveBeenCalled();

    await plugin.onDestroy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('swallows fetch errors without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('network error'));
    const plugin = ForwardingPlugin.create({ endpoint: 'https://example.com/hook' });
    await expect(plugin.onEvent(makeEvent())).resolves.toBeUndefined();
  });

  it('aborts fetch when timeoutMs elapses', async () => {
    let aborted = false;
    fetchMock.mockImplementation((_url: string, opts: any) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('AbortError'));
        });
      });
    });

    jest.useFakeTimers();
    const plugin = ForwardingPlugin.create({
      endpoint:  'https://example.com/hook',
      timeoutMs: 100,
    });
    const promise = plugin.onEvent(makeEvent());
    jest.advanceTimersByTime(101);
    await promise; // resolves because ForwardingPlugin swallows the error
    expect(aborted).toBe(true);
    jest.useRealTimers();
  });
});
