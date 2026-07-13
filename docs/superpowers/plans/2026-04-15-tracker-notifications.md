# Tracker Notifications Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `@rw3iss/tracker/notifications` fourth subpath export that delivers notifications (email, SMS, webhook, Firebase push) when tracker events are stored, with loop prevention, per-channel adapters, deduplication, and unsent-notification storage.

**Architecture:** `TrackerNotificationsPlugin` implements `ITrackerPlugin` and is registered in `TrackerModule.register({ plugins: [...] })`. After every successful `storage.save()`, `TrackerService` calls `plugin.onEvent(storedEvent)` fire-and-forget. The plugin runs all configured `INotificationStrategy` instances; strategies call `dispatcher.notify()` which resolves channels, deduplicates, formats, and dispatches via `Promise.allSettled`. Failures are tracked back into `TrackerService` with `category: 'notification-failed'`; loop prevention uses both category-based channel omission and an in-memory TTL deduplicator.

**Tech Stack:** NestJS 11, TypeORM 0.3, nodemailer (SMTP), native `fetch` (SendGrid/Mailgun/Postmark/Twilio/Webhook/Firebase FCM REST), jest + ts-jest

---

## File Structure

**Modified files:**
- `src/common/types.ts` — add `category?: string` to `TrackerEvent`
- `src/server/constants.ts` — add `TRACKER_PLUGINS`
- `src/server/TrackerModule.ts` — add `plugins?` option, wire `TRACKER_PLUGINS` provider
- `src/server/storage/ITrackerStorage.ts` — change `save()` return to `Promise<StoredTrackerEvent>`
- `src/server/storage/TypeOrmTrackerStorage.ts` — return stored entity from `save()`
- `src/server/storage/TrackerEventEntity.ts` — add `category` column
- `src/server/dto/track-event.dto.ts` — add `category` field
- `src/server/TrackerService.ts` — plugin lifecycle hooks, capture stored event from `save()`
- `tsup.config.ts` — add notifications build entry
- `package.json` — add `./notifications` export, add `nodemailer` optionalDependency
- `jest.config.js` — add `@rw3iss/tracker/notifications` module mapping
- `tests/server/TrackerService.test.ts` — update storage mock for new `save()` return type

**New files:**
- `src/server/ITrackerPlugin.ts`
- `src/server/notifications/NotificationCategory.ts`
- `src/server/notifications/INotificationStrategy.ts`
- `src/server/notifications/INotificationAdapter.ts`
- `src/server/notifications/types.ts`
- `src/server/notifications/NotificationDeduplicator.ts`
- `src/server/notifications/NotificationDispatcher.ts`
- `src/server/notifications/TrackerNotificationsPlugin.ts`
- `src/server/notifications/index.ts`
- `src/server/notifications/strategies/NotifyOnErrorsStrategy.ts`
- `src/server/notifications/channels/ChannelConfig.ts`
- `src/server/notifications/channels/email/IEmailAdapter.ts`
- `src/server/notifications/channels/email/SmtpAdapter.ts`
- `src/server/notifications/channels/email/SendGridApiAdapter.ts`
- `src/server/notifications/channels/email/MailgunAdapter.ts`
- `src/server/notifications/channels/email/PostmarkAdapter.ts`
- `src/server/notifications/channels/sms/TwilioSmsAdapter.ts`
- `src/server/notifications/channels/webhook/WebhookAdapter.ts`
- `src/server/notifications/channels/firebase/FirebaseAdapter.ts`
- `src/server/notifications/formatters/defaultEmailFormatter.ts`
- `src/server/notifications/formatters/defaultSmsFormatter.ts`
- `src/server/notifications/formatters/defaultWebhookFormatter.ts`
- `src/server/notifications/formatters/defaultFirebaseFormatter.ts`
- `src/server/notifications/storage/IUnsentNotificationStorage.ts`
- `src/server/notifications/storage/UnsentNotificationEntity.ts`
- `src/server/notifications/storage/TypeOrmUnsentNotificationStorage.ts`
- `src/server/notifications/utils/eventFilters.ts`
- `src/server/notifications/utils/eventFormatters.ts`
- `src/server/notifications/utils/resolveOmit.ts`
- `tests/server/notifications/NotificationDeduplicator.test.ts`
- `tests/server/notifications/NotificationDispatcher.test.ts`
- `tests/server/notifications/NotifyOnErrorsStrategy.test.ts`
- `tests/server/notifications/TrackerNotificationsPlugin.test.ts`
- `NOTIFICATIONS.md`

---

### Task 1: Core tracker changes — category field, plugin interface, storage return type, service wiring

**Files:**
- Modify: `src/common/types.ts`
- Modify: `src/server/constants.ts`
- Create: `src/server/ITrackerPlugin.ts`
- Modify: `src/server/TrackerModule.ts`
- Modify: `src/server/storage/ITrackerStorage.ts`
- Modify: `src/server/storage/TypeOrmTrackerStorage.ts`
- Modify: `src/server/storage/TrackerEventEntity.ts`
- Modify: `src/server/dto/track-event.dto.ts`
- Modify: `src/server/TrackerService.ts`
- Modify: `tests/server/TrackerService.test.ts`

- [ ] **Step 1: Write the failing test for plugin lifecycle in TrackerService**

Replace `tests/server/TrackerService.test.ts` with:

```typescript
import 'reflect-metadata';
import { TrackerService } from '../../src/server/TrackerService';
import { TrackerDeduplicator } from '../../src/server/TrackerDeduplicator';
import { InMemoryDeduplicationCache } from '../../src/server/cache/InMemoryDeduplicationCache';
import { TrackerEventStatus } from '../../src/common/types';
import type { ITrackerStorage, ITrackerStorageFilter } from '../../src/server/storage/ITrackerStorage';
import type { ITrackerPlugin } from '../../src/server/ITrackerPlugin';
import type { StoredTrackerEvent, TrackerEvent } from '../../src/common/types';

const storedEvent: StoredTrackerEvent = {
  id: 'test-uuid',
  type: 'error',
  message: 'boom',
  status: TrackerEventStatus.New,
  timestamp: 1,
  receivedAt: Date.now(),
};

function makeStorage(): jest.Mocked<ITrackerStorage> {
  return {
    save:         jest.fn().mockResolvedValue(storedEvent),
    saveBatch:    jest.fn().mockResolvedValue(undefined),
    find:         jest.fn().mockResolvedValue([]),
    findById:     jest.fn().mockResolvedValue(null),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    delete:       jest.fn().mockResolvedValue(undefined),
  };
}

function makePlugin(): jest.Mocked<ITrackerPlugin> {
  return {
    onInit:    jest.fn().mockResolvedValue(undefined),
    onEvent:   jest.fn().mockResolvedValue(undefined),
    onDestroy: jest.fn().mockResolvedValue(undefined),
  };
}

const baseEvent: TrackerEvent = { type: 'error', message: 'boom', timestamp: 1 };

describe('TrackerService', () => {
  it('track() stamps receivedAt and calls storage.save', async () => {
    const storage = makeStorage();
    const svc = new TrackerService(storage, null);
    const before = Date.now();
    await svc.track(baseEvent);
    expect(storage.save).toHaveBeenCalledTimes(1);
    const saved = storage.save.mock.calls[0][0];
    expect(saved.message).toBe('boom');
    expect(saved.receivedAt).toBeGreaterThanOrEqual(before);
  });

  it('track() skips storage when dedup returns true', async () => {
    const storage = makeStorage();
    const dedup = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 60_000);
    const svc = new TrackerService(storage, dedup);
    await svc.track(baseEvent);
    await svc.track(baseEvent);
    expect(storage.save).toHaveBeenCalledTimes(1);
  });

  it('trackBatch() applies dedup per event, skipping duplicates', async () => {
    const storage = makeStorage();
    const dedup = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 60_000);
    const svc = new TrackerService(storage, dedup);
    await svc.trackBatch([baseEvent, baseEvent, baseEvent]);
    expect(storage.save).toHaveBeenCalledTimes(1);
  });

  it('trackBatch() with no dedup saves all events', async () => {
    const storage = makeStorage();
    const svc = new TrackerService(storage, null);
    await svc.trackBatch([baseEvent, { ...baseEvent, message: 'other' }]);
    expect(storage.save).toHaveBeenCalledTimes(2);
  });

  it('updateStatus() delegates to storage.updateStatus', async () => {
    const storage = makeStorage();
    const svc = new TrackerService(storage, null);
    await svc.updateStatus('abc-123', TrackerEventStatus.Resolved);
    expect(storage.updateStatus).toHaveBeenCalledWith('abc-123', TrackerEventStatus.Resolved);
  });

  it('query() delegates to storage.find with filters', async () => {
    const storage = makeStorage();
    const svc = new TrackerService(storage, null);
    await svc.query({ appId: 'my-app', type: 'error', limit: 50 });
    expect(storage.find).toHaveBeenCalledWith({ appId: 'my-app', type: 'error', limit: 50 });
  });

  it('onModuleInit() calls onInit on each plugin', async () => {
    const storage = makeStorage();
    const plugin = makePlugin();
    const svc = new TrackerService(storage, null, [plugin]);
    await svc.onModuleInit();
    expect(plugin.onInit).toHaveBeenCalledWith(svc);
  });

  it('track() notifies plugins with stored event after save', async () => {
    const storage = makeStorage();
    const plugin = makePlugin();
    const svc = new TrackerService(storage, null, [plugin]);
    await svc.track(baseEvent);
    // onEvent is fire-and-forget; flush microtasks
    await new Promise(r => setImmediate(r));
    expect(plugin.onEvent).toHaveBeenCalledWith(storedEvent);
  });

  it('track() does not throw if plugin.onEvent rejects', async () => {
    const storage = makeStorage();
    const plugin = makePlugin();
    plugin.onEvent.mockRejectedValue(new Error('plugin exploded'));
    const svc = new TrackerService(storage, null, [plugin]);
    await expect(svc.track(baseEvent)).resolves.toBeUndefined();
  });

  it('onModuleDestroy() calls onDestroy on each plugin', async () => {
    const storage = makeStorage();
    const plugin = makePlugin();
    const svc = new TrackerService(storage, null, [plugin]);
    await svc.onModuleDestroy();
    expect(plugin.onDestroy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest tests/server/TrackerService.test.ts --no-coverage 2>&1 | tail -20
```

Expected: FAIL — `ITrackerPlugin` not found, `TrackerService` constructor doesn't accept third arg, `onModuleInit` not defined.

- [ ] **Step 3: Add `category` to `TrackerEvent` in `src/common/types.ts`**

Add `category?: string;` after `tags?:` line:

```typescript
export interface TrackerEvent {
  type:      EventType;
  message:   string;
  appId?:    string;
  payload?:  Record<string, unknown>;
  error?:    SerializedError;
  context?:  TrackerContext;
  tags?:     string[];
  category?: string;
  /** Unix ms, set by client at capture time */
  timestamp: number;
}
```

- [ ] **Step 4: Add `TRACKER_PLUGINS` to `src/server/constants.ts`**

```typescript
export const TRACKER_STORAGE      = 'TRACKER_STORAGE';
export const TRACKER_DEDUPLICATOR = 'TRACKER_DEDUPLICATOR';
export const TRACKER_ROUTE_PREFIX = 'TRACKER_ROUTE_PREFIX';
export const TRACKER_PLUGINS      = 'TRACKER_PLUGINS';
```

- [ ] **Step 5: Create `src/server/ITrackerPlugin.ts`**

```typescript
import type { StoredTrackerEvent, TrackerEvent } from '../common/types';

/** Minimal tracker surface exposed to plugins — avoids circular import with TrackerService. */
export interface ITrackerServiceRef {
  track(event: TrackerEvent): Promise<void>;
}

export interface ITrackerPlugin {
  /** Called once when TrackerModule initializes. Use to capture the service reference. */
  onInit?(trackerService: ITrackerServiceRef): void | Promise<void>;
  /** Called after every event is stored. Fire-and-forget; errors are swallowed. */
  onEvent(event: StoredTrackerEvent): void | Promise<void>;
  /** Called when NestJS module is destroyed. */
  onDestroy?(): void | Promise<void>;
}
```

- [ ] **Step 6: Change `ITrackerStorage.save()` return type in `src/server/storage/ITrackerStorage.ts`**

```typescript
import type { EventType, StoredTrackerEvent, TrackerEvent, TrackerEventStatus } from '../../common/types';

export interface ITrackerStorageFilter {
  appId?:       string;
  type?:        EventType;
  status?:      TrackerEventStatus;
  userId?:      string;
  environment?: string;
  from?:        number;
  to?:          number;
  tags?:        string[];
  limit?:       number;
  offset?:      number;
}

export type PersistedEvent = TrackerEvent & { receivedAt: number };

export interface ITrackerStorage {
  save(event: PersistedEvent): Promise<StoredTrackerEvent>;
  saveBatch(events: PersistedEvent[]): Promise<void>;
  find(filters?: ITrackerStorageFilter): Promise<StoredTrackerEvent[]>;
  findById(id: string): Promise<StoredTrackerEvent | null>;
  updateStatus(id: string, status: TrackerEventStatus): Promise<void>;
  delete(id: string): Promise<void>;
}
```

- [ ] **Step 7: Add `category` column to `src/server/storage/TrackerEventEntity.ts`**

Add after the `appId` column:

```typescript
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TrackerEventStatus } from '../../common/types';
import type { SerializedError, TrackerContext } from '../../common/types';

@Entity('tracker_events')
@Index(['appId'])
@Index(['status'])
@Index(['receivedAt'])
export class TrackerEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  type!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'varchar', nullable: true })
  appId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  category!: string | null;

  @Column({ type: 'varchar', default: TrackerEventStatus.New })
  status!: TrackerEventStatus;

  @Column({ type: 'jsonb', nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  error!: SerializedError | null;

  @Column({ type: 'jsonb', nullable: true })
  context!: TrackerContext | null;

  @Column({ type: 'simple-array', nullable: true })
  tags!: string[];

  @Column({ type: 'bigint', transformer: { to: (v) => v, from: (v) => Number(v) } })
  timestamp!: number;

  @Column({ type: 'bigint', transformer: { to: (v) => v, from: (v) => Number(v) } })
  receivedAt!: number;
}
```

- [ ] **Step 8: Update `TypeOrmTrackerStorage.save()` to return stored entity**

Replace the `save`, `toEntity`, and `toStored` methods in `src/server/storage/TypeOrmTrackerStorage.ts`:

```typescript
import type { Repository } from 'typeorm';
import { TrackerEventStatus } from '../../common/types';
import type { StoredTrackerEvent } from '../../common/types';
import type { ITrackerStorage, ITrackerStorageFilter, PersistedEvent } from './ITrackerStorage';
import { TrackerEventEntity } from './TrackerEventEntity';

export class TypeOrmTrackerStorage implements ITrackerStorage {
  constructor(private readonly repo: Repository<TrackerEventEntity>) {}

  async save(event: PersistedEvent): Promise<StoredTrackerEvent> {
    const entity = await this.repo.save(this.toEntity(event));
    return this.toStored(entity as TrackerEventEntity);
  }

  async saveBatch(events: PersistedEvent[]): Promise<void> {
    await this.repo.save(events.map((e) => this.toEntity(e)));
  }

  async find(filters: ITrackerStorageFilter = {}): Promise<StoredTrackerEvent[]> {
    const qb = this.repo.createQueryBuilder('e').orderBy('e.receivedAt', 'DESC');

    if (filters.appId)       qb.andWhere('e.appId = :appId', { appId: filters.appId });
    if (filters.type)        qb.andWhere('e.type = :type', { type: filters.type });
    if (filters.status)      qb.andWhere('e.status = :status', { status: filters.status });
    if (filters.from)        qb.andWhere('e.receivedAt >= :from', { from: filters.from });
    if (filters.to)          qb.andWhere('e.receivedAt <= :to', { to: filters.to });
    if (filters.userId)      qb.andWhere("e.context->>'userId' = :userId", { userId: filters.userId });
    if (filters.environment) qb.andWhere("e.context->>'environment' = :env", { env: filters.environment });
    if (filters.tags?.length) {
      filters.tags.forEach((tag, i) => {
        qb.andWhere(`e.tags LIKE :tag${i}`, { [`tag${i}`]: `%${tag}%` });
      });
    }

    qb.limit(filters.limit ?? 100).offset(filters.offset ?? 0);
    return (await qb.getMany()).map((e) => this.toStored(e));
  }

  async findById(id: string): Promise<StoredTrackerEvent | null> {
    const e = await this.repo.findOne({ where: { id } });
    return e ? this.toStored(e) : null;
  }

  async updateStatus(id: string, status: TrackerEventStatus): Promise<void> {
    await this.repo.update(id, { status });
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  private toEntity(event: PersistedEvent): Partial<TrackerEventEntity> {
    return {
      type:       event.type,
      message:    event.message,
      appId:      event.appId ?? null,
      category:   event.category ?? null,
      status:     TrackerEventStatus.New,
      payload:    event.payload ?? null,
      error:      event.error ?? null,
      context:    event.context ?? null,
      tags:       event.tags ?? [],
      timestamp:  event.timestamp,
      receivedAt: event.receivedAt,
    };
  }

  private toStored(e: TrackerEventEntity): StoredTrackerEvent {
    return {
      id:         e.id,
      type:       e.type as StoredTrackerEvent['type'],
      message:    e.message,
      appId:      e.appId ?? undefined,
      category:   e.category ?? undefined,
      status:     e.status,
      payload:    e.payload ?? undefined,
      error:      e.error ?? undefined,
      context:    e.context ?? undefined,
      tags:       e.tags ?? [],
      timestamp:  e.timestamp,
      receivedAt: e.receivedAt,
    };
  }
}
```

- [ ] **Step 9: Add `category` to `src/server/dto/track-event.dto.ts`**

Add `@IsOptional() @IsString() category?: string;` after `appId`:

```typescript
import {
  IsEnum, IsNumber, IsObject, IsOptional, IsString, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EventType } from '../../common/types';

class SerializedErrorDto {
  @IsString() name!: string;
  @IsString() message!: string;
  @IsOptional() @IsString() stack?: string;
}

class TrackerContextDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() sessionId?: string;
  @IsOptional() @IsString() appVersion?: string;
  @IsOptional() @IsString() environment?: string;
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() userAgent?: string;
}

export class TrackEventDto {
  @IsEnum(['error', 'warning', 'info', 'event'] as const) type!: EventType;
  @IsString() message!: string;
  @IsOptional() @IsString() appId?: string;
  @IsOptional() @IsString() category?: string;
  @IsNumber() timestamp!: number;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
  @IsOptional() @ValidateNested() @Type(() => SerializedErrorDto) error?: SerializedErrorDto;
  @IsOptional() @ValidateNested() @Type(() => TrackerContextDto) context?: TrackerContextDto;
  @IsOptional() @IsString({ each: true }) tags?: string[];
}
```

- [ ] **Step 10: Update `TrackerModule.ts` to wire plugins**

```typescript
import { DynamicModule, Module, Type } from '@nestjs/common';
import { TrackerController } from './TrackerController';
import { TrackerService } from './TrackerService';
import { TrackerDeduplicator } from './TrackerDeduplicator';
import { InMemoryDeduplicationCache } from './cache/InMemoryDeduplicationCache';
import { TRACKER_DEDUPLICATOR, TRACKER_PLUGINS, TRACKER_STORAGE } from './constants';
import type { ITrackerStorage } from './storage/ITrackerStorage';
import type { ITrackerDeduplicationCache } from './cache/ITrackerDeduplicationCache';
import type { ITrackerPlugin } from './ITrackerPlugin';

export interface TrackerDeduplicationOptions {
  enabled:   boolean;
  windowMs?: number;
  cache?:    ITrackerDeduplicationCache;
}

export interface TrackerModuleOptions {
  storage:         ITrackerStorage;
  deduplication?:  TrackerDeduplicationOptions;
  guardClass?:     Type<unknown>;
  plugins?:        ITrackerPlugin[];
}

export interface TrackerModuleAsyncOptions {
  inject?:     any[];
  imports?:    unknown[];
  useFactory:  (...args: any[]) => TrackerModuleOptions | Promise<TrackerModuleOptions>;
}

function buildDeduplicatorProvider(options?: TrackerDeduplicationOptions) {
  const deduplicator =
    options?.enabled
      ? new TrackerDeduplicator(
          options.cache ?? new InMemoryDeduplicationCache(),
          Math.min(options.windowMs ?? 300_000, 28_800_000),
        )
      : null;
  return { provide: TRACKER_DEDUPLICATOR, useValue: deduplicator };
}

@Module({})
export class TrackerModule {
  static register(options: TrackerModuleOptions): DynamicModule {
    const providers: unknown[] = [
      { provide: TRACKER_STORAGE, useValue: options.storage },
      buildDeduplicatorProvider(options.deduplication),
      { provide: TRACKER_PLUGINS, useValue: options.plugins ?? [] },
      TrackerService,
    ];

    if (options.guardClass) {
      providers.push({ provide: 'APP_GUARD', useClass: options.guardClass });
    }

    return {
      module: TrackerModule,
      global: true,
      providers: providers as DynamicModule['providers'],
      controllers: [TrackerController],
      exports: [TrackerService],
    };
  }

  static registerAsync(options: TrackerModuleAsyncOptions): DynamicModule {
    const OPTIONS_TOKEN = 'TRACKER_MODULE_OPTIONS_TOKEN';

    const optionsProvider = {
      provide: OPTIONS_TOKEN,
      useFactory: options.useFactory,
      inject: (options.inject ?? []) as any[],
    };

    const storageProvider = {
      provide: TRACKER_STORAGE,
      useFactory: (opts: TrackerModuleOptions) => opts.storage,
      inject: [OPTIONS_TOKEN],
    };

    const deduplicatorProvider = {
      provide: TRACKER_DEDUPLICATOR,
      useFactory: (opts: TrackerModuleOptions) =>
        buildDeduplicatorProvider(opts.deduplication).useValue,
      inject: [OPTIONS_TOKEN],
    };

    const pluginsProvider = {
      provide: TRACKER_PLUGINS,
      useFactory: (opts: TrackerModuleOptions) => opts.plugins ?? [],
      inject: [OPTIONS_TOKEN],
    };

    return {
      module: TrackerModule,
      global: true,
      imports: (options.imports ?? []) as DynamicModule['imports'],
      providers: [optionsProvider, storageProvider, deduplicatorProvider, pluginsProvider, TrackerService],
      controllers: [TrackerController],
      exports: [TrackerService],
    };
  }
}
```

- [ ] **Step 11: Update `TrackerService.ts` with plugin lifecycle**

```typescript
import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import type { TrackerEvent, TrackerEventStatus, StoredTrackerEvent } from '../common/types';
import { TRACKER_DEDUPLICATOR, TRACKER_PLUGINS, TRACKER_STORAGE } from './constants';
import type { ITrackerStorage, ITrackerStorageFilter } from './storage/ITrackerStorage';
import type { TrackerDeduplicator } from './TrackerDeduplicator';
import type { ITrackerPlugin } from './ITrackerPlugin';

@Injectable()
export class TrackerService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(TRACKER_STORAGE) private readonly storage: ITrackerStorage,
    @Optional() @Inject(TRACKER_DEDUPLICATOR) private readonly deduplicator: TrackerDeduplicator | null,
    @Optional() @Inject(TRACKER_PLUGINS) private readonly plugins: ITrackerPlugin[] = [],
  ) {}

  async onModuleInit(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.onInit?.(this);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.onDestroy?.();
    }
  }

  async track(event: TrackerEvent): Promise<void> {
    if (this.deduplicator && await this.deduplicator.isDuplicate(event)) return;
    const stored = await this.storage.save({ ...event, receivedAt: Date.now() });
    for (const plugin of this.plugins) {
      Promise.resolve(plugin.onEvent(stored)).catch(() => {});
    }
  }

  async trackBatch(events: TrackerEvent[]): Promise<void> {
    for (const event of events) {
      await this.track(event);
    }
  }

  async updateStatus(id: string, status: TrackerEventStatus): Promise<void> {
    await this.storage.updateStatus(id, status);
  }

  async query(filters?: ITrackerStorageFilter): Promise<StoredTrackerEvent[]> {
    return this.storage.find(filters);
  }
}
```

- [ ] **Step 12: Run tests to verify all pass**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest tests/server/TrackerService.test.ts --no-coverage
```

Expected: All 10 tests PASS.

- [ ] **Step 13: Run full test suite to confirm nothing regressed**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest --no-coverage
```

Expected: All tests PASS.

- [ ] **Step 14: Commit**

```bash
cd /home/rw3iss/Sites/ven/new/tracker
git add src/common/types.ts src/server/constants.ts src/server/ITrackerPlugin.ts \
  src/server/TrackerModule.ts src/server/TrackerService.ts \
  src/server/storage/ITrackerStorage.ts src/server/storage/TypeOrmTrackerStorage.ts \
  src/server/storage/TrackerEventEntity.ts src/server/dto/track-event.dto.ts \
  tests/server/TrackerService.test.ts
git commit -m "feat: add category field, ITrackerPlugin interface, plugin lifecycle to TrackerService"
```

---

### Task 2: Notification types, interfaces, and utilities

**Files:**
- Create: `src/server/notifications/NotificationCategory.ts`
- Create: `src/server/notifications/INotificationStrategy.ts`
- Create: `src/server/notifications/INotificationAdapter.ts`
- Create: `src/server/notifications/types.ts`
- Create: `src/server/notifications/channels/ChannelConfig.ts`
- Create: `src/server/notifications/utils/eventFilters.ts`
- Create: `src/server/notifications/utils/eventFormatters.ts`
- Create: `src/server/notifications/utils/resolveOmit.ts`

- [ ] **Step 1: Create `src/server/notifications/NotificationCategory.ts`**

```typescript
export const NotificationCategory = {
  NotificationFailed: 'notification-failed',
} as const;

export type NotificationCategoryValue =
  (typeof NotificationCategory)[keyof typeof NotificationCategory];
```

- [ ] **Step 2: Create `src/server/notifications/INotificationAdapter.ts`**

```typescript
export type ChannelType = 'email' | 'sms' | 'webhook' | 'firebase';

export interface FormattedNotification {
  channelType: ChannelType;
  /** Channel-specific payload (EmailPayload, SmsPayload, etc.) */
  raw: unknown;
}

export interface INotificationAdapter {
  readonly channelType: ChannelType;
  send(payload: FormattedNotification): Promise<void>;
}
```

- [ ] **Step 3: Create `src/server/notifications/INotificationStrategy.ts`**

```typescript
import type { StoredTrackerEvent } from '../../common/types';
import type { NotificationDispatcher } from './NotificationDispatcher';

export interface INotificationStrategy {
  onEvent(
    event: StoredTrackerEvent,
    dispatcher: NotificationDispatcher,
  ): void | Promise<void>;
}
```

- [ ] **Step 4: Create `src/server/notifications/types.ts`**

```typescript
import type { StoredTrackerEvent } from '../../common/types';
import type { ChannelType, FormattedNotification } from './INotificationAdapter';

export interface NotificationData {
  subject: string;
  body: StoredTrackerEvent | Record<string, unknown>;
  [key: string]: unknown;
}

export interface NotificationDispatchOptions {
  /** Skip these channels even if configured. Omit takes precedence over include. */
  omit?: ChannelType[];
  /** Force-include these channels (still requires adapter to be configured). */
  include?: ChannelType[];
}

// Formatter function types
export type EmailFormatter   = (data: NotificationData) => EmailPayload;
export type SmsFormatter     = (data: NotificationData) => SmsPayload;
export type WebhookFormatter = (data: NotificationData) => WebhookPayload;
export type FirebaseFormatter = (data: NotificationData) => FirebasePayload;

export interface EmailPayload {
  from:    string;
  to:      string[];
  subject: string;
  html:    string;
  text:    string;
}

export interface SmsPayload {
  to:   string[];
  body: string;
}

export interface WebhookPayload {
  [key: string]: unknown;
}

export interface FirebasePayload {
  tokens: string[];
  title:  string;
  body:   string;
  data?:  Record<string, string>;
}

export type AnyPayload = EmailPayload | SmsPayload | WebhookPayload | FirebasePayload;
```

- [ ] **Step 5: Create `src/server/notifications/channels/ChannelConfig.ts`**

```typescript
import type { INotificationAdapter } from '../INotificationAdapter';
import type {
  EmailFormatter, SmsFormatter, WebhookFormatter, FirebaseFormatter,
} from '../types';

export interface IEmailAdapter extends INotificationAdapter {
  readonly channelType: 'email';
}

export interface ISmsAdapter extends INotificationAdapter {
  readonly channelType: 'sms';
}

export interface IWebhookAdapter extends INotificationAdapter {
  readonly channelType: 'webhook';
}

export interface IFirebaseAdapter extends INotificationAdapter {
  readonly channelType: 'firebase';
}

export interface EmailChannelConfig {
  adapter:     IEmailAdapter;
  recipients:  string[];
  from:        string;
  formatter?:  EmailFormatter;
}

export interface SmsChannelConfig {
  adapter:    ISmsAdapter;
  to:         string[];
  formatter?: SmsFormatter;
}

export interface WebhookChannelConfig {
  adapter:    IWebhookAdapter;
  formatter?: WebhookFormatter;
}

export interface FirebaseChannelConfig {
  adapter:    IFirebaseAdapter;
  tokens:     string[];
  formatter?: FirebaseFormatter;
}

export interface ChannelConfigMap {
  email:    EmailChannelConfig;
  sms:      SmsChannelConfig;
  webhook:  WebhookChannelConfig;
  firebase: FirebaseChannelConfig;
}
```

- [ ] **Step 6: Create `src/server/notifications/utils/eventFilters.ts`**

```typescript
import type { StoredTrackerEvent } from '../../../common/types';
import type { EventType } from '../../../common/types';
import { NotificationCategory } from '../NotificationCategory';

export function isErrorEvent(event: StoredTrackerEvent): boolean {
  return event.type === 'error';
}

export function isNotificationFailedEvent(event: StoredTrackerEvent): boolean {
  return event.category === NotificationCategory.NotificationFailed;
}

export function matchesCategory(event: StoredTrackerEvent, category: string): boolean {
  return event.category === category;
}

export function matchesType(event: StoredTrackerEvent, type: EventType): boolean {
  return event.type === type;
}

export function matchesAppId(event: StoredTrackerEvent, appId: string): boolean {
  return event.appId === appId;
}
```

- [ ] **Step 7: Create `src/server/notifications/utils/eventFormatters.ts`**

```typescript
import type { StoredTrackerEvent } from '../../../common/types';

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

export function serializeEventToText(event: StoredTrackerEvent): string {
  const lines: string[] = [
    `ID:         ${event.id}`,
    `Type:       ${event.type}`,
    `Message:    ${event.message}`,
    `App:        ${event.appId ?? 'unknown'}`,
    `Timestamp:  ${new Date(event.timestamp).toISOString()}`,
    `ReceivedAt: ${new Date(event.receivedAt).toISOString()}`,
    `Status:     ${event.status}`,
  ];
  if (event.category)  lines.push(`Category:   ${event.category}`);
  if (event.tags?.length) lines.push(`Tags:       ${event.tags.join(', ')}`);
  if (event.error)    lines.push(`Error:      ${event.error.name}: ${event.error.message}`);
  if (event.error?.stack) lines.push(`Stack:\n${event.error.stack}`);
  if (event.payload)  lines.push(`Payload:    ${JSON.stringify(event.payload, null, 2)}`);
  if (event.context)  lines.push(`Context:    ${JSON.stringify(event.context, null, 2)}`);
  return lines.join('\n');
}

export function serializeEventToHtml(event: StoredTrackerEvent): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const rows = (pairs: [string, string][]) =>
    pairs
      .map(
        ([k, v]) =>
          `<tr><td style="font-weight:bold;padding:4px 8px;vertical-align:top">${esc(k)}</td>` +
          `<td style="padding:4px 8px"><pre style="margin:0">${esc(v)}</pre></td></tr>`,
      )
      .join('');

  const pairs: [string, string][] = [
    ['ID',         event.id],
    ['Type',       event.type],
    ['Message',    event.message],
    ['App',        event.appId ?? 'unknown'],
    ['Timestamp',  new Date(event.timestamp).toISOString()],
    ['ReceivedAt', new Date(event.receivedAt).toISOString()],
    ['Status',     event.status],
  ];
  if (event.category)  pairs.push(['Category',  event.category]);
  if (event.tags?.length) pairs.push(['Tags', event.tags.join(', ')]);
  if (event.error)     pairs.push(['Error', `${event.error.name}: ${event.error.message}`]);
  if (event.error?.stack) pairs.push(['Stack', event.error.stack]);
  if (event.payload)   pairs.push(['Payload', JSON.stringify(event.payload, null, 2)]);
  if (event.context)   pairs.push(['Context', JSON.stringify(event.context, null, 2)]);

  return `
<html><body style="font-family:monospace;font-size:13px">
<h2 style="color:#c0392b">[${esc(event.type.toUpperCase())}] ${esc(event.message)}</h2>
<table style="border-collapse:collapse">${rows(pairs)}</table>
</body></html>`.trim();
}
```

- [ ] **Step 8: Create `src/server/notifications/utils/resolveOmit.ts`**

```typescript
import type { StoredTrackerEvent } from '../../../common/types';
import type { ChannelType } from '../INotificationAdapter';
import { NotificationCategory } from '../NotificationCategory';

export function resolveOmitFromFailedEvent(event: StoredTrackerEvent): ChannelType[] {
  if (event.category !== NotificationCategory.NotificationFailed) return [];
  const failedChannel = event.payload?.failedChannel as ChannelType | undefined;
  return failedChannel ? [failedChannel] : [];
}
```

- [ ] **Step 9: Commit**

```bash
cd /home/rw3iss/Sites/ven/new/tracker
git add src/server/notifications/
git commit -m "feat(notifications): add notification types, interfaces, channel config, and utilities"
```

---

### Task 3: NotificationDeduplicator

**Files:**
- Create: `src/server/notifications/NotificationDeduplicator.ts`
- Create: `tests/server/notifications/NotificationDeduplicator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/notifications/NotificationDeduplicator.test.ts`:

```typescript
import { NotificationDeduplicator } from '../../../src/server/notifications/NotificationDeduplicator';

describe('NotificationDeduplicator', () => {
  it('returns false on first call (not seen)', () => {
    const d = new NotificationDeduplicator(60_000);
    expect(d.seen('evt-1:email')).toBe(false);
  });

  it('returns true on second call within window (seen)', () => {
    const d = new NotificationDeduplicator(60_000);
    d.seen('evt-1:email'); // first — marks as seen
    expect(d.seen('evt-1:email')).toBe(true);
  });

  it('returns false after window expires', () => {
    jest.useFakeTimers();
    const d = new NotificationDeduplicator(500);
    d.seen('evt-1:email');
    jest.advanceTimersByTime(501);
    expect(d.seen('evt-1:email')).toBe(false);
    jest.useRealTimers();
  });

  it('different keys do not collide', () => {
    const d = new NotificationDeduplicator(60_000);
    d.seen('evt-1:email');
    expect(d.seen('evt-1:sms')).toBe(false);
    expect(d.seen('evt-2:email')).toBe(false);
  });

  it('clear() resets all entries', () => {
    const d = new NotificationDeduplicator(60_000);
    d.seen('evt-1:email');
    d.clear();
    expect(d.seen('evt-1:email')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest tests/server/notifications/NotificationDeduplicator.test.ts --no-coverage 2>&1 | tail -10
```

Expected: FAIL — `NotificationDeduplicator` not found.

- [ ] **Step 3: Implement `src/server/notifications/NotificationDeduplicator.ts`**

```typescript
/**
 * In-memory TTL deduplicator for notification dispatch.
 *
 * Key format: `${canonicalEventId}:${channelType}`
 * - For normal events: canonicalEventId = event.id
 * - For notification-failed events: canonicalEventId = event.payload.originalEventId ?? event.id
 *
 * seen() both checks AND marks the key as seen in one call.
 */
export class NotificationDeduplicator {
  private readonly map = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  /**
   * Returns true if this key was seen within the window. Marks it as seen if not.
   */
  seen(key: string): boolean {
    const now = Date.now();
    this.evict(now);
    if (this.map.has(key)) return true;
    this.map.set(key, now + this.windowMs);
    return false;
  }

  clear(): void {
    this.map.clear();
  }

  private evict(now: number): void {
    for (const [k, expiry] of this.map) {
      if (expiry <= now) this.map.delete(k);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest tests/server/notifications/NotificationDeduplicator.test.ts --no-coverage
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/rw3iss/Sites/ven/new/tracker
git add src/server/notifications/NotificationDeduplicator.ts tests/server/notifications/NotificationDeduplicator.test.ts
git commit -m "feat(notifications): add NotificationDeduplicator with TTL in-memory map"
```

---

### Task 4: Default formatters

**Files:**
- Create: `src/server/notifications/formatters/defaultEmailFormatter.ts`
- Create: `src/server/notifications/formatters/defaultSmsFormatter.ts`
- Create: `src/server/notifications/formatters/defaultWebhookFormatter.ts`
- Create: `src/server/notifications/formatters/defaultFirebaseFormatter.ts`

- [ ] **Step 1: Create `src/server/notifications/formatters/defaultEmailFormatter.ts`**

```typescript
import type { NotificationData, EmailPayload } from '../types';
import { serializeEventToHtml, serializeEventToText } from '../utils/eventFormatters';
import type { StoredTrackerEvent } from '../../../common/types';

export function defaultEmailFormatter(
  data: NotificationData,
  recipients: string[],
  from: string,
): EmailPayload {
  const event = data.body as StoredTrackerEvent;
  return {
    from,
    to: recipients,
    subject: data.subject,
    html: serializeEventToHtml(event),
    text: serializeEventToText(event),
  };
}
```

- [ ] **Step 2: Create `src/server/notifications/formatters/defaultSmsFormatter.ts`**

```typescript
import type { NotificationData, SmsPayload } from '../types';
import { truncate } from '../utils/eventFormatters';

export function defaultSmsFormatter(data: NotificationData, to: string[]): SmsPayload {
  const msg = `[${data.subject}]`;
  return { to, body: truncate(msg, 160) };
}
```

- [ ] **Step 3: Create `src/server/notifications/formatters/defaultWebhookFormatter.ts`**

```typescript
import type { NotificationData, WebhookPayload } from '../types';

export function defaultWebhookFormatter(data: NotificationData): WebhookPayload {
  return { ...data } as WebhookPayload;
}
```

- [ ] **Step 4: Create `src/server/notifications/formatters/defaultFirebaseFormatter.ts`**

```typescript
import type { NotificationData, FirebasePayload } from '../types';
import { truncate } from '../utils/eventFormatters';
import type { StoredTrackerEvent } from '../../../common/types';

export function defaultFirebaseFormatter(
  data: NotificationData,
  tokens: string[],
): FirebasePayload {
  const event = data.body as StoredTrackerEvent;
  return {
    tokens,
    title: truncate(data.subject, 100),
    body: truncate(event.message ?? data.subject, 200),
    data: { eventId: event.id ?? '', type: event.type },
  };
}
```

- [ ] **Step 5: Commit**

```bash
cd /home/rw3iss/Sites/ven/new/tracker
git add src/server/notifications/formatters/
git commit -m "feat(notifications): add default channel formatters (email, sms, webhook, firebase)"
```

---

### Task 5: Email adapters

**Files:**
- Create: `src/server/notifications/channels/email/IEmailAdapter.ts`
- Create: `src/server/notifications/channels/email/SmtpAdapter.ts`
- Create: `src/server/notifications/channels/email/SendGridApiAdapter.ts`
- Create: `src/server/notifications/channels/email/MailgunAdapter.ts`
- Create: `src/server/notifications/channels/email/PostmarkAdapter.ts`

- [ ] **Step 1: Create `src/server/notifications/channels/email/IEmailAdapter.ts`**

```typescript
import type { INotificationAdapter } from '../../INotificationAdapter';

export interface IEmailAdapter extends INotificationAdapter {
  readonly channelType: 'email';
}
```

- [ ] **Step 2: Create `src/server/notifications/channels/email/SmtpAdapter.ts`**

```typescript
import type { IEmailAdapter } from './IEmailAdapter';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { EmailPayload } from '../../types';

export interface SmtpAdapterConfig {
  host:   string;
  port:   number;
  secure: boolean;
  auth:   { user: string; pass: string };
}

export class SmtpAdapter implements IEmailAdapter {
  readonly channelType = 'email' as const;
  private transporter: import('nodemailer').Transporter | null = null;

  constructor(private readonly config: SmtpAdapterConfig) {}

  private async getTransporter(): Promise<import('nodemailer').Transporter> {
    if (!this.transporter) {
      const nodemailer = await import('nodemailer');
      this.transporter = nodemailer.createTransport(this.config);
    }
    return this.transporter;
  }

  async send(payload: FormattedNotification): Promise<void> {
    const email = payload.raw as EmailPayload;
    const transport = await this.getTransporter();
    await transport.sendMail({
      from:    email.from,
      to:      email.to.join(', '),
      subject: email.subject,
      html:    email.html,
      text:    email.text,
    });
  }
}
```

- [ ] **Step 3: Create `src/server/notifications/channels/email/SendGridApiAdapter.ts`**

```typescript
import type { IEmailAdapter } from './IEmailAdapter';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { EmailPayload } from '../../types';

export interface SendGridApiAdapterConfig {
  apiKey: string;
}

export class SendGridApiAdapter implements IEmailAdapter {
  readonly channelType = 'email' as const;

  constructor(private readonly config: SendGridApiAdapterConfig) {}

  async send(payload: FormattedNotification): Promise<void> {
    const email = payload.raw as EmailPayload;
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: email.to.map((e) => ({ email: e })) }],
        from: { email: email.from },
        subject: email.subject,
        content: [
          { type: 'text/html',  value: email.html },
          { type: 'text/plain', value: email.text },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`SendGrid error ${response.status}: ${await response.text()}`);
    }
  }
}
```

- [ ] **Step 4: Create `src/server/notifications/channels/email/MailgunAdapter.ts`**

```typescript
import type { IEmailAdapter } from './IEmailAdapter';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { EmailPayload } from '../../types';

export interface MailgunAdapterConfig {
  apiKey: string;
  domain: string;
  /** 'api.mailgun.net' for US, 'api.eu.mailgun.net' for EU. Default: 'api.mailgun.net' */
  host?:  string;
}

export class MailgunAdapter implements IEmailAdapter {
  readonly channelType = 'email' as const;

  constructor(private readonly config: MailgunAdapterConfig) {}

  async send(payload: FormattedNotification): Promise<void> {
    const email  = payload.raw as EmailPayload;
    const host   = this.config.host ?? 'api.mailgun.net';
    const auth   = Buffer.from(`api:${this.config.apiKey}`).toString('base64');
    const form   = new URLSearchParams({
      from:    email.from,
      to:      email.to.join(','),
      subject: email.subject,
      html:    email.html,
      text:    email.text,
    });

    const response = await fetch(
      `https://${host}/v3/${this.config.domain}/messages`,
      {
        method:  'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    form.toString(),
      },
    );
    if (!response.ok) {
      throw new Error(`Mailgun error ${response.status}: ${await response.text()}`);
    }
  }
}
```

- [ ] **Step 5: Create `src/server/notifications/channels/email/PostmarkAdapter.ts`**

```typescript
import type { IEmailAdapter } from './IEmailAdapter';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { EmailPayload } from '../../types';

export interface PostmarkAdapterConfig {
  serverToken: string;
}

export class PostmarkAdapter implements IEmailAdapter {
  readonly channelType = 'email' as const;

  constructor(private readonly config: PostmarkAdapterConfig) {}

  async send(payload: FormattedNotification): Promise<void> {
    const email = payload.raw as EmailPayload;
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': this.config.serverToken,
        'Content-Type':            'application/json',
        Accept:                    'application/json',
      },
      body: JSON.stringify({
        From:     email.from,
        To:       email.to.join(','),
        Subject:  email.subject,
        HtmlBody: email.html,
        TextBody: email.text,
      }),
    });
    if (!response.ok) {
      throw new Error(`Postmark error ${response.status}: ${await response.text()}`);
    }
  }
}
```

- [ ] **Step 6: Commit**

```bash
cd /home/rw3iss/Sites/ven/new/tracker
git add src/server/notifications/channels/email/
git commit -m "feat(notifications): add email adapters (SMTP, SendGrid, Mailgun, Postmark)"
```

---

### Task 6: SMS, Webhook, and Firebase adapters

**Files:**
- Create: `src/server/notifications/channels/sms/TwilioSmsAdapter.ts`
- Create: `src/server/notifications/channels/webhook/WebhookAdapter.ts`
- Create: `src/server/notifications/channels/firebase/FirebaseAdapter.ts`

- [ ] **Step 1: Create `src/server/notifications/channels/sms/TwilioSmsAdapter.ts`**

```typescript
import type { ISmsAdapter } from '../../channels/ChannelConfig';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { SmsPayload } from '../../types';

export interface TwilioSmsAdapterConfig {
  accountSid: string;
  authToken:  string;
  from:       string;
}

export class TwilioSmsAdapter implements ISmsAdapter {
  readonly channelType = 'sms' as const;

  constructor(private readonly config: TwilioSmsAdapterConfig) {}

  async send(payload: FormattedNotification): Promise<void> {
    const sms  = payload.raw as SmsPayload;
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');
    const url  = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;

    const errors: string[] = [];
    await Promise.allSettled(
      sms.to.map(async (to) => {
        const form = new URLSearchParams({ From: this.config.from, To: to, Body: sms.body });
        const response = await fetch(url, {
          method:  'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    form.toString(),
        });
        if (!response.ok) {
          errors.push(`${to}: ${response.status} ${await response.text()}`);
        }
      }),
    );
    if (errors.length > 0) {
      throw new Error(`Twilio errors: ${errors.join('; ')}`);
    }
  }
}
```

- [ ] **Step 2: Create `src/server/notifications/channels/webhook/WebhookAdapter.ts`**

```typescript
import type { IWebhookAdapter } from '../../channels/ChannelConfig';
import type { FormattedNotification } from '../../INotificationAdapter';

export interface WebhookAdapterConfig {
  url:        string;
  headers?:   Record<string, string>;
  timeoutMs?: number;
}

export class WebhookAdapter implements IWebhookAdapter {
  readonly channelType = 'webhook' as const;

  constructor(private readonly config: WebhookAdapterConfig) {}

  async send(payload: FormattedNotification): Promise<void> {
    const controller = new AbortController();
    const timeoutMs  = this.config.timeoutMs ?? 10_000;
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.config.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...(this.config.headers ?? {}) },
        body:    JSON.stringify(payload.raw),
        signal:  controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Webhook ${this.config.url} responded ${response.status}: ${await response.text()}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 3: Create `src/server/notifications/channels/firebase/FirebaseAdapter.ts`**

```typescript
import type { IFirebaseAdapter } from '../../channels/ChannelConfig';
import type { FormattedNotification } from '../../INotificationAdapter';
import type { FirebasePayload } from '../../types';

export interface FirebaseAdapterConfig {
  /** Service account object from your Firebase project (imported from JSON). */
  serviceAccount: Record<string, unknown>;
}

/**
 * Firebase Cloud Messaging adapter using the FCM HTTP v1 API via firebase-admin.
 * firebase-admin must be installed in the consuming project.
 */
export class FirebaseAdapter implements IFirebaseAdapter {
  readonly channelType = 'firebase' as const;
  private adminApp: import('firebase-admin').app.App | null = null;

  constructor(private readonly config: FirebaseAdapterConfig) {}

  private async getApp(): Promise<import('firebase-admin').app.App> {
    if (!this.adminApp) {
      const admin = await import('firebase-admin');
      // Use a uniquely-named app to avoid conflicts if firebase-admin is already initialized
      const appName = `tracker-notifications-${Date.now()}`;
      this.adminApp = admin.initializeApp(
        { credential: admin.credential.cert(this.config.serviceAccount as import('firebase-admin').ServiceAccount) },
        appName,
      );
    }
    return this.adminApp;
  }

  async send(payload: FormattedNotification): Promise<void> {
    const fcm   = payload.raw as FirebasePayload;
    const app   = await this.getApp();
    const admin = await import('firebase-admin');

    const response = await admin.messaging(app).sendEachForMulticast({
      tokens:       fcm.tokens,
      notification: { title: fcm.title, body: fcm.body },
      data:         fcm.data,
    });

    const failed = response.responses.filter((r) => !r.success);
    if (failed.length > 0) {
      throw new Error(
        `Firebase FCM: ${failed.length}/${fcm.tokens.length} sends failed: ` +
          failed.map((r) => r.error?.message).join('; '),
      );
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
cd /home/rw3iss/Sites/ven/new/tracker
git add src/server/notifications/channels/sms/ \
  src/server/notifications/channels/webhook/ \
  src/server/notifications/channels/firebase/
git commit -m "feat(notifications): add SMS (Twilio), Webhook, and Firebase FCM adapters"
```

---

### Task 7: Unsent notification storage

**Files:**
- Create: `src/server/notifications/storage/IUnsentNotificationStorage.ts`
- Create: `src/server/notifications/storage/UnsentNotificationEntity.ts`
- Create: `src/server/notifications/storage/TypeOrmUnsentNotificationStorage.ts`

- [ ] **Step 1: Create `src/server/notifications/storage/IUnsentNotificationStorage.ts`**

```typescript
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
```

- [ ] **Step 2: Create `src/server/notifications/storage/UnsentNotificationEntity.ts`**

```typescript
import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn,
} from 'typeorm';
import type { ChannelType } from '../INotificationAdapter';

@Entity('tracker_unsent_notifications')
@Index(['channelType'])
@Index(['originalEventId'])
@Index(['createdAt'])
export class UnsentNotificationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  channelType!: ChannelType;

  @Column({ type: 'varchar', nullable: true })
  appId!: string | null;

  @Column({ type: 'text' })
  recipientInfo!: string;

  @Column({ type: 'text' })
  formattedPayload!: string;

  @Column({ type: 'text' })
  errorMessage!: string;

  @Column({ type: 'varchar', nullable: true })
  originalEventId!: string | null;

  @Column({ type: 'int', default: 0 })
  retryCount!: number;

  @Column({ type: 'timestamp', nullable: true })
  lastAttemptAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
```

- [ ] **Step 3: Create `src/server/notifications/storage/TypeOrmUnsentNotificationStorage.ts`**

```typescript
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
```

- [ ] **Step 4: Commit**

```bash
cd /home/rw3iss/Sites/ven/new/tracker
git add src/server/notifications/storage/
git commit -m "feat(notifications): add unsent notification storage interface, entity, and TypeORM implementation"
```

---

### Task 8: NotificationDispatcher

**Files:**
- Create: `src/server/notifications/NotificationDispatcher.ts`
- Create: `tests/server/notifications/NotificationDispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/server/notifications/NotificationDispatcher.test.ts`:

```typescript
import { NotificationDispatcher } from '../../../src/server/notifications/NotificationDispatcher';
import { NotificationDeduplicator } from '../../../src/server/notifications/NotificationDeduplicator';
import { NotificationCategory } from '../../../src/server/notifications/NotificationCategory';
import { TrackerEventStatus } from '../../../src/common/types';
import type { StoredTrackerEvent } from '../../../src/common/types';
import type { ChannelConfigMap } from '../../../src/server/notifications/channels/ChannelConfig';
import type { ITrackerServiceRef } from '../../../src/server/ITrackerPlugin';
import type { FormattedNotification } from '../../../src/server/notifications/INotificationAdapter';

function makeEvent(overrides: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent {
  return {
    id:         'evt-1',
    type:       'error',
    message:    'something broke',
    status:     TrackerEventStatus.New,
    timestamp:  Date.now(),
    receivedAt: Date.now(),
    ...overrides,
  };
}

function makeEmailAdapter(fail = false) {
  return {
    channelType: 'email' as const,
    send: jest.fn(async (_p: FormattedNotification) => {
      if (fail) throw new Error('smtp timeout');
    }),
  };
}

function makeWebhookAdapter(fail = false) {
  return {
    channelType: 'webhook' as const,
    send: jest.fn(async (_p: FormattedNotification) => {
      if (fail) throw new Error('connection refused');
    }),
  };
}

function makeTrackerService(): jest.Mocked<ITrackerServiceRef> {
  return { track: jest.fn().mockResolvedValue(undefined) };
}

describe('NotificationDispatcher', () => {
  it('calls configured channel adapter with formatted payload', async () => {
    const emailAdapter = makeEmailAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator: new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId: 'test-app',
    });

    await dispatcher.notify({ subject: 'Test error', body: makeEvent() });
    expect(emailAdapter.send).toHaveBeenCalledTimes(1);
    const call = emailAdapter.send.mock.calls[0][0];
    expect(call.channelType).toBe('email');
  });

  it('omit skips the specified channel', async () => {
    const emailAdapter = makeEmailAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator: new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId: 'test-app',
    });

    await dispatcher.notify({ subject: 'Test', body: makeEvent() }, { omit: ['email'] });
    expect(emailAdapter.send).not.toHaveBeenCalled();
  });

  it('omit takes precedence over include', async () => {
    const emailAdapter = makeEmailAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator: new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId: 'test-app',
    });

    await dispatcher.notify(
      { subject: 'Test', body: makeEvent() },
      { include: ['email'], omit: ['email'] },
    );
    expect(emailAdapter.send).not.toHaveBeenCalled();
  });

  it('deduplicates identical (eventId, channelType) within window', async () => {
    const emailAdapter = makeEmailAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator: new NotificationDeduplicator(60_000),
      trackerService: makeTrackerService(),
      appId: 'test-app',
    });

    const event = makeEvent();
    await dispatcher.notify({ subject: 'Test', body: event });
    await dispatcher.notify({ subject: 'Test', body: event });
    expect(emailAdapter.send).toHaveBeenCalledTimes(1);
  });

  it('uses originalEventId as dedup key for notification-failed events', async () => {
    const emailAdapter = makeEmailAdapter();
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const deduplicator = new NotificationDeduplicator(60_000);
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator,
      trackerService: makeTrackerService(),
      appId: 'test-app',
    });

    // Simulate: normal event was already dispatched (evt-1:email seen)
    const originalEvent = makeEvent({ id: 'evt-1' });
    await dispatcher.notify({ subject: 'Original', body: originalEvent });
    expect(emailAdapter.send).toHaveBeenCalledTimes(1);

    // Now a notification-failed event for evt-1 tries to re-notify via email
    const failedEvent = makeEvent({
      id: 'evt-failed-1',
      category: NotificationCategory.NotificationFailed,
      payload: { originalEventId: 'evt-1', failedChannel: 'webhook' },
    });
    await dispatcher.notify({ subject: 'Retry', body: failedEvent });
    // evt-1:email was already seen — dedup blocks it
    expect(emailAdapter.send).toHaveBeenCalledTimes(1);
  });

  it('records tracker error event on adapter failure', async () => {
    const emailAdapter = makeEmailAdapter(true); // throws
    const channels: Partial<ChannelConfigMap> = {
      email: { adapter: emailAdapter, recipients: ['ops@example.com'], from: 'noreply@example.com' },
    };
    const trackerService = makeTrackerService();
    const dispatcher = new NotificationDispatcher({
      channels,
      deduplicator: new NotificationDeduplicator(60_000),
      trackerService,
      appId: 'test-app',
    });

    await dispatcher.notify({ subject: 'Test', body: makeEvent() });
    expect(trackerService.track).toHaveBeenCalledTimes(1);
    const call = trackerService.track.mock.calls[0][0];
    expect(call.type).toBe('error');
    expect(call.category).toBe(NotificationCategory.NotificationFailed);
    expect(call.payload?.failedChannel).toBe('email');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest tests/server/notifications/NotificationDispatcher.test.ts --no-coverage 2>&1 | tail -10
```

Expected: FAIL — `NotificationDispatcher` not found.

- [ ] **Step 3: Implement `src/server/notifications/NotificationDispatcher.ts`**

```typescript
import type { StoredTrackerEvent, TrackerEvent } from '../../common/types';
import type { ITrackerServiceRef } from '../ITrackerPlugin';
import type { ChannelType } from './INotificationAdapter';
import type { NotificationData, NotificationDispatchOptions, EmailPayload, SmsPayload, WebhookPayload, FirebasePayload } from './types';
import type { ChannelConfigMap } from './channels/ChannelConfig';
import type { IUnsentNotificationStorage } from './storage/IUnsentNotificationStorage';
import { NotificationDeduplicator } from './NotificationDeduplicator';
import { NotificationCategory } from './NotificationCategory';
import {
  defaultEmailFormatter,
} from './formatters/defaultEmailFormatter';
import { defaultSmsFormatter } from './formatters/defaultSmsFormatter';
import { defaultWebhookFormatter } from './formatters/defaultWebhookFormatter';
import { defaultFirebaseFormatter } from './formatters/defaultFirebaseFormatter';

export interface NotificationDispatcherConfig {
  channels?:       Partial<ChannelConfigMap>;
  deduplicator:    NotificationDeduplicator;
  trackerService:  ITrackerServiceRef;
  appId?:          string;
  unsentStorage?:  IUnsentNotificationStorage;
}

export class NotificationDispatcher {
  constructor(private readonly cfg: NotificationDispatcherConfig) {}

  async notify(
    data: NotificationData,
    opts?: NotificationDispatchOptions,
  ): Promise<void> {
    const channels = this.cfg.channels ?? {};
    const omit     = new Set<ChannelType>(opts?.omit ?? []);

    // Resolve effective channel set: all configured, filtered by omit
    let effective: ChannelType[] = (Object.keys(channels) as ChannelType[]).filter(
      (ch) => !omit.has(ch),
    );

    // Add any explicitly included channels (if configured and not omitted)
    if (opts?.include) {
      for (const ch of opts.include) {
        if (omit.has(ch)) continue;
        if (!channels[ch]) {
          // Unconfigured channel requested — emit tracker error, skip
          await this.cfg.trackerService.track(this.buildUnconfiguredChannelError(ch, data));
          continue;
        }
        if (!effective.includes(ch)) effective.push(ch);
      }
    }

    // Compute canonical event ID for dedup
    const body = data.body as StoredTrackerEvent;
    const canonicalId =
      body.category === NotificationCategory.NotificationFailed
        ? ((body.payload?.originalEventId as string | undefined) ?? body.id)
        : body.id;

    // Dispatch all channels in parallel; dedup before sending
    const channelSends = effective.map(async (channelType) => {
      const dedupKey = `${canonicalId}:${channelType}`;
      if (this.cfg.deduplicator.seen(dedupKey)) return;

      const formatted = this.format(channelType, data, channels);
      const adapter   = (channels[channelType] as { adapter: { send(p: any): Promise<void> } }).adapter;
      await adapter.send({ channelType, raw: formatted });
    });

    const results = await Promise.allSettled(channelSends);

    // Handle failures
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const channelType = effective[i];
        const error       = result.reason as Error;
        await this.handleFailure(channelType, data, error, channels);
      }
    }
  }

  private format(
    channelType: ChannelType,
    data: NotificationData,
    channels: Partial<ChannelConfigMap>,
  ): unknown {
    switch (channelType) {
      case 'email': {
        const cfg = channels.email!;
        const fmt = cfg.formatter ?? defaultEmailFormatter;
        return fmt(data, cfg.recipients, cfg.from);
      }
      case 'sms': {
        const cfg = channels.sms!;
        const fmt = cfg.formatter ?? defaultSmsFormatter;
        return fmt(data, cfg.to);
      }
      case 'webhook': {
        const cfg = channels.webhook!;
        const fmt = cfg.formatter ?? defaultWebhookFormatter;
        return fmt(data);
      }
      case 'firebase': {
        const cfg = channels.firebase!;
        const fmt = cfg.formatter ?? defaultFirebaseFormatter;
        return fmt(data, cfg.tokens);
      }
    }
  }

  private async handleFailure(
    channelType: ChannelType,
    data: NotificationData,
    error: Error,
    channels: Partial<ChannelConfigMap>,
  ): Promise<void> {
    const body = data.body as StoredTrackerEvent;
    const failureEvent: TrackerEvent = {
      type:      'error',
      category:  NotificationCategory.NotificationFailed,
      appId:     this.cfg.appId,
      message:   `Notification failed [${channelType}]: ${error.message}`,
      timestamp: Date.now(),
      payload: {
        failedChannel:       channelType,
        originalEventId:     body.id,
        adapterError:        error.message,
        notificationSubject: data.subject,
      },
    };

    await this.cfg.trackerService.track(failureEvent);

    if (this.cfg.unsentStorage) {
      const formatted = this.format(channelType, data, channels);
      const cfg = channels[channelType] as { recipients?: string[]; to?: string[]; url?: string; tokens?: string[] } | undefined;
      const recipientInfo = JSON.stringify(
        cfg?.recipients ?? cfg?.to ?? (cfg as any)?.url ?? cfg?.tokens ?? [],
      );
      await this.cfg.unsentStorage.save({
        channelType,
        appId:            this.cfg.appId,
        recipientInfo,
        formattedPayload: JSON.stringify(formatted),
        errorMessage:     error.message,
        originalEventId:  body.id,
        retryCount:       0,
      }).catch(() => {}); // unsent-storage failures must not throw
    }
  }

  private buildUnconfiguredChannelError(ch: ChannelType, data: NotificationData): TrackerEvent {
    return {
      type:      'error',
      category:  NotificationCategory.NotificationFailed,
      appId:     this.cfg.appId,
      message:   `Notification channel '${ch}' is not configured`,
      timestamp: Date.now(),
      payload: {
        requestedChannel:    ch,
        notificationSubject: data.subject,
      },
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest tests/server/notifications/NotificationDispatcher.test.ts --no-coverage
```

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/rw3iss/Sites/ven/new/tracker
git add src/server/notifications/NotificationDispatcher.ts tests/server/notifications/NotificationDispatcher.test.ts
git commit -m "feat(notifications): add NotificationDispatcher with channel resolution, dedup, and failure tracking"
```

---

### Task 9: NotifyOnErrorsStrategy and TrackerNotificationsPlugin

**Files:**
- Create: `src/server/notifications/strategies/NotifyOnErrorsStrategy.ts`
- Create: `src/server/notifications/TrackerNotificationsPlugin.ts`
- Create: `tests/server/notifications/NotifyOnErrorsStrategy.test.ts`
- Create: `tests/server/notifications/TrackerNotificationsPlugin.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/server/notifications/NotifyOnErrorsStrategy.test.ts`:

```typescript
import { NotifyOnErrorsStrategy } from '../../../src/server/notifications/strategies/NotifyOnErrorsStrategy';
import { NotificationCategory } from '../../../src/server/notifications/NotificationCategory';
import { TrackerEventStatus } from '../../../src/common/types';
import type { StoredTrackerEvent } from '../../../src/common/types';
import type { NotificationDispatcher } from '../../../src/server/notifications/NotificationDispatcher';

function makeEvent(overrides: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent {
  return {
    id:         'evt-1',
    type:       'error',
    message:    'something broke',
    status:     TrackerEventStatus.New,
    timestamp:  Date.now(),
    receivedAt: Date.now(),
    ...overrides,
  };
}

function makeDispatcher() {
  return { notify: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<NotificationDispatcher>;
}

describe('NotifyOnErrorsStrategy', () => {
  it('calls dispatcher.notify for error events', async () => {
    const strategy   = new NotifyOnErrorsStrategy();
    const dispatcher = makeDispatcher();
    await strategy.onEvent(makeEvent({ type: 'error' }), dispatcher);
    expect(dispatcher.notify).toHaveBeenCalledTimes(1);
  });

  it('skips non-error events', async () => {
    const strategy   = new NotifyOnErrorsStrategy();
    const dispatcher = makeDispatcher();
    await strategy.onEvent(makeEvent({ type: 'info' }), dispatcher);
    expect(dispatcher.notify).not.toHaveBeenCalled();
  });

  it('includes email and webhook in opts.include', async () => {
    const strategy   = new NotifyOnErrorsStrategy();
    const dispatcher = makeDispatcher();
    await strategy.onEvent(makeEvent(), dispatcher);
    const opts = dispatcher.notify.mock.calls[0][1];
    expect(opts?.include).toContain('email');
    expect(opts?.include).toContain('webhook');
  });

  it('omits the failed channel for notification-failed events', async () => {
    const strategy   = new NotifyOnErrorsStrategy();
    const dispatcher = makeDispatcher();
    const event = makeEvent({
      category: NotificationCategory.NotificationFailed,
      payload: { failedChannel: 'email', originalEventId: 'evt-0' },
    });
    await strategy.onEvent(event, dispatcher);
    const opts = dispatcher.notify.mock.calls[0][1];
    expect(opts?.omit).toContain('email');
  });
});
```

Create `tests/server/notifications/TrackerNotificationsPlugin.test.ts`:

```typescript
import { TrackerNotificationsPlugin } from '../../../src/server/notifications/TrackerNotificationsPlugin';
import { TrackerEventStatus } from '../../../src/common/types';
import type { StoredTrackerEvent } from '../../../src/common/types';
import type { ITrackerServiceRef } from '../../../src/server/ITrackerPlugin';
import type { INotificationStrategy } from '../../../src/server/notifications/INotificationStrategy';
import type { NotificationDispatcher } from '../../../src/server/notifications/NotificationDispatcher';

function makeEvent(): StoredTrackerEvent {
  return {
    id: 'evt-1', type: 'error', message: 'boom',
    status: TrackerEventStatus.New, timestamp: 1, receivedAt: 1,
  };
}

function makeTrackerService(): jest.Mocked<ITrackerServiceRef> {
  return { track: jest.fn().mockResolvedValue(undefined) };
}

function makeStrategy(): jest.Mocked<INotificationStrategy> {
  return { onEvent: jest.fn().mockResolvedValue(undefined) };
}

describe('TrackerNotificationsPlugin', () => {
  it('onInit stores tracker service reference', async () => {
    const strategy = makeStrategy();
    const plugin   = TrackerNotificationsPlugin.create({ strategies: [strategy] });
    const svc      = makeTrackerService();
    await plugin.onInit(svc);
    // onEvent will pass the dispatcher which has trackerService
    await plugin.onEvent(makeEvent());
    expect(strategy.onEvent).toHaveBeenCalledTimes(1);
  });

  it('onEvent calls all strategies independently', async () => {
    const s1 = makeStrategy();
    const s2 = makeStrategy();
    const plugin = TrackerNotificationsPlugin.create({ strategies: [s1, s2] });
    await plugin.onInit(makeTrackerService());
    await plugin.onEvent(makeEvent());
    expect(s1.onEvent).toHaveBeenCalledTimes(1);
    expect(s2.onEvent).toHaveBeenCalledTimes(1);
  });

  it('onEvent continues even if one strategy throws', async () => {
    const s1 = makeStrategy();
    s1.onEvent.mockRejectedValue(new Error('strategy failed'));
    const s2 = makeStrategy();
    const plugin = TrackerNotificationsPlugin.create({ strategies: [s1, s2] });
    await plugin.onInit(makeTrackerService());
    await expect(plugin.onEvent(makeEvent())).resolves.toBeUndefined();
    expect(s2.onEvent).toHaveBeenCalledTimes(1);
  });

  it('throws if onEvent called before onInit', async () => {
    const plugin = TrackerNotificationsPlugin.create({ strategies: [] });
    await expect(plugin.onEvent(makeEvent())).rejects.toThrow('TrackerNotificationsPlugin.onInit');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest tests/server/notifications/NotifyOnErrorsStrategy.test.ts tests/server/notifications/TrackerNotificationsPlugin.test.ts --no-coverage 2>&1 | tail -10
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/server/notifications/strategies/NotifyOnErrorsStrategy.ts`**

```typescript
import type { StoredTrackerEvent } from '../../../common/types';
import type { INotificationStrategy } from '../INotificationStrategy';
import type { NotificationDispatcher } from '../NotificationDispatcher';
import { resolveOmitFromFailedEvent } from '../utils/resolveOmit';

export class NotifyOnErrorsStrategy implements INotificationStrategy {
  async onEvent(event: StoredTrackerEvent, dispatcher: NotificationDispatcher): Promise<void> {
    if (event.type !== 'error') return;

    const omit = resolveOmitFromFailedEvent(event);

    await dispatcher.notify(
      {
        subject: `[Error] ${event.message}`,
        body:    event,
      },
      { omit, include: ['email', 'webhook'] },
    );
  }
}
```

- [ ] **Step 4: Implement `src/server/notifications/TrackerNotificationsPlugin.ts`**

```typescript
import type { StoredTrackerEvent } from '../../common/types';
import type { ITrackerPlugin, ITrackerServiceRef } from '../ITrackerPlugin';
import type { INotificationStrategy } from './INotificationStrategy';
import type { IUnsentNotificationStorage } from './storage/IUnsentNotificationStorage';
import type { ChannelConfigMap } from './channels/ChannelConfig';
import { NotificationDeduplicator } from './NotificationDeduplicator';
import { NotificationDispatcher } from './NotificationDispatcher';

export interface TrackerNotificationsConfig {
  /** Must match the appId used in TrackerModule — used in error tracking. */
  appId?: string;
  /** One or more strategies to run per event. Executed in order, independently. */
  strategies: INotificationStrategy[];
  /** Channel configurations. Only configured channels can be dispatched to. */
  channels?: Partial<ChannelConfigMap>;
  /** Deduplication window. Default: 60_000 ms. */
  deduplication?: { windowMs: number };
  /** Optional storage for failed notifications. */
  unsentStorage?: IUnsentNotificationStorage;
}

export class TrackerNotificationsPlugin implements ITrackerPlugin {
  private dispatcher: NotificationDispatcher | null = null;

  private constructor(private readonly config: TrackerNotificationsConfig) {}

  static create(config: TrackerNotificationsConfig): TrackerNotificationsPlugin {
    return new TrackerNotificationsPlugin(config);
  }

  async onInit(trackerService: ITrackerServiceRef): Promise<void> {
    const deduplicator = new NotificationDeduplicator(
      this.config.deduplication?.windowMs ?? 60_000,
    );
    this.dispatcher = new NotificationDispatcher({
      channels:       this.config.channels,
      deduplicator,
      trackerService,
      appId:          this.config.appId,
      unsentStorage:  this.config.unsentStorage,
    });
  }

  async onEvent(event: StoredTrackerEvent): Promise<void> {
    if (!this.dispatcher) {
      throw new Error(
        'TrackerNotificationsPlugin.onInit() must be called before onEvent(). ' +
          'Ensure the plugin is registered in TrackerModule.register({ plugins: [...] }).',
      );
    }

    for (const strategy of this.config.strategies) {
      try {
        await strategy.onEvent(event, this.dispatcher);
      } catch {
        // Individual strategy errors must not block others or interrupt ingestion
      }
    }
  }

  onDestroy(): void {
    this.dispatcher = null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest tests/server/notifications/ --no-coverage
```

Expected: All notification tests PASS.

- [ ] **Step 6: Run full test suite**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest --no-coverage
```

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/rw3iss/Sites/ven/new/tracker
git add src/server/notifications/strategies/ src/server/notifications/TrackerNotificationsPlugin.ts \
  tests/server/notifications/
git commit -m "feat(notifications): add NotifyOnErrorsStrategy and TrackerNotificationsPlugin"
```

---

### Task 10: Package wiring — index.ts, tsup, package.json, jest.config.js, nodemailer dep

**Files:**
- Create: `src/server/notifications/index.ts`
- Modify: `tsup.config.ts`
- Modify: `package.json`
- Modify: `jest.config.js`

- [ ] **Step 1: Create `src/server/notifications/index.ts`**

```typescript
// Plugin
export { TrackerNotificationsPlugin } from './TrackerNotificationsPlugin';
export type { TrackerNotificationsConfig } from './TrackerNotificationsPlugin';

// Category constants
export { NotificationCategory } from './NotificationCategory';
export type { NotificationCategoryValue } from './NotificationCategory';

// Interfaces
export type { INotificationStrategy } from './INotificationStrategy';
export type { INotificationAdapter, ChannelType, FormattedNotification } from './INotificationAdapter';

// Types
export type {
  NotificationData, NotificationDispatchOptions,
  EmailPayload, SmsPayload, WebhookPayload, FirebasePayload,
  EmailFormatter, SmsFormatter, WebhookFormatter, FirebaseFormatter,
} from './types';

// Channel config types
export type {
  IEmailAdapter, ISmsAdapter, IWebhookAdapter, IFirebaseAdapter,
  EmailChannelConfig, SmsChannelConfig, WebhookChannelConfig, FirebaseChannelConfig,
  ChannelConfigMap,
} from './channels/ChannelConfig';

// Built-in strategy
export { NotifyOnErrorsStrategy } from './strategies/NotifyOnErrorsStrategy';

// Email adapters
export { SmtpAdapter } from './channels/email/SmtpAdapter';
export type { SmtpAdapterConfig } from './channels/email/SmtpAdapter';
export { SendGridApiAdapter } from './channels/email/SendGridApiAdapter';
export type { SendGridApiAdapterConfig } from './channels/email/SendGridApiAdapter';
export { MailgunAdapter } from './channels/email/MailgunAdapter';
export type { MailgunAdapterConfig } from './channels/email/MailgunAdapter';
export { PostmarkAdapter } from './channels/email/PostmarkAdapter';
export type { PostmarkAdapterConfig } from './channels/email/PostmarkAdapter';

// SMS adapters
export { TwilioSmsAdapter } from './channels/sms/TwilioSmsAdapter';
export type { TwilioSmsAdapterConfig } from './channels/sms/TwilioSmsAdapter';

// Webhook adapters
export { WebhookAdapter } from './channels/webhook/WebhookAdapter';
export type { WebhookAdapterConfig } from './channels/webhook/WebhookAdapter';

// Firebase adapters
export { FirebaseAdapter } from './channels/firebase/FirebaseAdapter';
export type { FirebaseAdapterConfig } from './channels/firebase/FirebaseAdapter';

// Default formatters
export { defaultEmailFormatter } from './formatters/defaultEmailFormatter';
export { defaultSmsFormatter } from './formatters/defaultSmsFormatter';
export { defaultWebhookFormatter } from './formatters/defaultWebhookFormatter';
export { defaultFirebaseFormatter } from './formatters/defaultFirebaseFormatter';

// Unsent storage
export type { IUnsentNotificationStorage, UnsentNotificationRecord, StoredUnsentNotification } from './storage/IUnsentNotificationStorage';
export { UnsentNotificationEntity } from './storage/UnsentNotificationEntity';
export { TypeOrmUnsentNotificationStorage } from './storage/TypeOrmUnsentNotificationStorage';

// Utilities
export { isErrorEvent, isNotificationFailedEvent, matchesCategory, matchesType, matchesAppId } from './utils/eventFilters';
export { serializeEventToText, serializeEventToHtml, truncate } from './utils/eventFormatters';
export { resolveOmitFromFailedEvent } from './utils/resolveOmit';

// Dispatcher (exported for custom strategy implementations)
export { NotificationDispatcher } from './NotificationDispatcher';
export type { NotificationDispatcherConfig } from './NotificationDispatcher';
export { NotificationDeduplicator } from './NotificationDeduplicator';
```

- [ ] **Step 2: Update `tsup.config.ts` to add the fourth entry**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/common/index.ts' },
    outDir: 'dist/common',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
  },
  {
    entry: { index: 'src/client/index.ts' },
    outDir: 'dist/client',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'neutral',
  },
  {
    entry: { index: 'src/server/index.ts' },
    outDir: 'dist/server',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'node',
    external: [
      '@nestjs/common',
      '@nestjs/core',
      'typeorm',
      'class-validator',
      'class-transformer',
    ],
  },
  {
    entry: { index: 'src/server/notifications/index.ts' },
    outDir: 'dist/server/notifications',
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    platform: 'node',
    external: [
      '@nestjs/common',
      '@nestjs/core',
      'typeorm',
      'nodemailer',
      'firebase-admin',
    ],
  },
]);
```

- [ ] **Step 3: Update `package.json` — add `./notifications` export and `nodemailer` optionalDependency**

Add to `exports`:
```json
"./notifications": {
  "import": "./dist/server/notifications/index.js",
  "require": "./dist/server/notifications/index.cjs",
  "types": "./dist/server/notifications/index.d.ts"
}
```

Add to `optionalDependencies`:
```json
"nodemailer": "^6.9.0"
```

Add to `devDependencies`:
```json
"@types/nodemailer": "^6.4.0"
```

Add to `peerDependencies`:
```json
"nodemailer": ">=6",
"firebase-admin": ">=12"
```

Add to `peerDependenciesMeta`:
```json
"nodemailer": { "optional": true },
"firebase-admin": { "optional": true }
```

- [ ] **Step 4: Update `jest.config.js` to add notifications mapping**

```javascript
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  verbose: true,
  roots: ['<rootDir>/tests'],
  moduleNameMapper: {
    '^@rw3iss/tracker$': '<rootDir>/src/common/index.ts',
    '^@rw3iss/tracker/client$': '<rootDir>/src/client/index.ts',
    '^@rw3iss/tracker/server$': '<rootDir>/src/server/index.ts',
    '^@rw3iss/tracker/notifications$': '<rootDir>/src/server/notifications/index.ts',
  },
};
```

- [ ] **Step 5: Install nodemailer and types**

```
cd /home/rw3iss/Sites/ven/new/tracker && npm install --save-optional nodemailer && npm install --save-dev @types/nodemailer
```

- [ ] **Step 6: Run build to verify tsup compiles all four entries**

```
cd /home/rw3iss/Sites/ven/new/tracker && npm run build 2>&1 | tail -20
```

Expected: build succeeds, `dist/server/notifications/` contains `index.js`, `index.cjs`, `index.d.ts`.

- [ ] **Step 7: Run full test suite**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest --no-coverage
```

Expected: All tests PASS.

- [ ] **Step 8: Run typecheck**

```
cd /home/rw3iss/Sites/ven/new/tracker && npm run typecheck
```

Expected: No errors.

- [ ] **Step 9: Commit**

```bash
cd /home/rw3iss/Sites/ven/new/tracker
git add src/server/notifications/index.ts tsup.config.ts package.json package-lock.json jest.config.js
git commit -m "feat(notifications): wire package exports, tsup build entry, jest mapping, nodemailer dep"
```

---

### Task 11: NOTIFICATIONS.md

**Files:**
- Create: `NOTIFICATIONS.md`

- [ ] **Step 1: Create `NOTIFICATIONS.md`**

See the content defined inline below. Write it to `NOTIFICATIONS.md` at the repo root.

```markdown
# @rw3iss/tracker — Notifications Plugin

The notifications plugin adds optional alerting to `@rw3iss/tracker`. When an event is stored, configured strategies decide whether and how to notify — via email, SMS, webhook, or Firebase push.

The core `@rw3iss/tracker/server` module has zero knowledge of this plugin. It is wired in via the `plugins` option in `TrackerModule.register()`.

---

## Installation

The notifications plugin is part of the `@rw3iss/tracker` package. Import from the dedicated subpath:

```typescript
import { /* ... */ } from '@rw3iss/tracker/notifications';
```

Depending on which adapters you use, you may need to install optional peer dependencies:

| Adapter | Required package |
|---|---|
| `SmtpAdapter` | `npm install nodemailer` |
| `FirebaseAdapter` | `npm install firebase-admin` |
| All other adapters | _(uses native `fetch` — no extra install)_ |

---

## Quick Start — Email notifications on every error

```typescript
import { TrackerModule } from '@rw3iss/tracker/server';
import {
  TrackerNotificationsPlugin,
  NotifyOnErrorsStrategy,
  SmtpAdapter,
} from '@rw3iss/tracker/notifications';
import { TypeOrmTrackerStorage } from '@rw3iss/tracker/server';

TrackerModule.register({
  storage: new TypeOrmTrackerStorage(trackerEventRepo),
  plugins: [
    TrackerNotificationsPlugin.create({
      appId: 'my-api',
      strategies: [new NotifyOnErrorsStrategy()],
      channels: {
        email: {
          adapter: new SmtpAdapter({
            host:   'smtp.sendgrid.net',
            port:   587,
            secure: false,
            auth:   { user: 'apikey', pass: process.env.SENDGRID_API_KEY! },
          }),
          recipients: ['ops@example.com'],
          from:       'alerts@example.com',
        },
      },
      deduplication: { windowMs: 60_000 },
    }),
  ],
});
```

After this setup, every `type: 'error'` event stored by the tracker will trigger an email to `ops@example.com`.

---

## Channel Adapters

### Email — SMTP (`SmtpAdapter`)

Connects to any SMTP server, including relay services like SendGrid or Mailgun in SMTP mode.

```typescript
import { SmtpAdapter } from '@rw3iss/tracker/notifications';

new SmtpAdapter({
  host:   'smtp.sendgrid.net',
  port:   587,
  secure: false,
  auth:   { user: 'apikey', pass: process.env.SENDGRID_API_KEY! },
})
```

### Email — SendGrid REST API (`SendGridApiAdapter`)

Uses the SendGrid HTTP API directly (no SMTP relay, higher throughput).

```typescript
import { SendGridApiAdapter } from '@rw3iss/tracker/notifications';

new SendGridApiAdapter({ apiKey: process.env.SENDGRID_API_KEY! })
```

### Email — Mailgun (`MailgunAdapter`)

```typescript
import { MailgunAdapter } from '@rw3iss/tracker/notifications';

new MailgunAdapter({
  apiKey: process.env.MAILGUN_API_KEY!,
  domain: 'mg.example.com',
  host:   'api.eu.mailgun.net', // optional; default 'api.mailgun.net'
})
```

### Email — Postmark (`PostmarkAdapter`)

```typescript
import { PostmarkAdapter } from '@rw3iss/tracker/notifications';

new PostmarkAdapter({ serverToken: process.env.POSTMARK_TOKEN! })
```

### SMS — Twilio (`TwilioSmsAdapter`)

```typescript
import { TwilioSmsAdapter } from '@rw3iss/tracker/notifications';

new TwilioSmsAdapter({
  accountSid: process.env.TWILIO_SID!,
  authToken:  process.env.TWILIO_TOKEN!,
  from:       '+15005550006',
})
```

Channel config:
```typescript
channels: {
  sms: {
    adapter:    new TwilioSmsAdapter({ ... }),
    to:         ['+12025551234', '+12025555678'],
  },
}
```

### Webhook (`WebhookAdapter`)

Posts a JSON payload to any URL.

```typescript
import { WebhookAdapter } from '@rw3iss/tracker/notifications';

new WebhookAdapter({
  url:       'https://hooks.example.com/alerts',
  headers:   { 'X-Secret': process.env.WEBHOOK_SECRET! },
  timeoutMs: 5_000,
})
```

Channel config:
```typescript
channels: {
  webhook: { adapter: new WebhookAdapter({ ... }) },
}
```

### Firebase FCM (`FirebaseAdapter`)

Sends push notifications via Firebase Cloud Messaging.

```typescript
import { FirebaseAdapter } from '@rw3iss/tracker/notifications';
import serviceAccount from './firebase-service-account.json';

new FirebaseAdapter({ serviceAccount })
```

Channel config:
```typescript
channels: {
  firebase: {
    adapter: new FirebaseAdapter({ serviceAccount }),
    tokens:  ['device-token-1', 'device-token-2'],
  },
}
```

---

## Built-in Strategies

### `NotifyOnErrorsStrategy`

Notifies via `email` and `webhook` channels whenever `event.type === 'error'`. Works with any combination of configured channels.

```typescript
import { NotifyOnErrorsStrategy } from '@rw3iss/tracker/notifications';

strategies: [new NotifyOnErrorsStrategy()]
```

---

## Writing a Custom Strategy

Implement `INotificationStrategy` — one method, no framework coupling:

```typescript
import type { INotificationStrategy } from '@rw3iss/tracker/notifications';
import type { StoredTrackerEvent } from '@rw3iss/tracker';
import type { NotificationDispatcher } from '@rw3iss/tracker/notifications';

export class NotifyOnCriticalPayloadStrategy implements INotificationStrategy {
  async onEvent(event: StoredTrackerEvent, dispatcher: NotificationDispatcher): Promise<void> {
    if (event.type !== 'error') return;
    if (event.payload?.severity !== 'critical') return;

    await dispatcher.notify(
      {
        subject: `[CRITICAL] ${event.message}`,
        body:    event,
        // extra fields are passed through to formatters
        severity: 'critical',
      },
      {
        include: ['email', 'sms', 'webhook'],
      },
    );
  }
}
```

Register it alongside other strategies:

```typescript
plugins: [
  TrackerNotificationsPlugin.create({
    strategies: [
      new NotifyOnErrorsStrategy(),
      new NotifyOnCriticalPayloadStrategy(),
    ],
    channels: { ... },
  }),
]
```

Multiple strategies run independently per event. One failing strategy does not skip the others.

---

## `dispatcher.notify()` — include and omit

Control which channels are used per notification call:

```typescript
// Only email — even if webhook is configured
await dispatcher.notify(data, { include: ['email'] });

// All configured channels except sms
await dispatcher.notify(data, { omit: ['sms'] });

// omit takes precedence — this sends to webhook only (email is excluded)
await dispatcher.notify(data, { include: ['email', 'webhook'], omit: ['email'] });
```

If `include` references a channel that has no adapter configured, a `type: 'error'` event with `category: 'notification-failed'` is recorded in the tracker (no exception is thrown).

---

## Custom Formatters

Override how data is shaped before reaching the adapter. Formatters are optional per channel.

```typescript
import type { EmailFormatter } from '@rw3iss/tracker/notifications';

const myEmailFormatter: EmailFormatter = (data, recipients, from) => ({
  from,
  to:      recipients,
  subject: `[ALERT] ${data.subject}`,
  html:    `<h1>${data.subject}</h1><pre>${JSON.stringify(data.body, null, 2)}</pre>`,
  text:    data.subject,
});

channels: {
  email: {
    adapter:   new SmtpAdapter({ ... }),
    recipients: ['ops@example.com'],
    from:       'alerts@example.com',
    formatter:  myEmailFormatter,
  },
}
```

Formatter signatures:

```typescript
type EmailFormatter   = (data: NotificationData, recipients: string[], from: string) => EmailPayload;
type SmsFormatter     = (data: NotificationData, to: string[]) => SmsPayload;
type WebhookFormatter = (data: NotificationData) => WebhookPayload;
type FirebaseFormatter = (data: NotificationData, tokens: string[]) => FirebasePayload;
```

---

## Loop Prevention

The plugin prevents notification cascades when a notification itself fails.

**Problem:** An `error` event is stored → notification sent → email fails → failure recorded as a new `error` event with `category: 'notification-failed'` → `NotifyOnErrorsStrategy` sees another error → tries to notify again → could loop forever.

**Solution — two guards:**

1. **Category-based omit (primary):** `NotifyOnErrorsStrategy` calls `resolveOmitFromFailedEvent(event)` which reads `event.payload.failedChannel` and passes it as `omit`. So if email failed, the retry skips email and tries other channels.

2. **Deduplication (secondary):** `NotificationDeduplicator` tracks `(canonicalEventId, channelType)` pairs within the configured window (default 60 seconds). For `notification-failed` events, the canonical ID is `event.payload.originalEventId` (not the failure event's own ID). This means all retry attempts share the same dedup space as the original dispatch.

**Walk-through with 2 channels (email, webhook):**

1. `evt-1` error stored → `notify()` → email fails, webhook fails
2. Dedup records `evt-1:email` and `evt-1:webhook`
3. `notification-failed` (email) stored → strategy omits email → `notify()` tries webhook → dedup sees `evt-1:webhook` → **blocked**
4. `notification-failed` (webhook) stored → strategy omits webhook → `notify()` tries email → dedup sees `evt-1:email` → **blocked**
5. Done. Maximum adapter calls per original error: **N** (one per channel, all at step 1).

---

## Unsent Notification Storage

Failed notifications can be persisted for auditing or manual retry:

```typescript
import { TypeOrmUnsentNotificationStorage, UnsentNotificationEntity } from '@rw3iss/tracker/notifications';

// Add UnsentNotificationEntity to your TypeORM data source
const unsentRepo = dataSource.getRepository(UnsentNotificationEntity);

TrackerNotificationsPlugin.create({
  strategies:    [new NotifyOnErrorsStrategy()],
  channels:      { ... },
  unsentStorage: new TypeOrmUnsentNotificationStorage(unsentRepo),
})
```

Table: `tracker_unsent_notifications`

Columns: `id`, `channelType`, `appId`, `recipientInfo` (JSON), `formattedPayload` (JSON), `errorMessage`, `originalEventId`, `retryCount`, `lastAttemptAt`, `createdAt`.

Query pending records:
```typescript
const pending = await unsentStorage.findPending(50);
```

Mark as retried:
```typescript
await unsentStorage.markRetried(record.id, 'retry error message');
```

---

## Registering Multiple Strategies and Channels

```typescript
TrackerNotificationsPlugin.create({
  appId: 'my-api',
  strategies: [
    new NotifyOnErrorsStrategy(),
    new NotifyOnCriticalPayloadStrategy(),
  ],
  channels: {
    email: {
      adapter:    new SmtpAdapter({ host: 'smtp.sendgrid.net', port: 587, secure: false,
                                    auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY! } }),
      recipients: ['ops@example.com', 'oncall@example.com'],
      from:       'tracker@example.com',
    },
    webhook: {
      adapter: new WebhookAdapter({ url: process.env.SLACK_WEBHOOK_URL! }),
    },
    sms: {
      adapter: new TwilioSmsAdapter({ accountSid: process.env.TWILIO_SID!,
                                       authToken: process.env.TWILIO_TOKEN!,
                                       from: '+15005550006' }),
      to: ['+12025551234'],
    },
  },
  deduplication: { windowMs: 60_000 },
  unsentStorage: new TypeOrmUnsentNotificationStorage(unsentRepo),
})
```

---

## rw3iss API Default Configuration

The `./new/api` tracker registration uses:

```typescript
import {
  TrackerNotificationsPlugin,
  NotifyOnErrorsStrategy,
  SmtpAdapter,
  TypeOrmUnsentNotificationStorage,
  UnsentNotificationEntity,
} from '@rw3iss/tracker/notifications';

// In your TrackerModule registration (e.g. TrackerModule.ts in new/api):
TrackerModule.register({
  storage: new TypeOrmTrackerStorage(dataSource.getRepository(TrackerEventEntity)),
  plugins: [
    TrackerNotificationsPlugin.create({
      appId: 'rw3iss-api',
      strategies: [new NotifyOnErrorsStrategy()],
      channels: {
        email: {
          adapter: new SmtpAdapter({
            host:   'smtp.sendgrid.net',
            port:   587,
            secure: false,
            auth:   { user: 'apikey', pass: process.env.SENDGRID_API_KEY! },
          }),
          recipients: ['rw3iss@gmail.com'],
          from:       'support@ryanweiss.net',
        },
      },
      deduplication: { windowMs: 60_000 },
      unsentStorage: new TypeOrmUnsentNotificationStorage(
        dataSource.getRepository(UnsentNotificationEntity),
      ),
    }),
  ],
});
```

`.env.development` / `.env.production`:
```
SENDGRID_API_KEY=....
```

---

## Environment Variable Reference

| Variable | Used by | Notes |
|---|---|---|
| `SENDGRID_API_KEY` | `SmtpAdapter` (SendGrid relay) / `SendGridApiAdapter` | Required for email via SendGrid |
| `MAILGUN_API_KEY` | `MailgunAdapter` | Required for Mailgun |
| `POSTMARK_TOKEN` | `PostmarkAdapter` | Required for Postmark |
| `TWILIO_SID` | `TwilioSmsAdapter` | Required for SMS |
| `TWILIO_TOKEN` | `TwilioSmsAdapter` | Required for SMS |
| `SLACK_WEBHOOK_URL` | `WebhookAdapter` | If using Slack as a webhook target |

---

## Utility Functions

```typescript
import {
  isErrorEvent,
  isNotificationFailedEvent,
  matchesCategory,
  matchesType,
  matchesAppId,
  serializeEventToText,
  serializeEventToHtml,
  truncate,
  resolveOmitFromFailedEvent,
} from '@rw3iss/tracker/notifications';
```

Useful for building custom strategies:

```typescript
export class MyStrategy implements INotificationStrategy {
  async onEvent(event: StoredTrackerEvent, dispatcher: NotificationDispatcher) {
    if (!isErrorEvent(event)) return;
    if (!matchesAppId(event, 'payments-service')) return;

    const omit = resolveOmitFromFailedEvent(event);
    await dispatcher.notify({ subject: event.message, body: event }, { omit, include: ['email'] });
  }
}
```
```

- [ ] **Step 2: Run final test suite and typecheck**

```
cd /home/rw3iss/Sites/ven/new/tracker && npx jest --no-coverage && npm run typecheck
```

Expected: All tests PASS, no type errors.

- [ ] **Step 3: Commit**

```bash
cd /home/rw3iss/Sites/ven/new/tracker
git add NOTIFICATIONS.md
git commit -m "docs: add NOTIFICATIONS.md with comprehensive notifications plugin usage guide"
```
