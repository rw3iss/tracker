# @rw3iss/tracker — Improvement Ideas

A wide-ranging analysis of possible improvements to the tracker framework, covering architecture, client, server, storage, plugins, and developer experience. Not a roadmap — an idea space.

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Client](#2-client)
3. [Server ingestion pipeline](#3-server-ingestion-pipeline)
4. [Storage adapters](#4-storage-adapters)
5. [Message queue integration](#5-message-queue-integration)
6. [Plugin ecosystem](#6-plugin-ecosystem)
7. [Notifications plugin](#7-notifications-plugin)
8. [Observability & developer experience](#8-observability--developer-experience)
9. [Security](#9-security)
10. [Multi-tenancy & routing](#10-multi-tenancy--routing)

---

## 1. Architecture

### 1.1 Server-side enrichment pipeline

Currently enrichers only exist on the client. The server could have its own pipeline that runs before plugins are called — useful for things no client can supply.

```
ingest → validate → server enrichers → dedup → plugins
```

Server enrichers could add:
- Geo-IP data from the request IP
- Parsed user-agent (browser/OS/device) from the `context.userAgent` string
- Resolved stack frames via source maps
- PII scrubbing (strip/mask emails, tokens, credit card numbers from payload)
- Schema normalization (coerce legacy event shapes)

This would be a new `serverEnrichers?: ServerEnricherFn[]` option on `TrackerModuleOptions`, running in sequence before plugins are invoked.

### 1.2 Pre-storage plugin hooks

Right now plugins are called *after* the event is fully processed. A second hook type — `onIngest(event, ctx)` — could let plugins mutate or veto events before they reach downstream plugins. Useful for filtering, routing, and transformation.

```typescript
interface ITrackerPlugin {
  onIngest?(event: TrackerEvent, ctx: IngestContext): TrackerEvent | null | Promise<TrackerEvent | null>;
  onEvent(event: StoredTrackerEvent): void | Promise<void>;
}
// returning null from onIngest drops the event
```

This opens a clean separation: `onIngest` for transformation/filtering, `onEvent` for side effects.

### 1.3 Plugin dependency and ordering

Currently plugins receive events in declaration order, independently. Adding a lightweight ordering mechanism (`after: ['EventStoragePlugin']`) or explicit priority numbers would let plugins reliably assume other plugins have run.

### 1.4 Event schema versioning

Events could carry a `schemaVersion: number` field. The server could apply migration transformations when receiving events from older client versions — useful once multiple client versions are in the wild simultaneously.

### 1.5 Concurrent plugin execution

Fire all plugins in parallel with `Promise.allSettled` instead of sequentially, capped by a configurable concurrency limit. Plugins with heavy I/O (storage writes, HTTP calls) are the bottleneck in the current sequential model.

```typescript
plugins: { list: [...], concurrency: 4 }
```

---

## 2. Client

### 2.1 Sampling

Don't send every event — configurable by type and rate. Useful in high-traffic production environments to control volume without losing signal entirely.

```typescript
sampling: {
  error:   1.0,    // 100% of errors
  warning: 0.25,   // 25% of warnings
  info:    0.05,   // 5% of info events
  event:   0.10,
}
```

Sampling decisions are made at capture time in the client. The decision (sampled/not) could be recorded in `payload` so server-side analytics account for it.

### 2.2 Breadcrumbs

Record a rolling buffer of recent events (navigation, user interactions, XHR calls, console output) that are attached to the next `error` event as context. This is the "what happened before the crash" trail.

```typescript
breadcrumbs: {
  enabled:  true,
  maxItems: 20,
  captureConsole: ['warn', 'error'],
  captureNavigation: true,
  captureClicks: true,
}
```

Breadcrumbs are attached to the `payload.breadcrumbs` array on the next `type: 'error'` event and then cleared.

### 2.3 Performance metrics

Capture Web Vitals (LCP, FID/INP, CLS, TTFB) and custom performance marks as `type: 'event'` events with `category: 'performance'`. Could use `PerformanceObserver` internally.

```typescript
performance: {
  enabled:   true,
  webVitals: true,
  marks:     true,    // capture performance.mark() calls
}
```

### 2.4 Network request tracking

Intercept `fetch` and `XMLHttpRequest` to capture slow or failed requests as tracker events. Configurable URL filters to exclude noise (e.g. tracker's own endpoint).

```typescript
networkTracking: {
  enabled:       true,
  captureErrors: true,     // 4xx/5xx responses
  captureSlow:   5_000,    // requests taking longer than 5s
  ignoreUrls:    [/tracker\/events/],
}
```

### 2.5 Session ID and session recording hooks

Auto-generate a `sessionId` per browser session (stored in `sessionStorage`) and attach it to context automatically. This replaces the current manual `setContext({ sessionId: '...' })` pattern.

For session recording, expose lifecycle hooks that a screen-recording library (e.g. rrweb) can call to annotate the recording with tracker event IDs — and vice versa, attach recording segment IDs to tracker events.

### 2.6 Cross-tab deduplication and coordination (DONE)

Use `BroadcastChannel` so multiple tabs don't each flush the same event independently. One "leader" tab owns the flush interval; others enqueue locally and delegate via broadcast.

### 2.7 Service worker transport (DONE)

An optional service worker transport replaces the `fetch`-based flusher. Benefits:
- Events can be sent after a page closes (via Background Sync API)
- Survives network interruptions more reliably than localStorage fallback
- Single flush origin for all tabs

### 2.8 Framework integrations (separate packages)

Thin wrappers that plug into framework error boundaries and lifecycle hooks:

- `@rw3iss/tracker-react` — React `ErrorBoundary` component that auto-captures render errors with component stack
- `@rw3iss/tracker-vue` — `app.config.errorHandler` integration
- `@rw3iss/tracker-angular` — `ErrorHandler` integration
- `@rw3iss/tracker-node` — `process.on('uncaughtException')` / `unhandledRejection` auto-capture with async context tracking (AsyncLocalStorage for request correlation)

### 2.9 Client-side rate limiting

Prevent event storms from a single client — e.g. an unhandled error inside a `requestAnimationFrame` loop, a recursive call that throws, or instrumentation accidentally placed inside a hot render path. Without a limiter, a few lines of bad code can saturate the outbound queue and flood the server with thousands of near-identical events before the flush interval even fires.

**Algorithm: token bucket per event type**

A token bucket is the right fit here. Each event `type` (`error`, `warning`, `info`, `event`) has its own bucket: a capacity (max burst) and a refill rate (tokens per second). Each captured event costs one token. If the bucket is empty the event is dropped and a counter is incremented. Tokens refill continuously based on elapsed wall-clock time — no interval timer needed.

A sliding window would work too but requires storing an array of timestamps per type; the token bucket achieves the same sustained-rate enforcement with just two numbers (current tokens + last-refill timestamp) per type.

```typescript
rateLimit: {
  error:   { capacity: 20, refillPerSec: 2  },   // burst of 20, sustain 2/s
  warning: { capacity: 50, refillPerSec: 10 },
  info:    { capacity: 50, refillPerSec: 10 },
  event:   { capacity: 50, refillPerSec: 10 },
  // summary event emitted when any bucket has dropped events:
  summaryIntervalMs: 30_000,
}
```

Omitting a type means unlimited for that type. `capacity` controls the burst ceiling; `refillPerSec` controls the sustained rate after the burst is spent.

**Where it hooks in**

The check happens in `TrackerClient.capture()` immediately before the enricher pipeline — there is no point running enrichers on an event that will be discarded:

```typescript
capture(event: Omit<TrackerEvent, 'timestamp' | 'context' | 'appId'>): void {
  if (this.rateLimiter && !this.rateLimiter.allow(event.type)) {
    return;   // dropped; limiter records the count internally
  }
  // ... existing enricher + enqueueWithPlugins logic
}
```

The `RateLimiter` class is a small standalone unit (no browser APIs needed, pure math) and can live at `src/client/RateLimiter.ts`. It is initialised in `configure()` when `config.rateLimit` is present and torn down in `destroy()`.

**Summary events**

Silently dropping events makes debugging hard — the developer sees fewer events than expected and has no way to know the limiter fired. To surface this, the limiter emits a synthetic `type: 'event'` summary on a configurable interval whenever the drop count is non-zero. This event bypasses the rate limiter itself (to avoid suppressing the summary) and goes directly to `enqueueWithPlugins`:

```typescript
// emitted at most once per summaryIntervalMs if any events were dropped
{
  type:     'event',
  category: 'tracker:rate-limit',
  message:  'tracker rate limit: events dropped',
  payload: {
    dropped: { error: 147, warning: 0, info: 3, event: 0 },
    windowMs: 30_000,
  },
}
```

The counters reset after each summary event is emitted. If no events were dropped in the window, no summary is sent.

**Design notes**

- The `capacity` default should be generous enough that normal error handling (a few rapid retries, an error boundary firing once) is never throttled. The limiter is a last-resort backstop against runaway loops, not a tight budget.
- Calling `tracker.destroy()` should flush any non-zero drop counters as a final summary event before tearing down, so no information is lost when a page unloads.
- In `development` / `staging` environments, it may be preferable to emit a `console.warn` on the first drop in a window so the developer notices immediately rather than waiting for the summary interval.

### 2.10 Offline-first queue with IndexedDB

Replace the localStorage fallback with IndexedDB for much larger storage capacity. localStorage is synchronous and capped at ~5MB. An IndexedDB-backed queue survives page reloads and long offline periods with no size constraint.

---

## 3. Server ingestion pipeline

### 3.1 Streaming batch endpoint

The current `POST /tracker/events` endpoint processes the whole body before responding. For large batches, a streaming approach using Node.js streams could begin processing events as they arrive rather than buffering the full payload.

### 3.2 WebSocket / SSE ingestion

An alternative `WS /tracker/ws` ingestion endpoint would let long-lived clients (Node.js services, Electron apps) stream events over a persistent connection rather than opening a new HTTP connection per batch. Lower overhead, better for high-frequency sources.

### 3.3 Rate limiting per source

Apply per-`appId` or per-IP rate limits at the ingestion point, returning `429 Too Many Requests` when exceeded. Configurable as a `TrackerModule` option or as an `onIngest` plugin.

```typescript
rateLimit: {
  windowMs: 60_000,
  maxEvents: 1_000,   // per appId per window
}
```

### 3.4 Event aggregation / rollup

Instead of storing every identical error individually, aggregate duplicate events in a time window and store a single record with a `count` field. Dramatically reduces storage at high error rates. Configurable on the storage plugin.

```typescript
EventStoragePlugin.create(adapter, {
  rollup: { windowMs: 60_000 }
})
```

### 3.5 Retention and purge

A background job that deletes events older than a configurable retention window. Could run as a plugin with `onInit` scheduling an interval, or integrate with a cron adapter.

```typescript
EventRetentionPlugin.create({ maxAgeDays: 90, batchSize: 1_000 })
```

### 3.6 Event replay

Record incoming events to a secondary append-only log (e.g. Redis Streams or a local file), independent of the main storage plugin. This allows replaying events through a new plugin configuration after the fact — useful for backfilling a new storage adapter or re-running notifications for a time range.

---

## 4. Storage adapters

All adapters follow the same `ITrackerStorage` interface and plug into `EventStoragePlugin`. The possibilities broadly fall into four categories.

### 4.1 Relational / document

| Adapter | Notes |
|---|---|
| `TypeOrmTrackerStorage` | ✅ exists — PostgreSQL, MySQL, SQLite via TypeORM |
| `PrismaTrackerStorage` | Alternative ORM with better type safety and migration DX |
| `MongoDbTrackerStorage` | Document storage; flexible schema; good for ad-hoc querying |
| `DynamoDbTrackerStorage` | Serverless-first; pairs well with AWS Lambda ingestion |

### 4.2 Time-series / analytics

These would make the `find()` query dramatically faster on time-based queries and aggregations at scale.

| Adapter | Notes |
|---|---|
| `ClickHouseStorageAdapter` | Columnar; ideal for analytics queries over millions of events |
| `TimescaleDbStorageAdapter` | PostgreSQL extension; keeps TypeORM compatibility |
| `InfluxDbStorageAdapter` | Purpose-built time-series; good for performance/metric events |
| `LokiStorageAdapter` | Grafana Loki — log aggregation, pairs with Grafana dashboards |

### 4.3 Search

| Adapter | Notes |
|---|---|
| `ElasticsearchStorageAdapter` | Full-text search on `message`, faceted filtering, Kibana dashboards |
| `OpenSearchStorageAdapter` | Drop-in Elasticsearch replacement; AWS-managed option |

### 4.4 Cloud / SaaS forwarding

These are write-only adapters (no `find()`/`findById()`). Pair with a real storage adapter for queryability.

| Adapter | Notes |
|---|---|
| `CloudWatchLogsAdapter` | Forward events to AWS CloudWatch Logs |
| `DatadogAdapter` | Datadog Logs / Events API |
| `SentryForwardAdapter` | Re-emit errors to Sentry for teams already using it |
| `NewRelicAdapter` | New Relic Events API |

### 4.5 File-based

| Adapter | Notes |
|---|---|
| `JsonFileStorageAdapter` | Append to a JSON Lines file with daily rotation |
| `CsvStorageAdapter` | CSV export; `find()` not supported |

---

## 5. Message queue integration

This is the most architecturally significant extension. Rather than plugins writing directly to their destinations, events flow through a queue — decoupling ingestion throughput from downstream processing speed, enabling fan-out, and adding durability.

### 5.1 The general pattern: QueueStorageAdapter

A storage adapter that publishes events to a queue instead of (or in addition to) a database. Consumers on the other end process events asynchronously and can apply their own logic.

```
TrackerService → EventStoragePlugin → QueueStorageAdapter → [queue]
                                                               ↓
                                              consumer 1: write to DB
                                              consumer 2: send notifications
                                              consumer 3: forward to analytics
```

This flips the plugin model on its head for high-throughput scenarios: the server ingests and queues immediately, then consumers run at their own pace.

### 5.2 Specific queue adapters

**Redis Streams** (`RedisStreamsStorageAdapter`)

Redis Streams are an ideal first target — most apps already have Redis for dedup cache. Each event becomes a stream entry in `tracker:events`. Consumer groups allow multiple independent consumers (storage writer, notifier) to read the same stream without duplication.

```typescript
EventStoragePlugin.create(new RedisStreamsStorageAdapter({
  client:     redisClient,
  streamKey:  'tracker:events',
  maxLength:  100_000,   // MAXLEN trim
}))
```

**BullMQ** (`BullMqStorageAdapter`)

BullMQ is already used in `./new/api`. Tracker events become BullMQ jobs in a dedicated queue. Existing BullMQ workers pick them up. Retries, delays, and priority all come for free.

```typescript
EventStoragePlugin.create(new BullMqStorageAdapter({
  queue: new Queue('tracker-events', { connection: redisConnection }),
}))
```

**AWS SQS** (`SqsStorageAdapter`)

For AWS-hosted services. Events become SQS messages. `saveBatch()` uses `SendMessageBatch` (up to 10 per call). FIFO queues for ordering guarantees; standard queues for maximum throughput.

```typescript
EventStoragePlugin.create(new SqsStorageAdapter({
  queueUrl:  process.env.TRACKER_SQS_URL!,
  batchSize: 10,
}))
```

**Apache Kafka** (`KafkaStorageAdapter`)

For high-volume pipelines. Events are published to a Kafka topic. Downstream Kafka consumers handle all further processing. Pairs with ClickHouse (via kafka-connect) for analytics.

```typescript
EventStoragePlugin.create(new KafkaStorageAdapter({
  brokers: ['kafka:9092'],
  topic:   'tracker.events',
  clientId: 'tracker-server',
}))
```

**RabbitMQ / AMQP** (`AmqpStorageAdapter`)

Exchange-based routing lets different event types reach different queues automatically via AMQP routing keys.

```typescript
EventStoragePlugin.create(new AmqpStorageAdapter({
  url:        'amqp://localhost',
  exchange:   'tracker',
  routingKey: (event) => `tracker.${event.type}`,  // errors → tracker.error
}))
```

**Google Pub/Sub** (`PubSubStorageAdapter`) and **Azure Service Bus** (`AzureServiceBusStorageAdapter`) follow the same pattern for GCP/Azure deployments.

### 5.3 Hybrid: queue + database

A `CompositeStorageAdapter` that writes to multiple adapters. One for durability (database), one for streaming (queue):

```typescript
EventStoragePlugin.create(new CompositeStorageAdapter([
  new TypeOrmTrackerStorage(repo),         // for queryability
  new RedisStreamsStorageAdapter({ ... }), // for real-time consumers
]))
```

`find()` and `findById()` delegate to the first adapter that supports them.

### 5.4 Consumer-side: TrackerConsumer

A companion utility that reads from a queue and applies the same plugin pipeline. This lets the consumer side re-use `EventStoragePlugin`, `TrackerNotificationsPlugin`, etc. without running an HTTP server.

```typescript
const consumer = new TrackerQueueConsumer({
  source:  new BullMqConsumerSource({ queue: trackerQueue }),
  plugins: [
    EventStoragePlugin.create(new TypeOrmTrackerStorage(repo)),
    TrackerNotificationsPlugin.create({ ... }),
  ],
});

await consumer.start();
```

---

## 6. Plugin ecosystem

### 6.1 AlertThrottlePlugin

Wraps notification plugins with per-rule throttling and escalation logic. Prevents getting 300 identical emails when an error starts looping.

```typescript
AlertThrottlePlugin.create({
  rules: [
    { category: 'error', maxPerHour: 5, escalateAfter: 10 },
  ],
  escalationChannel: 'pagerduty',
})
```

### 6.2 PiiScrubberPlugin

Runs before storage. Scrubs or masks sensitive fields based on configurable patterns.

```typescript
PiiScrubberPlugin.create({
  scrub: [
    { field: 'payload.creditCard', replace: '[REDACTED]' },
    { field: 'payload.email',      replace: (v) => v.replace(/(?<=.).(?=.*@)/, '*') },
    { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replace: '[CARD]' },
  ],
})
```

### 6.3 OpenTelemetry bridge plugin

Export tracker events as OpenTelemetry spans/logs. Lets events appear in Jaeger, Zipkin, or any OTLP-compatible backend. Also reads incoming `traceparent` headers to correlate tracker events with distributed traces.

```typescript
OtelBridgePlugin.create({
  exporter: new OTLPTraceExporter({ url: 'http://otel-collector:4318/v1/traces' }),
})
```

### 6.4 Metrics / Prometheus plugin

Expose tracker event counts as Prometheus metrics: `tracker_events_total{type, appId, status}`, `tracker_flush_duration_ms`, etc. Pairs with Grafana for live dashboards.

```typescript
PrometheusPlugin.create({ path: '/metrics', port: 9090 })
```

### 6.5 AggregationPlugin

Collapses identical events within a time window into a single stored event with a `count`. Dramatically reduces storage for repeat errors in high-traffic systems.

```typescript
AggregationPlugin.create({
  windowMs: 60_000,
  key:      (e) => `${e.appId}:${e.type}:${e.message}`,
  onFlush:  (aggregated) => storage.save({ ...aggregated.representative, count: aggregated.count }),
})
```

### 6.6 RetentionPlugin

Periodically deletes events older than a retention policy. Runs on a configurable schedule via `onInit` interval.

```typescript
RetentionPlugin.create({
  maxAgeDays:    90,
  batchSize:     1_000,
  scheduleMs:    3_600_000,    // run every hour
  filter:        { type: 'info' },  // only purge info events, keep errors forever
})
```

### 6.7 ForwardingPlugin

Re-emits events to another `TrackerService` endpoint (another environment, a separate analytics instance, or a third-party service that speaks the same wire format). Can filter which events to forward.

```typescript
ForwardingPlugin.create({
  endpoint: 'https://analytics.internal/tracker/events',
  filter:   (e) => e.type === 'event',   // only forward business events, not errors
})
```

### 6.8 DeadLetterPlugin

Captures events that failed all plugin processing and writes them to a dedicated "dead letter" store for investigation without losing the event.

---

## 7. Notifications plugin

### 7.1 Slack and Discord adapters

First-class adapters for the two most common team chat systems, rather than requiring users to configure `WebhookAdapter` manually with Slack/Discord-specific payload formatting.

```typescript
new SlackAdapter({ webhookUrl: process.env.SLACK_WEBHOOK_URL! })
new DiscordAdapter({ webhookUrl: process.env.DISCORD_WEBHOOK_URL! })
```

These know the correct payload shape, support rich formatting (Slack blocks, Discord embeds), and format events as readable alerts rather than raw JSON.

### 7.2 PagerDuty adapter

Direct PagerDuty Events API v2 integration for on-call alerting. Supports `trigger`, `acknowledge`, and `resolve` actions — so a `resolved` status update to a tracker event can auto-resolve the PagerDuty incident.

### 7.3 Alert deduplication across notifications

Currently dedup prevents the same `(eventId, channel)` from firing twice. A coarser-grained dedup would suppress notifications for *similar* errors (same type + message, different event ID) within a window — preventing alert fatigue when a new error starts looping.

### 7.4 Retry worker for unsent notifications

Currently `TypeOrmUnsentNotificationStorage` stores failed notifications but nothing reads them back. A `NotificationRetryWorker` that polls `findPending()` on a schedule, re-attempts delivery, and calls `markRetried()` would close the loop.

### 7.5 Notification templates

Allow notification content to be driven by configurable templates (e.g. Handlebars, a simple string template) rather than hard-coded formatters. Useful for teams that want to own the email copy without writing TypeScript.

### 7.6 Escalation chains

If no acknowledgement is recorded within N minutes of a notification, escalate to the next channel or recipient. Requires some notion of "event acknowledged" fed back to the plugin (the existing `TrackerEventStatus.Acknowledged` could serve this purpose).

---

## 8. Observability & developer experience

### 8.1 CLI (`tracker-cli`)

A terminal tool for working with stored events:

```bash
tracker-cli tail --appId my-api --type error        # live tail incoming errors
tracker-cli query --from -1h --type error            # query last hour of errors
tracker-cli status <event-id> resolved               # update event status
tracker-cli replay --from 2024-01-01 --to 2024-01-02 # replay events through plugins
```

### 8.2 Lightweight dashboard

A self-hostable web UI that uses the `GET /tracker/events` endpoint directly. An HTML file (or minimal React app) showing a live feed, error counts by app, status management, and basic filtering. Ships as a static asset served by `TrackerModule` at `/tracker/dashboard` when enabled.

### 8.3 SSE event stream

A `GET /tracker/events/stream` endpoint that emits new events as Server-Sent Events. Allows the dashboard (or any client) to watch events in real time without polling.

### 8.4 Testing utilities package (`@rw3iss/tracker/testing`)

```typescript
import { MockTrackerPlugin, assertTracked, assertNotTracked } from '@rw3iss/tracker/testing';

const plugin = new MockTrackerPlugin();
TrackerModule.register({ plugins: [plugin] });

// In tests:
assertTracked(plugin, { type: 'error', message: 'order failed' });
assertNotTracked(plugin, { category: 'notification-failed' });
plugin.clear();
```

Also export a pre-configured `TestTrackerModule` that uses `InMemoryStorageAdapter` and exposes `getEvents()` for assertions.

### 8.5 Source map resolution

Server-side stack frame resolution: when a `StoredTrackerEvent` has `error.stack`, a server enricher looks up the corresponding source map and resolves minified frames to original file/line/column. Works with source maps uploaded at build time or fetched from a configurable URL.

### 8.6 Health and status endpoint

`GET /tracker/health` returns adapter connection status, queue depth, plugin health, and event counts — structured for consumption by load balancers and monitoring systems.

---

## 9. Security

### 9.1 Per-appId API keys

Currently any POST to `/tracker/events` is accepted (optionally guarded by a NestJS guard). A built-in key validation mechanism would be more ergonomic:

```typescript
TrackerModule.register({
  apiKeys: {
    'seller-portal': process.env.SELLER_TRACKER_KEY!,
    'buyer-portal':  process.env.BUYER_TRACKER_KEY!,
  },
})
```

The client sends the key as a header; the server validates it and stamps `appId` from the key mapping, preventing clients from spoofing their `appId`.

### 9.2 Event payload size limits

Reject or truncate events with payloads over a configurable byte limit to prevent storage abuse.

```typescript
TrackerModule.register({ maxEventBytes: 64_000 })
```

### 9.3 Request signing

Optional HMAC signing of the batch payload. The client signs with a shared secret; the server verifies before processing. Prevents replay attacks and unauthorized event injection.

---

## 10. Multi-tenancy & routing

### 10.1 Event routing plugin

Route events to different storage adapters or notification configs based on event properties. Useful in multi-tenant or multi-region setups.

```typescript
EventRoutingPlugin.create({
  routes: [
    { match: (e) => e.appId === 'payments', storage: paymentsDb },
    { match: (e) => e.context?.environment === 'production', storage: prodDb },
  ],
  fallback: defaultDb,
})
```

### 10.2 Per-tenant plugin stacks

Allow the plugin list to vary per tenant/appId, so tenant A can have email notifications and tenant B has Slack without both receiving the same alerts.

### 10.3 Namespace isolation in shared storage

When multiple apps share a single `tracker_events` table, a `namespace` column (equivalent to `appId`) with row-level security policies prevents one app's queries from touching another's data. The storage adapter could enforce this automatically when a `namespace` option is set.
