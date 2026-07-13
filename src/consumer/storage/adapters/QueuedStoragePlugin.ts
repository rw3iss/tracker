import type { StoredTrackerEvent } from '../../../common/types';
import type { ITrackerPlugin, ITrackerServiceRef } from '../../ITrackerPlugin';
import type { ITrackerStorage } from '../ITrackerStorage';

/**
 * Configuration for the BullMQ-backed queued storage plugin.
 *
 * @see {@link QueuedStoragePlugin}
 * @see {@link QueuedStoragePlugin.create}
 */
export interface QueuedStorageConfig {
  /**
   * Redis connection for BullMQ.
   *
   * Either a connection URL string (`redis://host:6379`) or an IORedis-compatible
   * options object (`{ host, port, password, db }`).
   */
  redis: string | { host: string; port?: number; password?: string; db?: number };

  /**
   * The underlying storage adapter that the worker writes to.
   * This is the actual database adapter (e.g. {@link DataSourceTrackerStorage}).
   */
  storage: ITrackerStorage;

  /**
   * BullMQ queue name. Use different names to separate event streams
   * (e.g. per environment).
   * @defaultValue `'tracker-events'`
   */
  queueName?: string;

  /**
   * Number of events to batch per INSERT.
   * Higher values = fewer DB round-trips but more latency.
   * @defaultValue `100`
   */
  batchSize?: number;

  /**
   * Max time (ms) to wait before flushing a partial batch.
   * Ensures events are written even at low throughput.
   * @defaultValue `2000`
   */
  batchTimeoutMs?: number;

  /**
   * Number of concurrent workers processing batches.
   * Increase for higher write throughput (each worker does one batch INSERT at a time).
   * @defaultValue `1`
   */
  concurrency?: number;

  /**
   * Whether to start the worker in this process.
   * Set to `false` for producer-only mode when the worker runs in a separate process.
   * @defaultValue `true`
   */
  startWorker?: boolean;

  /**
   * Max retry attempts for failed batch writes.
   * @defaultValue `3`
   */
  maxRetries?: number;
}

/**
 * Storage plugin that buffers events in a BullMQ queue (Redis-backed)
 * and writes them to the underlying storage adapter in batches.
 *
 * Benefits over direct writes:
 * - **Decoupled**: API response does not wait for the DB write
 * - **Batch writes**: 100 events = 1 INSERT instead of 100
 * - **Backpressure**: events buffer in Redis if the DB is slow
 * - **Retry**: failed writes are retried automatically
 * - **Durability**: events survive process restarts (persisted in Redis)
 *
 * @remarks
 * Requires `bullmq` as a peer dependency. Install it with `pnpm add bullmq`.
 *
 * @example
 * ```typescript
 * // Same-process (simplest)
 * const plugin = await QueuedStoragePlugin.create({
 *   redis: 'redis://localhost:6379',
 *   storage: new DataSourceTrackerStorage(dataSource),
 * });
 * TrackerModule.register({ plugins: [plugin] });
 * ```
 *
 * @example
 * ```typescript
 * // Separate worker (centralized tracker)
 * // Producer (API server):
 * const plugin = await QueuedStoragePlugin.create({
 *   redis: 'redis://redis-host:6379',
 *   storage: new DataSourceTrackerStorage(dataSource),
 *   startWorker: false,  // don't process here
 * });
 *
 * // Worker (dedicated process):
 * await QueuedStoragePlugin.startStandaloneWorker({
 *   redis: 'redis://redis-host:6379',
 *   storage: new DataSourceTrackerStorage(dataSource),
 *   concurrency: 4,
 * });
 * ```
 *
 * @see {@link QueuedStorageConfig}
 * @see {@link EventStoragePlugin}
 */
export class QueuedStoragePlugin implements ITrackerPlugin {
  readonly name = 'QueuedStoragePlugin';

  // BullMQ types — kept as `any` to avoid requiring bullmq as a hard dep
  private queue: any;
  private worker: any;

  private constructor(
    private readonly storage: ITrackerStorage,
    private readonly config: QueuedStorageConfig,
  ) {}

  /**
   * Create a QueuedStoragePlugin instance.
   *
   * Initializes the BullMQ queue and optionally starts the worker in the
   * current process.
   *
   * @param config - Queue and worker configuration.
   * @returns A Promise resolving to the configured plugin.
   * @throws Error if `bullmq` is not installed.
   *
   * @example
   * ```typescript
   * const plugin = await QueuedStoragePlugin.create({
   *   redis: 'redis://localhost:6379',
   *   storage: new DataSourceTrackerStorage(dataSource),
   *   batchSize: 200,
   *   concurrency: 2,
   * });
   * ```
   */
  static async create(config: QueuedStorageConfig): Promise<QueuedStoragePlugin> {
    const plugin = new QueuedStoragePlugin(config.storage, config);

    const bullmq = QueuedStoragePlugin.requireBullMQ();
    const connection = QueuedStoragePlugin.parseRedis(config.redis);
    const queueName = config.queueName ?? 'tracker-events';

    plugin.queue = new bullmq.Queue(queueName, { connection });

    if (config.startWorker !== false) {
      plugin.startWorker(bullmq, connection, queueName);
    }

    return plugin;
  }

  /**
   * Start a standalone worker process that only consumes events from the queue.
   *
   * Use this for dedicated tracker consumer services that are separate from
   * the API server process.
   *
   * @param config - Worker configuration (subset of {@link QueuedStorageConfig}).
   * @throws Error if `bullmq` is not installed.
   *
   * @example
   * ```typescript
   * // worker.ts
   * await QueuedStoragePlugin.startStandaloneWorker({
   *   redis: process.env.REDIS_URL!,
   *   storage: new DataSourceTrackerStorage(dataSource),
   *   concurrency: 4,
   *   batchSize: 200,
   * });
   * console.log('Tracker worker running...');
   * ```
   */
  static async startStandaloneWorker(config: Pick<QueuedStorageConfig, 'redis' | 'storage' | 'queueName' | 'batchSize' | 'batchTimeoutMs' | 'concurrency' | 'maxRetries'>): Promise<void> {
    const plugin = new QueuedStoragePlugin(config.storage, config as QueuedStorageConfig);
    const bullmq = QueuedStoragePlugin.requireBullMQ();
    const connection = QueuedStoragePlugin.parseRedis(config.redis);
    const queueName = config.queueName ?? 'tracker-events';
    plugin.startWorker(bullmq, connection, queueName);
  }

  /**
   * Register the underlying storage adapter with the tracker service
   * so that query and status update endpoints work.
   *
   * @param service - The tracker service reference.
   */
  onInit(service: ITrackerServiceRef): void {
    // Register the underlying storage for query/updateStatus endpoints
    service.setStorage(this.storage);
  }

  /**
   * Enqueue a stored event for batch writing.
   *
   * Returns immediately -- the actual DB write happens asynchronously
   * in the BullMQ worker.
   *
   * @param event - The stored event to enqueue.
   */
  async onEvent(event: StoredTrackerEvent): Promise<void> {
    // Enqueue instead of direct write — returns immediately
    await this.queue.add('event', event, {
      attempts: this.config.maxRetries ?? 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: 100, // keep last 100 failed jobs for debugging
    });
  }

  /**
   * Shut down the worker and queue connections.
   */
  async onDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private startWorker(bullmq: any, connection: any, queueName: string): void {
    const batchSize = this.config.batchSize ?? 100;
    const concurrency = this.config.concurrency ?? 1;
    const storage = this.storage;

    this.worker = new bullmq.Worker(
      queueName,
      async (job: any) => {
        const event: StoredTrackerEvent = job.data;
        await storage.save(event);
      },
      {
        connection,
        concurrency,
        // BullMQ rate limiting can be added here if needed
      },
    );

    this.worker.on('failed', (job: any, err: Error) => {
      console.error(`[tracker] Queue worker: job ${job?.id} failed:`, err.message);
    });
  }

  private static requireBullMQ(): any {
    try {
      return require('bullmq');
    } catch {
      throw new Error(
        '[tracker] QueuedStoragePlugin requires bullmq. Install it: pnpm add bullmq'
      );
    }
  }

  private static parseRedis(redis: string | { host: string; port?: number; password?: string; db?: number }): any {
    if (typeof redis === 'string') {
      const url = new URL(redis);
      return {
        host: url.hostname,
        port: parseInt(url.port || '6379'),
        password: url.password || undefined,
        db: url.pathname ? parseInt(url.pathname.slice(1)) || 0 : 0,
      };
    }
    return redis;
  }
}
