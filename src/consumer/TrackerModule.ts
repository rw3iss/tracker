import { DynamicModule, Module, SetMetadata, Type } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { TrackerAdminController } from './TrackerAdminController';
import { TrackerController } from './TrackerController';
import { TrackerService } from './TrackerService';
import { TrackerDeduplicator, DEDUP_PRESETS, buildFingerprintFromFields, DEFAULT_FINGERPRINT } from './TrackerDeduplicator';
import type { DedupBypassFn, DedupField, DedupFingerprintFn, DedupScope } from './TrackerDeduplicator';
import { InMemoryDeduplicationCache } from './cache/InMemoryDeduplicationCache';
import { TRACKER_ADMIN_KEY, TRACKER_API_KEY, TRACKER_DEDUPLICATOR, TRACKER_DISTINCT_CACHE_TTL_MS, TRACKER_MODULE_OPTIONS, TRACKER_PLUGINS } from './constants';
import type { ITrackerDeduplicationCache } from './cache/ITrackerDeduplicationCache';
import type { ITrackerPlugin } from './ITrackerPlugin';
import type { ServerEnricherFn } from './enrichers/index';

/** Default route prefix for tracker API endpoints (events, metrics, status, ...). */
const DEFAULT_ROUTE_PREFIX = 'tracker';

/**
 * Configuration for event deduplication.
 *
 * When enabled, events that share a fingerprint within the configured
 * window are silently dropped. The fingerprint is, by default, scoped
 * **per user** — two users hitting the same error don't dedupe each
 * other. Pick a different `scope`, or supply explicit `fields` /
 * `fingerprint` to change that.
 *
 * @example Per-session dedup
 * ```typescript
 * TrackerModule.register({
 *   deduplication: { enabled: true, scope: 'perSession' },
 * });
 * ```
 *
 * @example Custom fingerprint — dedup by orderId+type
 * ```typescript
 * TrackerModule.register({
 *   deduplication: {
 *     enabled: true,
 *     fingerprint: (e) => `${e.type}:${e.payload?.orderId ?? ''}`,
 *   },
 * });
 * ```
 *
 * @see {@link TrackerModuleOptions.deduplication}
 * @see DEDUP_PRESETS
 */
export interface TrackerDeduplicationOptions {
  /** Whether deduplication is enabled. */
  enabled:   boolean;
  /**
   * Time window in milliseconds for deduplication.
   * Events with the same fingerprint within this window are considered duplicates.
   * Maximum: 28,800,000 (8 hours).
   * @defaultValue `300_000` (5 minutes)
   */
  windowMs?: number;
  /**
   * Custom deduplication cache implementation.
   * @defaultValue {@link InMemoryDeduplicationCache}
   */
  cache?:    ITrackerDeduplicationCache;
  /**
   * Built-in scope preset. Picks one of {@link DEDUP_PRESETS}.
   *
   *   • `'perUser'`           default. Two users hitting the same error
   *                           get separate dedup keys.
   *   • `'perSession'`        adds `context.sessionId` so each browser
   *                           tab / session is independent.
   *   • `'perUserAndSession'` alias for `'perSession'`.
   *   • `'global'`            drops `context.userId` — every event is
   *                           deduped globally regardless of who hit it.
   *
   * Use this OR {@link fields} / {@link fingerprint}, not both. When
   * multiple are set: `fingerprint` wins, then `fields`, then `scope`.
   *
   * @defaultValue `'perUser'`
   */
  scope?:    DedupScope;
  /**
   * Explicit list of fields composing the fingerprint. Each entry is
   * either a top-level field name (`'appId'`, `'type'`, …), a dotted
   * path (`'context.sessionId'`, `'payload.orderId'`), or a function
   * `(event) => string`.
   *
   * Replaces the default field set entirely — there's no "merge with
   * default" mode. The default for reference:
   *
   * ```ts
   * ['appId','type','message','error.name','error.message','context.userId','context.environment']
   * ```
   */
  fields?:   ReadonlyArray<DedupField>;
  /**
   * Fully custom fingerprint. Receives the event, returns a string.
   * Wins over `fields` and `scope` when set.
   */
  fingerprint?: DedupFingerprintFn;
  /**
   * Predicate run before fingerprinting. Returning `true` skips dedup
   * entirely for that event — the cache is neither read nor written,
   * so a later dedupable event with the same fingerprint still gets a
   * clean first-occurrence pass.
   *
   * Use for intentional repeated events from the same user/session
   * (lifecycle markers, analytics, commit/started pairs). Composes
   * orthogonally with `scope` / `fields` / `fingerprint` — the
   * fingerprint shape is unchanged; only this predicate controls
   * whether dedup runs at all.
   *
   * @example Bypass bid lifecycle and all analytics events
   * ```typescript
   * deduplication: {
   *   enabled: true,
   *   bypassDedup: (e) =>
   *     e.type === 'event' ||
   *     e.message?.startsWith('bid.') === true,
   * }
   * ```
   */
  bypassDedup?: DedupBypassFn;
}

/**
 * Configuration options for the {@link TrackerModule}.
 *
 * @example
 * ```typescript
 * TrackerModule.register({
 *   routePrefix: 'monitoring',
 *   plugins: [EventStoragePlugin.create(storage)],
 *   deduplication: { enabled: true, windowMs: 300_000 },
 *   publicIngestion: true,
 * });
 * ```
 *
 * @see {@link TrackerModule.register}
 * @see {@link TrackerModule.registerAsync}
 */
export interface TrackerModuleOptions {
  /**
   * Route prefix for tracker **API** endpoints (events, metrics, status, ...).
   *
   * @defaultValue `'tracker'` -- routes at `/tracker/events`, `/tracker/metrics`, etc.
   *
   * @example
   * ```typescript
   * // Routes at /api/events, /api/metrics, etc.
   * TrackerModule.register({ routePrefix: 'api' });
   * ```
   *
   * @remarks The self-hosted HTML dashboard lives in `@rw3iss/tracker-server`
   * (see `TrackerDashboardModule` over there) — it's not part of this
   * library and isn't controlled from this options object.
   */
  routePrefix?:      string;

  /**
   * Database table name for tracker events storage.
   *
   * Sets `process.env.TRACKER_TABLE_NAME` so the entity picks it up at import time.
   * Must be set before `EventStoragePlugin` / `TrackerEventEntity` are imported.
   * When using `registerAsync`, the factory runs early enough.
   *
   * @defaultValue `'tracker_events'`
   */
  tableName?:        string;

  /**
   * Event deduplication configuration.
   *
   * @see {@link TrackerDeduplicationOptions}
   */
  deduplication?:    TrackerDeduplicationOptions;

  /**
   * Optional NestJS guard class to apply to tracker endpoints.
   * Registered as `APP_GUARD` in the module providers.
   */
  guardClass?:       Type<unknown>;

  /**
   * Server-side plugins that hook into the event processing pipeline.
   *
   * @see {@link ITrackerPlugin}
   */
  plugins?:          ITrackerPlugin[];

  /**
   * Server-side enricher functions that transform events during ingestion.
   * Run after `maxEventBytes` enforcement, before plugin `onIngest` hooks.
   *
   * @see {@link ServerEnricherFn}
   */
  serverEnrichers?:  ServerEnricherFn[];

  /**
   * Maximum allowed event size in bytes (JSON-serialized).
   * Events exceeding this limit have long string payload values truncated.
   * If still over the limit after truncation, the event is rejected.
   */
  maxEventBytes?:    number;

  /**
   * Maximum number of plugins to execute concurrently per wave during `onEvent`.
   * @defaultValue `Infinity` (all plugins in a wave run concurrently)
   */
  pluginConcurrency?: number;

  /**
   * Mount a Socket.IO gateway on the tracker namespace for WebSocket event ingestion.
   * Requires `@nestjs/websockets` and `@nestjs/platform-socket.io` in the host application.
   * @defaultValue `false`
   */
  socketGateway?:    boolean;

  /**
   * Mark tracker ingestion endpoints as public so standard JWT `APP_GUARD`s using the
   * `'isPublic'` metadata convention (NestJS docs standard) skip auth on them.
   * Set to `false` if you want tracker routes to require authentication.
   * @defaultValue `true`
   */
  publicIngestion?:  boolean;

  /**
   * API key(s) for server-to-server authentication.
   *
   * Accepts a single key or an array of keys (one per client).
   * Keys are SHA-256 hashed at startup -- raw values are never stored in memory.
   *
   * When set, ingestion endpoints validate the `X-Tracker-Key` header.
   * Revoking a key = remove it from this array; other clients are unaffected.
   * Browser clients (no header) are still allowed if `publicIngestion` is true.
   *
   * @defaultValue `undefined` (no key required)
   */
  apiKey?:           string | string[];

  /**
   * Shared secret for the admin endpoints (currently `POST
   * /api/admin/clear-events`). When set, the admin controller is
   * mounted and gates every request on `X-Tracker-Admin-Key`. When
   * unset, the controller isn't registered at all — admin routes
   * return 404 like any unknown path.
   *
   * Distinct from {@link apiKey} on purpose: ingest auth and admin
   * auth have different threat models, so they shouldn't share a
   * secret. Generate with `openssl rand -hex 32`.
   *
   * @defaultValue `undefined` (admin endpoints disabled)
   */
  adminKey?:         string;

  /**
   * TTL (in ms) for the in-process cache backing
   * `GET /events/distinct?field=…`. The cached set is small (one entry per
   * allow-listed field) and recomputable cheaply, so the only cost of a
   * lower TTL is more frequent SELECT-DISTINCT round trips.
   *
   * @defaultValue `60_000` (60 seconds)
   *
   * @example
   * ```typescript
   * TrackerModule.register({ distinctCacheTtlMs: 30_000 });   // 30s
   * TrackerModule.register({ distinctCacheTtlMs: 0 });        // disable cache
   * ```
   */
  distinctCacheTtlMs?: number;
}

/**
 * Async configuration options for {@link TrackerModule.registerAsync}.
 *
 * Allows resolving {@link TrackerModuleOptions} from injected dependencies
 * (e.g. ConfigService) at module initialization time.
 *
 * @example
 * ```typescript
 * TrackerModule.registerAsync({
 *   imports: [ConfigModule],
 *   inject: [ConfigService],
 *   useFactory: (config: ConfigService) => ({
 *     routePrefix: config.get('TRACKER_PREFIX', 'tracker'),
 *     plugins: [EventStoragePlugin.create(storage)],
 *   }),
 * });
 * ```
 *
 * @see {@link TrackerModule.registerAsync}
 */
export interface TrackerModuleAsyncOptions {
  /** NestJS injection tokens for the factory function. */
  inject?:     // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS injection token array
               any[];
  /** NestJS modules to import (e.g. ConfigModule). */
  imports?:    unknown[];
  /**
   * Factory function that returns {@link TrackerModuleOptions}.
   * Can be async. Receives injected dependencies as arguments.
   */
  useFactory:  (...args: // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS factory args
                         any[]) => TrackerModuleOptions | Promise<TrackerModuleOptions>;

  /**
   * Admin key. Same semantics as {@link TrackerModuleOptions.adminKey}.
   * Lives on the async options object so the admin controller can be
   * conditionally mounted at module-assembly time (the factory hasn't
   * run yet).
   *
   * @defaultValue `undefined` (admin endpoints disabled)
   */
  adminKey?:         string;

  /**
   * API route prefix. Same as {@link TrackerModuleOptions.routePrefix}.
   * Needed at the async layer too because the admin controller's path
   * is composed from it synchronously.
   *
   * @defaultValue `'tracker'`
   */
  routePrefix?:      string;
}

/**
 * Compose the dedup fingerprint function from the four ways a consumer
 * can configure it. Resolution order, highest priority first:
 *
 *   1. `fingerprint` — explicit function, ignores everything else.
 *   2. `fields`      — explicit field list.
 *   3. `scope`       — preset key from `DEDUP_PRESETS`.
 *   4. default       — `perUser` preset (matches the historical
 *                       hardcoded behaviour so existing deployments
 *                       upgrade without a behavioural change).
 */
function resolveFingerprint(opts: TrackerDeduplicationOptions): DedupFingerprintFn {
  if (opts.fingerprint) return opts.fingerprint;
  if (opts.fields)      return buildFingerprintFromFields(opts.fields);
  if (opts.scope)       return buildFingerprintFromFields(DEDUP_PRESETS[opts.scope]);
  return DEFAULT_FINGERPRINT;
}

function buildDeduplicatorProvider(options?: TrackerDeduplicationOptions) {
  const deduplicator =
    options?.enabled
      ? new TrackerDeduplicator(
          options.cache ?? new InMemoryDeduplicationCache(),
          Math.min(options.windowMs ?? 300_000, 28_800_000),
          resolveFingerprint(options),
          options.bypassDedup,
        )
      : null;
  return { provide: TRACKER_DEDUPLICATOR, useValue: deduplicator };
}

/** Standard NestJS auth-bypass metadata key (used by NestJS official docs + passport guide). */
const IS_PUBLIC_KEY = 'isPublic';

function applyPublicMetadata() {
  SetMetadata(IS_PUBLIC_KEY, true)(TrackerController);
}

function applyRoutePrefix(prefix: string) {
  Reflect.defineMetadata(PATH_METADATA, prefix, TrackerController);
}

function applyTableName(tableName?: string) {
  if (tableName) {
    process.env.TRACKER_TABLE_NAME = tableName;
  }
}

/**
 * NestJS dynamic module for registering the tracker server.
 *
 * Provides the {@link TrackerService} processing engine, HTTP endpoints via
 * {@link TrackerController}, and optional features (deduplication, storage,
 * WebSocket gateway, API key auth).
 *
 * The module is registered globally -- {@link TrackerService} is available
 * for injection in any module without re-importing.
 *
 * @example
 * ```typescript
 * // Synchronous registration
 * @Module({
 *   imports: [
 *     TrackerModule.register({
 *       plugins: [await EventStoragePlugin.fromDataSource(dataSource)],
 *       deduplication: { enabled: true },
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * @see {@link TrackerModuleOptions}
 * @see {@link TrackerModuleAsyncOptions}
 */
@Module({})
export class TrackerModule {
  /**
   * Register the tracker module with synchronous options.
   *
   * @param options - Module configuration options.
   * @returns A NestJS dynamic module definition.
   *
   * @see {@link TrackerModuleOptions}
   */
  static register(options: TrackerModuleOptions = {}): DynamicModule {
    applyTableName(options.tableName);
    applyRoutePrefix(options.routePrefix ?? DEFAULT_ROUTE_PREFIX);

    const providers: unknown[] = [
      buildDeduplicatorProvider(options.deduplication),
      { provide: TRACKER_PLUGINS, useValue: options.plugins ?? [] },
      { provide: TRACKER_MODULE_OPTIONS, useValue: options },
      { provide: TRACKER_API_KEY, useValue: options.apiKey ?? null },
      { provide: TRACKER_ADMIN_KEY, useValue: options.adminKey ?? null },
      { provide: TRACKER_DISTINCT_CACHE_TTL_MS, useValue: options.distinctCacheTtlMs ?? null },
      TrackerService,
    ];

    if (options.guardClass) {
      providers.push({ provide: 'APP_GUARD', useClass: options.guardClass });
    }

    if (options.socketGateway) {
      try {
        const { TrackerSocketIoGateway } = (() => { const p = './TrackerSocketIoGateway'; return require(p); })();
        providers.push(TrackerSocketIoGateway);
      } catch {
        throw new Error('[tracker] socketGateway requires @nestjs/websockets and @nestjs/platform-socket.io');
      }
    }

    if (options.publicIngestion !== false) {
      applyPublicMetadata();
    }

    const controllers: Array<Type<unknown>> = [TrackerController];
    // Admin controller is mounted only when an admin key is configured.
    // Without a key the routes return 404 — fail closed.
    if (options.adminKey) {
      // Mount admin routes under the configured route prefix —
      // /<routePrefix>/admin/clear-events. We use Reflect.defineMetadata
      // so the prefix change applies even when consumers override
      // routePrefix away from the default.
      Reflect.defineMetadata(
        PATH_METADATA,
        `${options.routePrefix ?? DEFAULT_ROUTE_PREFIX}/admin`,
        TrackerAdminController,
      );
      controllers.push(TrackerAdminController);
    }

    return {
      module:      TrackerModule,
      global:      true,
      providers:   providers as DynamicModule['providers'],
      controllers,
      exports:     [TrackerService],
    };
  }

  /**
   * Register the tracker module with async/factory options.
   *
   * Use this when options depend on injected services (e.g. ConfigService).
   *
   * @param options - Async module configuration with factory function.
   * @returns A NestJS dynamic module definition.
   *
   * @example
   * ```typescript
   * TrackerModule.registerAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: async (config: ConfigService) => ({
   *     apiKey: config.get('TRACKER_API_KEY'),
   *     plugins: [await EventStoragePlugin.fromDataSource(ds)],
   *   }),
   * });
   * ```
   *
   * @see {@link TrackerModuleAsyncOptions}
   */
  static registerAsync(options: TrackerModuleAsyncOptions): DynamicModule {
    const OPTIONS_TOKEN = 'TRACKER_MODULE_OPTIONS_TOKEN';

    const optionsProvider = {
      provide:    OPTIONS_TOKEN,
      useFactory: options.useFactory,
      inject:     (options.inject ?? []) as // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS injection tokens
                                            any[],
    };

    const deduplicatorProvider = {
      provide:    TRACKER_DEDUPLICATOR,
      useFactory: (opts: TrackerModuleOptions) =>
        buildDeduplicatorProvider(opts.deduplication).useValue,
      inject: [OPTIONS_TOKEN],
    };

    const pluginsProvider = {
      provide:    TRACKER_PLUGINS,
      useFactory: (opts: TrackerModuleOptions) => opts.plugins ?? [],
      inject:     [OPTIONS_TOKEN],
    };

    const moduleOptionsProvider = {
      provide:    TRACKER_MODULE_OPTIONS,
      useFactory: (opts: TrackerModuleOptions) => opts,
      inject:     [OPTIONS_TOKEN],
    };

    const apiKeyProvider = {
      provide:    TRACKER_API_KEY,
      useFactory: (opts: TrackerModuleOptions) => opts.apiKey ?? null,
      inject:     [OPTIONS_TOKEN],
    };

    const distinctTtlProvider = {
      provide:    TRACKER_DISTINCT_CACHE_TTL_MS,
      useFactory: (opts: TrackerModuleOptions) => opts.distinctCacheTtlMs ?? null,
      inject:     [OPTIONS_TOKEN],
    };

    // Admin key — pulled from the synchronous async-options field so
    // the controller has the value at construction. Falls back to
    // whatever the factory might also set, but the synchronous field
    // wins because it's required at module-assembly time.
    const adminKeyProvider = {
      provide:    TRACKER_ADMIN_KEY,
      useFactory: (opts: TrackerModuleOptions) => options.adminKey ?? opts.adminKey ?? null,
      inject:     [OPTIONS_TOKEN],
    };

    const initSideEffectProvider = {
      provide:    'TRACKER_MODULE_INIT',
      useFactory: (opts: TrackerModuleOptions) => {
        applyTableName(opts.tableName);
        applyRoutePrefix(opts.routePrefix ?? DEFAULT_ROUTE_PREFIX);
        if (opts.publicIngestion !== false) applyPublicMetadata();
        return null;
      },
      inject: [OPTIONS_TOKEN],
    };

    // Lazy-load socket gateway only when the consuming app opts in via socketGateway: true.
    // @nestjs/websockets is an optional peer dep — hard-requiring it here would crash
    // apps that don't install it.
    const socketGatewayProvider = {
      provide:    'TRACKER_SOCKET_GATEWAY',
      useFactory: (opts: TrackerModuleOptions) => {
        if (!opts.socketGateway) return null;
        try {
          const { TrackerSocketIoGateway } = (() => { const p = './TrackerSocketIoGateway'; return require(p); })();
          return new TrackerSocketIoGateway();
        } catch {
          throw new Error('[tracker] socketGateway requires @nestjs/websockets and @nestjs/platform-socket.io');
        }
      },
      inject: [OPTIONS_TOKEN],
    };

    // Admin controller mount is decided synchronously here — the
    // factory runs later than module assembly, so the admin key
    // lives on the async options object rather than inside
    // `useFactory`'s return value.
    const controllers: Array<Type<unknown>> = [TrackerController];
    if (options.adminKey) {
      Reflect.defineMetadata(
        PATH_METADATA,
        `${options.routePrefix ?? DEFAULT_ROUTE_PREFIX}/admin`,
        TrackerAdminController,
      );
      controllers.push(TrackerAdminController);
    }

    return {
      module:      TrackerModule,
      global:      true,
      imports:     (options.imports ?? []) as DynamicModule['imports'],
      providers:   [
        optionsProvider,
        deduplicatorProvider,
        pluginsProvider,
        moduleOptionsProvider,
        apiKeyProvider,
        adminKeyProvider,
        distinctTtlProvider,
        TrackerService,
        socketGatewayProvider,
        initSideEffectProvider,
      ] as DynamicModule['providers'],
      controllers,
      exports:     [TrackerService],
    };
  }
}
