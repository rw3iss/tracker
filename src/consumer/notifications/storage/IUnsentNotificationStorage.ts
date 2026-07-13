import type { ChannelType } from '../INotificationAdapter';

export interface UnsentNotificationRecord {
  channelType:      ChannelType;
  appId?:           string;
  /** JSON-serialized recipient info (email addresses, phone numbers, URL, etc.) */
  recipientInfo:    string;
  /** JSON-serialized formatted payload that was attempted */
  formattedPayload: string;
  errorMessage:     string;
  originalEventId?: string;
  retryCount:       number;
  lastAttemptAt?:   Date;
}

export interface StoredUnsentNotification extends UnsentNotificationRecord {
  id:        string;
  createdAt: Date;
}

export interface IUnsentNotificationStorage {
  save(record: UnsentNotificationRecord): Promise<void>;
  findPending(limit?: number): Promise<StoredUnsentNotification[]>;
  markRetried(id: string, error?: string): Promise<void>;
  delete(id: string): Promise<void>;
}
