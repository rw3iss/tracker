import type { IUnsentNotificationStorage, StoredUnsentNotification } from './storage/IUnsentNotificationStorage';

export interface NotificationRetryWorkerConfig {
  storage:      IUnsentNotificationStorage;
  intervalMs?:  number;  // default: 60_000
  maxRetries?:  number;  // default: 5, then delete
  batchSize?:   number;  // default: 50
  /** Called to resend a notification. Throw to mark as retry-failed. */
  send: (notification: StoredUnsentNotification) => Promise<void>;
}

export class NotificationRetryWorker {
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(private readonly cfg: NotificationRetryWorkerConfig) {}

  static create(cfg: NotificationRetryWorkerConfig): NotificationRetryWorker {
    return new NotificationRetryWorker(cfg);
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.cfg.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      this.poll().catch(() => {});
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one poll cycle manually (useful for testing). */
  async poll(): Promise<void> {
    const batchSize  = this.cfg.batchSize  ?? 50;
    const maxRetries = this.cfg.maxRetries ?? 5;
    const pending    = await this.cfg.storage.findPending(batchSize);

    for (const notification of pending) {
      if (notification.retryCount >= maxRetries) {
        await this.cfg.storage.delete(notification.id).catch(() => {});
        continue;
      }

      try {
        await this.cfg.send(notification);
        await this.cfg.storage.delete(notification.id).catch(() => {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.cfg.storage.markRetried(notification.id, message).catch(() => {});
      }
    }
  }
}
