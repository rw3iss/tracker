import type { StoredTrackerEvent, TrackerEvent } from '../../../common/types';
import type { ITrackerPlugin, ITrackerServiceRef } from '../../ITrackerPlugin';

/**
 * Configuration for the Redis ingest consumer.
 *
 * Consumes events from a Redis LIST that a separate ingestion service
 * (e.g. the Go ingest server) pushes to. This decouples high-throughput
 * ingestion from the NestJS processing pipeline.
 *
 * @see {@link RedisIngestConsumer}
 */
export interface RedisIngestConsumerConfig {
  /**
   * Redis connection URL.
   * @example `'redis://localhost:6379'`
   */
  redis: string | { host: string; port?: number; password?: string; db?: number };

  /**
   * Redis LIST key to consume from.
   * Must match the key the ingestion server pushes to.
   * @defaultValue `'tracker:ingest'`
   */
  listKey?: string;

  /**
   * How many events to pop from the list per poll cycle.
   * @defaultValue `100`
   */
  batchSize?: number;

  /**
   * Poll interval in milliseconds when the list is empty.
   * @defaultValue `500`
   */
  pollIntervalMs?: number;
}

/**
 * NestJS plugin that consumes events from a Redis LIST and feeds them
 * into the TrackerService processing pipeline.
 *
 * Designed to work with a separate Go/Rust/etc. ingestion server that
 * pushes raw event JSON to a Redis LIST via LPUSH. This consumer
 * RPOP's events in batches and calls `TrackerService.track()` for each.
 *
 * @example
 * ```typescript
 * TrackerModule.register({
 *   plugins: [
 *     await EventStoragePlugin.fromDataSource(ds),
 *     RedisIngestConsumer.create({
 *       redis: 'redis://localhost:6379',
 *       listKey: 'tracker:ingest',
 *     }),
 *   ],
 * });
 * ```
 */
export class RedisIngestConsumer implements ITrackerPlugin {
  readonly name = 'RedisIngestConsumer';

  private service: ITrackerServiceRef | null = null;
  private redis: any = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly listKey: string;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly redisConfig: RedisIngestConsumerConfig['redis'];

  private constructor(config: RedisIngestConsumerConfig) {
    this.listKey = config.listKey ?? 'tracker:ingest';
    this.batchSize = config.batchSize ?? 100;
    this.pollIntervalMs = config.pollIntervalMs ?? 500;
    this.redisConfig = config.redis;
  }

  static create(config: RedisIngestConsumerConfig): RedisIngestConsumer {
    return new RedisIngestConsumer(config);
  }

  async onInit(service: ITrackerServiceRef): Promise<void> {
    this.service = service;

    // Lazy require redis — it's an optional dependency
    let createClient: any;
    try {
      createClient = require('redis').createClient;
    } catch {
      throw new Error('[tracker] RedisIngestConsumer requires the "redis" package. Install: pnpm add redis');
    }

    const url = typeof this.redisConfig === 'string' ? this.redisConfig : undefined;
    const opts = typeof this.redisConfig === 'object' ? {
      socket: { host: this.redisConfig.host, port: this.redisConfig.port ?? 6379 },
      password: this.redisConfig.password,
      database: this.redisConfig.db,
    } : undefined;

    this.redis = createClient(url ? { url } : opts);
    this.redis.on('error', (err: Error) => {
      console.error('[tracker] RedisIngestConsumer redis error:', err.message);
    });
    await this.redis.connect();
    console.log('[tracker] RedisIngestConsumer connected to Redis, consuming from:', this.listKey);

    this.running = true;
    this.poll();
  }

  // onEvent is a no-op — this plugin only consumes, it doesn't react to events
  async onEvent(_event: StoredTrackerEvent): Promise<void> {}

  async onDestroy(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }

  private poll(): void {
    if (!this.running) return;

    void this.consumeBatch().then(() => {
      if (this.running) {
        this.timer = setTimeout(() => this.poll(), this.pollIntervalMs);
      }
    });
  }

  private async consumeBatch(): Promise<void> {
    if (!this.redis || !this.service) return;

    try {
      const events: TrackerEvent[] = [];

      for (let i = 0; i < this.batchSize; i++) {
        const raw = await this.redis.rPop(this.listKey);
        if (!raw) break; // list is empty
        try {
          events.push(JSON.parse(raw));
        } catch {
          // skip malformed JSON
        }
      }

      if (events.length > 0) {
        for (const event of events) {
          try {
            await this.service.track(event);
          } catch {
            // individual event failures don't stop the batch
          }
        }
      }
    } catch (err) {
      console.error('[tracker] RedisIngestConsumer error:', (err as Error).message);
    }
  }
}
