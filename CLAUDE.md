# @rw3iss/tracker

Universal TypeScript event and error tracking library. Ships two halves:

- **Emitter** — the capture API (`TrackerClient`, `tracker` singleton). Runs anywhere events originate: browsers, Node backends, NestJS apps. This is what 95% of consumers import.
- **Consumer** — the NestJS processing engine (`TrackerModule`, `TrackerService`). Runs where events are received. Only `tracker-server` (or apps acting as their own tracker backend) imports this.

"Emitter" and "Consumer" replace the older "client" / "server" split, which conflated "browser vs backend" with "producer vs receiver".

## Quick Reference

```bash
pnpm install          # install deps
pnpm build            # build all entry points via tsup + SWC
pnpm test             # jest (296 tests, ~5s)
pnpm run typecheck    # tsc --noEmit
pnpm docs             # generate API docs to docs/api/
pnpm docs:serve       # generate + serve locally
```

**Registry:** npm (`@rw3iss` scope, public). Version: `0.6.0`.

## Architecture

```
TrackerClient (emitter — universal API, same everywhere)
├── capture/error/warn/info/debug/event/track
├── enrichers → plugins → beforeSend → rate limiting  (emitter pipeline)
└── ITrackerTransport (pluggable delivery)
      ├── HTTP (implicit) — queue → flush → POST to endpoint
      └── DirectTransport — TrackerService.track() in-process

TrackerService (consumer — NestJS processing engine)
├── track() — enrichers → onIngest → dedup → stamp → plugins
├── instance() — static accessor for non-DI code
└── NOT a capture API — always use TrackerClient as the API surface

@rw3iss/tracker
├── common/          # Shared types: EventType, TrackerEvent, ITrackerTransport
├── emitter/         # TrackerClient singleton + HTTP delivery
│   ├── plugins/     # BreadcrumbsPlugin + collectors (nav, click, console, network)
│   └── sw/          # Service Worker Background Sync module
├── consumer/        # NestJS module + DirectTransport + processing pipeline
│   ├── storage/     # ITrackerStorage + adapters (TypeORM, InMemory, Console, SQS) + QueryHelpers
│   ├── plugins/     # RateLimit, Aggregation, Retention, Forwarding, Prometheus
│   ├── enrichers/   # GeoIP, UserAgent, SourceMap
│   ├── notifications/  # Multi-channel alerts (email, Slack, Discord, SMS, webhook, Firebase)
│   └── cache/       # Dedup caches (InMemory, Redis)
└── cli/             # CLI tool for querying events
```

> The HTML dashboard lives in `@rw3iss/tracker-server` (its
> `TrackerDashboardModule`), not here. This library exposes the API
> the dashboard reads.

### Subpath Exports

| Import path | What it provides |
|---|---|
| `@rw3iss/tracker` (default) | **Emitter** — `TrackerClient`, `tracker` singleton, all types. The 95% case. |
| `@rw3iss/tracker/emitter` | Explicit alias for the default. |
| `@rw3iss/tracker/consumer` | NestJS engine — `TrackerModule`, `TrackerService`, `DirectTransport`, plugins, enrichers. |
| `@rw3iss/tracker/storage` | Storage plugin + adapters + `TrackerQueryHelpers`. |
| `@rw3iss/tracker/notifications` | Notification plugin + channel adapters. |
| `@rw3iss/tracker/breadcrumbs` | BreadcrumbsPlugin + collectors. |
| `@rw3iss/tracker/sw` | Service Worker sync module. |
| `@rw3iss/tracker/types` | Common types only — no runtime code. |

## Event Types

`'error' | 'warning' | 'info' | 'debug' | 'event'`

Severity ordering: `error > warning > info > debug > event`.

- `error` — exceptions, failed operations
- `warning` — degraded state, recoverable issues
- `info` — significant operations (login, checkout)
- `debug` — domain-specific diagnostic state (auction flag scenarios, weird data states)
- `event` — custom analytics/tracking events (always captured regardless of `minLevel`)

## Emitter Usage

```typescript
import { TrackerClient, tracker } from '@rw3iss/tracker';

TrackerClient.init({
  endpoint: 'https://tracker.ryanweiss.net/ingest/events',
  appId: 'buyer-portal',
  environment: 'production',
  appVersion: '36.0.0',

  // Master switch — false disables all tracking (default: true)
  enabled: true,

  // Minimum severity to capture (default: all). 'event' type always passes.
  minLevel: 'info',   // drops 'debug' events in production

  // Debug mode — logs internal activity to console
  debug: false,

  // Global namespace — access via window.tracker or global.tracker
  globalName: 'tracker',

  // Last-chance filter before queueing — return null to drop
  beforeSend: (event) => {
    if (event.payload?.password) return null;  // redact PII
    return event;
  },

  // Auto-capture: window.onerror (browser) or process.on('uncaughtException') (Node)
  autoCapture: true,

  // Browser-context auto-enrichment — stamps url, path, userAgent, language,
  // timezone, viewport, screen, referrer, connection on every event's context.
  // Default: true (all on). Set false to opt out entirely, or pass an object
  // to toggle individual fields. setContext()/enrichers can override these.
  autoEnrich: true,
  // autoEnrich: false,
  // autoEnrich: { userAgent: false, screen: false },

  // Capture failed network requests (fetch/XHR status >= 400)
  networkCapture: { errorsOnly: true },
});

// Convenience methods
tracker.error(new Error('Payment failed'));
tracker.warn('Auction ending soon', { auctionId: 123 });
tracker.info('User logged in');
tracker.debug('Bid state inconsistency', { expected: 5, got: 3 });
tracker.event('page_view', { page: '/auctions' });

// Domain-specific shorthand — auto-extracts category from "prefix:name"
tracker.track('auction:stale-state', { auctionId: 123 });
// Equivalent to: tracker.capture({ type: 'event', message: 'auction:stale-state', category: 'auction', payload: { auctionId: 123 } })

// Context management
tracker.setContext({ userId: 'user-123' });
tracker.setSessionId('session-456');

// Manual flush and cleanup
await tracker.flush();
await tracker.destroy();  // flushes, then tears down
```

## Consumer Usage (NestJS)

```typescript
import { TrackerModule } from '@rw3iss/tracker/consumer';
import { EventStoragePlugin, TypeOrmTrackerStorage } from '@rw3iss/tracker/storage';

@Module({
  imports: [
    TrackerModule.register({
      plugins: [
        new EventStoragePlugin(new TypeOrmTrackerStorage(dataSource)),
      ],
      deduplication: { enabled: true, windowMs: 300_000 },
      publicIngestion: true,  // bypass JWT guards on /api/events
    }),
  ],
})
export class AppModule {}
```

### In-process self-tracking

For a Node backend that wants to capture its own errors into its own `TrackerModule` (the `tracker-server` pattern), use `DirectTransport` so the emitter routes in-process:

```typescript
import { TrackerClient, tracker } from '@rw3iss/tracker';
import { TrackerService, DirectTransport } from '@rw3iss/tracker/consumer';

// After NestJS bootstraps (e.g. in main.ts or a module onModuleInit):
TrackerClient.init({
  appId: 'api-server',
  environment: 'production',
  transport: new DirectTransport(() => TrackerService.instance()),
  globalName: 'tracker',
});

// Use the same universal API as everywhere else:
tracker.error(new Error('Order creation failed'));
```

### HTTP Endpoints (exposed by the consumer)

| Method | Path | Description |
|---|---|---|
| POST | `/api/events` | Ingest single or batch |
| POST | `/api/events/stream` | NDJSON streaming ingest |
| GET | `/api/events` | Query with filters |
| GET | `/api/events/stream` | SSE live stream |
| PATCH | `/api/events/:id/status` | Update event status |
| GET | `/api/metrics` | Prometheus metrics |

Paths above use the default `ROUTE_PREFIX=api`. The dashboard
(`GET /dashboard` by default) is served by `@rw3iss/tracker-server`'s
own `TrackerDashboardModule` — see that repo for `DASHBOARD_PATH` /
`DASHBOARD_ENABLED`.

## Key Design Decisions

- **`destroy()` is async** — flushes the queue before tearing down. Always `await` it.
- **`trackBatch()` is parallel** when dedup is off, sequential when dedup is on (avoids race conditions on the dedup cache).
- **Node.js auto-capture** hooks `process.on('uncaughtException')` and `process.on('unhandledRejection')` — the Node equivalents of browser's `window.onerror`.
- **`enabled: false`** disables everything — no listeners, no queue, no flush. All methods become instant no-ops. Use for development or feature-flagging.
- **`minLevel`** filters by severity before any enrichment work. `'event'` type always passes (it's a category, not a severity).
- **`beforeSend`** runs after enrichers and plugins but before queueing. Return `null` to drop. Use for PII redaction or noise filtering.
- **`autoEnrich`** stamps browser-context fields (`url`, `path`, `userAgent`, `language`, `timezone`, `viewport`, `screen`, `referrer`, `connection`) on every event's `TrackerContext`. All on by default; pass `false` to opt out, or `{ field: false }` per field. Auto-enriched values are written *before* explicit `setContext()` and custom enrichers, so either can override them. Node: no-op (the source globals don't exist).
- **`globalName`** exposes the emitter instance on `globalThis` for console/REPL access.
- **Transport abstraction** — `TrackerClient` accepts either `endpoint` (built-in HTTP queue+flush) or `transport` (custom `ITrackerTransport`). The emitter pipeline (enrichers, plugins, beforeSend, rate limiting) runs identically regardless of transport. Transport only controls delivery.
- **`DirectTransport`** — for consumer-side self-tracking. Routes events from `TrackerClient` directly into `TrackerService.track()` — no HTTP, no queue, no serialization. The API surface is always `TrackerClient`, never `TrackerService` directly.
- **`TrackerService.instance()`** — static singleton accessor, set during `onModuleInit`, cleared on `onModuleDestroy`. Used by `DirectTransport` to lazily resolve the service, and by non-DI code that needs the processing engine directly.
- **Never use `TrackerClient` with `endpoint` pointed at the same process** — that's a wasteful localhost HTTP loop. Use `DirectTransport` instead.
- **`routePrefix`** — `TrackerModuleOptions.routePrefix` (default `'tracker'`) sets the API controller's path dynamically (events, metrics, status). `tracker-server` sets this to `'api'` by default via `ROUTE_PREFIX` env. No hardcoded prefix in the library.
- **`tableName`** — `TrackerModuleOptions.tableName` (default `'tracker_events'`) sets `process.env.TRACKER_TABLE_NAME` so the entity decorator reads it at import time. Also accepted by `ensureTrackerTable()`.
- **Self-seeding** — `ensureTrackerTable(dataSource, tableName?)` creates the table with indexes if it doesn't exist. No TypeORM migration needed. Call in the module factory or `main.ts`.
- **`typesVersions`** — package.json includes `typesVersions` for `node10` moduleResolution compatibility. Consumers don't need tsconfig path mappings.

## Testing

- Emitter tests use `jsdom` environment, consumer tests use `node`
- `fake-indexeddb` for IDB tests
- `@rw3iss/test-tools` for custom test utilities
- All peer deps are optional — the package works with just the emitter in any environment

## Build

- **tsup + SWC** — tsup handles bundling/entry points, SWC transpiles (preserves decorator metadata). When `emitDecoratorMetadata: true` in tsconfig.json and `@swc/core` is installed, tsup automatically uses SWC instead of esbuild.
- **EntitySchema** — `TrackerEventEntity` uses TypeORM's `EntitySchema` instead of `@Entity()` decorators. Works with any bundler since it's a runtime object, not decorator metadata.
- **`EventStoragePlugin.fromDataSource(ds)`** — zero-config storage setup. Uses raw SQL (`DataSourceTrackerStorage`), no entity registration needed in the consumer's DataSource.
- Explicit `@Inject()` decorators on NestJS constructors for bundler portability (don't rely on implicit `design:paramtypes`).

## File Conventions

- All timestamps are Unix ms (not seconds like the API server)
- Plugin interfaces: emitter = `ITrackerClientPlugin`, consumer = `ITrackerPlugin`
- Both use lifecycle hooks: `onInit`, `onCapture`/`onIngest`, `onEvent`, `onDestroy`
- Consumer plugins support topological ordering via `after: ['PluginName']`
