import type { StoredTrackerEvent, TrackerEventStatus } from '../../../common/types';
import type { ITrackerStorage, ITrackerStorageFilter } from '../ITrackerStorage';

/**
 * Minimal SQS client interface — compatible with @aws-sdk/client-sqs SQSClient.
 * Bring your own client so auth, region, and retries are fully under your control.
 */
export interface ISqsClient {
  send(command: object): Promise<unknown>;
}

export interface SqsStorageAdapterConfig {
  /**
   * Pre-configured SQS client from @aws-sdk/client-sqs.
   * If omitted, one is auto-created using environment credentials (AWS_REGION, etc.).
   */
  client?:         ISqsClient;
  /** SQS queue URL. For FIFO queues the URL must end in `.fifo`. */
  queueUrl:        string;
  /**
   * Max events per SQS SendMessageBatch call. Range: 1–10 (AWS limit). Default: 10.
   * Only affects saveBatch(); save() always sends a single message.
   */
  batchSize?:      number;
  /**
   * MessageGroupId for FIFO queues. Required if queueUrl ends in `.fifo`.
   * All tracker events share this group; ordering is per-group within a FIFO queue.
   */
  messageGroupId?: string;
}

/**
 * Write-only storage adapter that publishes tracker events to an AWS SQS queue.
 *
 * Requires @aws-sdk/client-sqs to be installed in the consuming project:
 *   npm install @aws-sdk/client-sqs
 *
 * Query methods (find, findById) always return empty — SQS is a message queue,
 * not a queryable store. Pair with a database adapter via CompositeStorageAdapter
 * if you need both streaming and queryability.
 *
 * @example
 * import { SQSClient } from '@aws-sdk/client-sqs';
 *
 * EventStoragePlugin.create(new SqsStorageAdapter({
 *   client:   new SQSClient({ region: 'us-east-1' }),
 *   queueUrl: process.env.TRACKER_SQS_URL!,
 * }))
 */
export class SqsStorageAdapter implements ITrackerStorage {
  private readonly queueUrl:        string;
  private readonly batchSize:       number;
  private readonly messageGroupId?: string;
  private resolvedClient:           ISqsClient | null = null;

  constructor(private readonly config: SqsStorageAdapterConfig) {
    this.queueUrl        = config.queueUrl;
    this.batchSize       = Math.min(config.batchSize ?? 10, 10);
    this.messageGroupId  = config.messageGroupId;
  }

  async save(event: StoredTrackerEvent): Promise<void> {
    const { SendMessageCommand } = this.requireSdk();
    const client = await this.getClient();
    await client.send(new SendMessageCommand(this.buildMessageInput(event)));
  }

  async saveBatch(events: StoredTrackerEvent[]): Promise<void> {
    if (events.length === 0) return;
    const { SendMessageBatchCommand } = this.requireSdk();
    const client = await this.getClient();

    // SQS batch limit is 10 entries per request
    for (let i = 0; i < events.length; i += this.batchSize) {
      const chunk = events.slice(i, i + this.batchSize);
      await client.send(new SendMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries:  chunk.map((event, idx) => ({
          Id:          `${idx}`,   // unique within the batch — not the event ID
          MessageBody: JSON.stringify(event),
          ...(this.messageGroupId ? { MessageGroupId: this.messageGroupId } : {}),
          ...(this.isFifo()       ? { MessageDeduplicationId: event.id } : {}),
        })),
      }));
    }
  }

  // SQS is a message queue — querying is not supported
  async find(_filters?: ITrackerStorageFilter): Promise<StoredTrackerEvent[]> {
    return [];
  }

  async findById(_id: string): Promise<StoredTrackerEvent | null> {
    return null;
  }

  async updateStatus(_id: string, _status: TrackerEventStatus): Promise<void> {
    // no-op — messages are immutable once enqueued
  }

  async delete(_id: string): Promise<void> {
    // no-op — use SQS message visibility / DLQ for lifecycle management
  }

  async distinct(): Promise<Array<{ value: string; count: number }>> {
    // SQS isn't queryable for aggregates — readers must hit a real store
    // (Postgres, etc.) for distinct()s. Returning empty keeps the caller
    // alive with an empty picker rather than throwing.
    return [];
  }

  async clear(): Promise<number> {
    // SQS doesn't expose a "delete all matching" primitive — events
    // must be drained by their consumer or DLQ-purged via the AWS
    // console. We return -1 to signal "no-op, indeterminate count"
    // so admin tooling reports it cleanly rather than implying success.
    return -1;
  }

  private buildMessageInput(event: StoredTrackerEvent): Record<string, unknown> {
    return {
      QueueUrl:    this.queueUrl,
      MessageBody: JSON.stringify(event),
      ...(this.messageGroupId ? { MessageGroupId: this.messageGroupId } : {}),
      ...(this.isFifo()       ? { MessageDeduplicationId: event.id }    : {}),
    };
  }

  private isFifo(): boolean {
    return this.queueUrl.endsWith('.fifo');
  }

  private async getClient(): Promise<ISqsClient> {
    if (this.config.client) return this.config.client;
    if (!this.resolvedClient) {
      const { SQSClient } = this.requireSdk();
      this.resolvedClient = new SQSClient({}) as ISqsClient;
    }
    return this.resolvedClient!;
  }

  private requireSdk(): Record<string, new (...args: unknown[]) => object> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('@aws-sdk/client-sqs');
    } catch {
      throw new Error(
        'SqsStorageAdapter requires @aws-sdk/client-sqs. ' +
        'Install it with: npm install @aws-sdk/client-sqs',
      );
    }
  }
}
