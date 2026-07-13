import { NotificationRetryWorker } from '../../../../src/consumer/notifications/NotificationRetryWorker';
import type {
  IUnsentNotificationStorage,
  StoredUnsentNotification,
} from '../../../../src/consumer/notifications/storage/IUnsentNotificationStorage';

function makeStorage(): jest.Mocked<IUnsentNotificationStorage> {
  return {
    save:        jest.fn().mockResolvedValue(undefined),
    findPending: jest.fn().mockResolvedValue([]),
    markRetried: jest.fn().mockResolvedValue(undefined),
    delete:      jest.fn().mockResolvedValue(undefined),
  };
}

function makeRecord(overrides: Partial<StoredUnsentNotification> = {}): StoredUnsentNotification {
  return {
    id:               'notif-1',
    channelType:      'email',
    recipientInfo:    '["ops@example.com"]',
    formattedPayload: '{}',
    errorMessage:     'smtp timeout',
    retryCount:       0,
    createdAt:        new Date(),
    ...overrides,
  };
}

describe('NotificationRetryWorker', () => {
  it('poll() calls send for each pending notification', async () => {
    const storage = makeStorage();
    storage.findPending.mockResolvedValue([makeRecord()]);
    const send  = jest.fn().mockResolvedValue(undefined);
    const worker = NotificationRetryWorker.create({ storage, send });

    await worker.poll();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].id).toBe('notif-1');
  });

  it('poll() deletes notification after successful send', async () => {
    const storage = makeStorage();
    storage.findPending.mockResolvedValue([makeRecord()]);
    const send  = jest.fn().mockResolvedValue(undefined);
    const worker = NotificationRetryWorker.create({ storage, send });

    await worker.poll();
    expect(storage.delete).toHaveBeenCalledWith('notif-1');
  });

  it('poll() calls markRetried on send failure', async () => {
    const storage = makeStorage();
    storage.findPending.mockResolvedValue([makeRecord()]);
    const send    = jest.fn().mockRejectedValue(new Error('connection refused'));
    const worker  = NotificationRetryWorker.create({ storage, send });

    await worker.poll();
    expect(storage.markRetried).toHaveBeenCalledWith('notif-1', 'connection refused');
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('poll() deletes notifications that have exceeded maxRetries', async () => {
    const storage = makeStorage();
    storage.findPending.mockResolvedValue([makeRecord({ retryCount: 5 })]);
    const send    = jest.fn().mockResolvedValue(undefined);
    const worker  = NotificationRetryWorker.create({ storage, send, maxRetries: 5 });

    await worker.poll();
    expect(storage.delete).toHaveBeenCalledWith('notif-1');
    expect(send).not.toHaveBeenCalled();
  });

  it('poll() processes batchSize records at most', async () => {
    const storage = makeStorage();
    const records = Array.from({ length: 10 }, (_, i) => makeRecord({ id: `notif-${i}` }));
    storage.findPending.mockResolvedValue(records);
    const send    = jest.fn().mockResolvedValue(undefined);
    const worker  = NotificationRetryWorker.create({ storage, send, batchSize: 3 });

    await worker.poll();
    // findPending is called with batchSize
    expect(storage.findPending).toHaveBeenCalledWith(3);
  });

  it('start()/stop() control the interval timer', () => {
    jest.useFakeTimers();
    const storage = makeStorage();
    const send    = jest.fn().mockResolvedValue(undefined);
    const worker  = NotificationRetryWorker.create({ storage, send, intervalMs: 1_000 });

    worker.start();
    jest.advanceTimersByTime(2_500);
    expect(storage.findPending.mock.calls.length).toBeGreaterThanOrEqual(2);

    storage.findPending.mockClear();
    worker.stop();
    jest.advanceTimersByTime(5_000);
    expect(storage.findPending).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('start() is idempotent — calling twice does not double-fire', () => {
    jest.useFakeTimers();
    const storage = makeStorage();
    const send    = jest.fn().mockResolvedValue(undefined);
    const worker  = NotificationRetryWorker.create({ storage, send, intervalMs: 1_000 });

    worker.start();
    worker.start();
    jest.advanceTimersByTime(1_001);
    // should only fire once despite two start() calls
    expect(storage.findPending.mock.calls.length).toBe(1);
    worker.stop();
    jest.useRealTimers();
  });
});
