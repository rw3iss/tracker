import type { Repository } from 'typeorm';
import type { IUnsentNotificationStorage, StoredUnsentNotification, UnsentNotificationRecord } from './IUnsentNotificationStorage';
import { UnsentNotificationEntity } from './UnsentNotificationEntity';

export class TypeOrmUnsentNotificationStorage implements IUnsentNotificationStorage {
  constructor(private readonly repo: Repository<UnsentNotificationEntity>) {}

  async save(record: UnsentNotificationRecord): Promise<void> {
    const entity = this.repo.create({
      channelType:      record.channelType,
      appId:            record.appId ?? null,
      recipientInfo:    record.recipientInfo,
      formattedPayload: record.formattedPayload,
      errorMessage:     record.errorMessage,
      originalEventId:  record.originalEventId ?? null,
      retryCount:       record.retryCount,
      lastAttemptAt:    record.lastAttemptAt ?? null,
    });
    await this.repo.save(entity);
  }

  async findPending(limit = 100): Promise<StoredUnsentNotification[]> {
    const rows = await this.repo.find({
      order: { createdAt: 'ASC' },
      take:  limit,
    });
    return rows.map((r) => ({
      id:               r.id,
      channelType:      r.channelType,
      appId:            r.appId ?? undefined,
      recipientInfo:    r.recipientInfo,
      formattedPayload: r.formattedPayload,
      errorMessage:     r.errorMessage,
      originalEventId:  r.originalEventId ?? undefined,
      retryCount:       r.retryCount,
      lastAttemptAt:    r.lastAttemptAt ?? undefined,
      createdAt:        r.createdAt,
    }));
  }

  async markRetried(id: string, error?: string): Promise<void> {
    await this.repo.update(id, {
      retryCount:    () => 'retry_count + 1',
      lastAttemptAt: new Date(),
      ...(error !== undefined ? { errorMessage: error } : {}),
    });
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }
}
