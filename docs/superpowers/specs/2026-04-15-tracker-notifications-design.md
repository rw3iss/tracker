# Tracker Notifications Plugin — Design Spec

**Date:** 2026-04-15
**Package:** `@rw3iss/tracker` (fourth subpath: `@rw3iss/tracker/notifications`)
**Status:** Approved, pending implementation

---

## Goal

Add an optional, zero-coupling notifications plugin to `@rw3iss/tracker` that listens to stored tracker events and dispatches notifications (email, SMS, webhook, push) through configurable channel adapters. The core tracker remains unaware of the notifications module. Loop prevention, per-channel adapter abstraction, unsent-notification storage, deduplication, and a default "notify on errors" strategy are all included.

---

## Architecture Overview

```
TrackerModule.register({
  storage: ...,
  plugins: [
    TrackerNotificationsPlugin.create({ ... })
  ]
})
```

After `TrackerService` stores an event it calls `plugin.onEvent(storedEvent)` for each registered plugin — fire-and-forget, plugin errors never interrupt ingestion. The notifications plugin routes each event through its configured strategies. Strategies call `dispatcher.notify()` to send notifications. The dispatcher resolves the effective channel set, formats payloads, and dispatches to all channels in parallel via `Promise.allSettled`. Failures are recorded back into `TrackerService` as `category: 'notification-failed'` error events and optionally persisted to a dedicated unsent-notifications DB table.

---

## Part 1 — Core Tracker Changes

### 1.1 `category?: string` on `TrackerEvent`

Add one optional field to `TrackerEvent` in `src/common/types.ts`. It is general-purpose — not tied to notifications — so future plugins can use it freely.

```ts
interface TrackerEvent {
  // ... all existing fields unchanged ...
  category?: string;
}
```

**Deduplication key:** `category` is intentionally excluded from the dedup hash. A stream of repeated `notification-failed` errors for the same underlying event should not be silently swallowed by the deduplicator.

**Well-known category constants** are exported from the notifications subpath, not from core:

```ts
// @rw3iss/tracker/notifications
export const NotificationCategory = {
  NotificationFailed: 'notification-failed',
} as const;
export type NotificationCategoryValue = typeof NotificationCategory[keyof typeof NotificationCategory];
```

### 1.2 `ITrackerPlugin` interface

New file: `src/server/ITrackerPlugin.ts`

```ts
export interface ITrackerPlugin {
  /** Called once when the TrackerModule initializes. Use to wire up internal dependencies. */
  onInit?(trackerService: TrackerService): void | Promise<void>;
  /** Called after every event is stored (post-dedup, post-save). Fire-and-forget. */
  onEvent(event: StoredTrackerEvent): void | Promise<void>;
  /** Called when the NestJS module is destroyed. */
  onDestroy?(): void | Promise<void>;
}
```

### 1.3 `plugins` option in `TrackerModuleOptions`

```ts
interface TrackerModuleOptions {
  storage: ITrackerStorage;
  deduplication?: TrackerDeduplicationOptions;
  guardClass?: Type<unknown>;
  plugins?: ITrackerPlugin[];           // NEW
}
```

### 1.4 Plugin lifecycle wiring in `TrackerService`

`TrackerService` stores the plugin array from options.

**`onModuleInit()`** — calls `plugin.onInit(this)` for each plugin.

**`track()` / `trackBatch()`** — after successful storage, calls each plugin:
```ts
for (const plugin of this.plugins) {
  Promise.resolve(plugin.onEvent(stored)).catch(() => {
    // plugin errors are swallowed — they must not interrupt ingestion
  });
}
```

**`onModuleDestroy()`** — calls `plugin.onDestroy?.()` for each plugin.

---

## Part 2 — `TrackerNotificationsPlugin`

### 2.1 Entry point

`src/server/notifications/TrackerNotificationsPlugin.ts`

```ts
class TrackerNotificationsPlugin implements ITrackerPlugin {
  static create(config: TrackerNotificationsConfig): TrackerNotificationsPlugin

  onInit(trackerService: TrackerService): void
  onEvent(event: StoredTrackerEvent): Promise<void>
  onDestroy(): void
}
```

`onInit` stores the `TrackerService` reference and passes it to the `NotificationDispatcher` (so the dispatcher can feed errors back into the tracker).

`onEvent` runs all configured strategies sequentially. Each strategy receives the event and the shared `NotificationDispatcher`. Strategy errors are caught individually — one failing strategy does not skip others.

### 2.2 `TrackerNotificationsConfig`

```ts
interface TrackerNotificationsConfig {
  /** Must match the appId used in TrackerModule — used for loop detection. */
  appId?: string;

  /** One or more strategies to run per event. Executed in order, independently. */
  strategies: INotificationStrategy[];

  /**
   * Channel configurations. Only configured channels can be dispatched to.
   * Attempting to send to an unconfigured channel throws and logs a tracker error.
   */
  channels?: Partial<ChannelConfigMap>;

  /** Suppress identical (eventId + channelType) notification attempts within this window. Default: 60_000 ms. */
  deduplication?: {
    windowMs: number;
  };

  /**
   * Optional storage for notifications that could not be sent.
   * If omitted, failures are only recorded back into TrackerService.
   */
  unsentStorage?: IUnsentNotificationStorage;
}

interface ChannelConfigMap {
  email:   EmailChannelConfig;
  sms:     SmsChannelConfig;
  webhook: WebhookChannelConfig;
  firebase: FirebaseChannelConfig;
}
```

### 2.3 Per-channel config types

```ts
interface EmailChannelConfig {
  adapter: IEmailAdapter;
  recipients: string[];
  from: string;                          // e.g. 'support@ryanweiss.net'
  formatter?: EmailFormatter;            // optional custom formatter
}

interface SmsChannelConfig {
  adapter: ISmsAdapter;
  to: string[];                          // phone numbers
  formatter?: SmsFormatter;
}

interface WebhookChannelConfig {
  adapter: IWebhookAdapter;
  formatter?: WebhookFormatter;
}

interface FirebaseChannelConfig {
  adapter: IFirebaseAdapter;
  tokens: string[];                      // device/topic tokens
  formatter?: FirebaseFormatter;
}
```

---

## Part 3 — `NotificationDispatcher`

`src/server/notifications/NotificationDispatcher.ts`

The dispatcher is the only class strategies interact with. It owns all orchestration logic.

```ts
interface NotificationData {
  subject: string;
  body: StoredTrackerEvent | Record<string, unknown>;
  [key: string]: unknown;   // strategies may add extra fields for custom formatters
}

interface NotificationDispatchOptions {
  omit?: ChannelType[];     // skip these channels even if configured
  include?: ChannelType[];  // force-include these channels (still requires adapter to be configured)
}

class NotificationDispatcher {
  notify(data: NotificationData, opts?: NotificationDispatchOptions): Promise<void>
}
```

**`notify()` algorithm:**

1. Resolve effective channel list:
   - Start with all keys present in `config.channels`
   - Add any in `opts.include` that are also configured (if a channel in `include` has no adapter, emit a tracker error event and skip it — do not throw)
   - Remove any in `opts.omit` — **omit takes precedence over include**; a channel in both lists is excluded

2. For each effective channel:
   - Compute the dedup key: if `data.body.category === 'notification-failed'`, use `(data.body.payload?.originalEventId ?? data.body.id)` as the event key; otherwise use `data.body.id`. Key format: `${eventKey}:${channelType}`.
   - Check `NotificationDeduplicator.seen(dedupKey)`. Skip silently if seen within window.
   - Get the formatter: `channelConfig.formatter ?? defaultFormatterForChannel(channelType)`
   - Call `adapter.send(formatted)`

3. Run all channel sends via `Promise.allSettled(channelSends)`.

4. For each rejected result:
   - Build a `TrackerEvent` with:
     ```
     type: 'error'
     category: 'notification-failed'
     appId: config.appId
     message: `Notification failed [${channelType}]: ${error.message}`
     payload: {
       failedChannel: channelType,
       originalEventId: data.body.id,
       adapterError: error.message,
       notificationSubject: data.subject,
     }
     ```
   - Call `this.trackerService.track(failureEvent)` — this re-enters the plugin pipeline, but loop prevention (Section 5) ensures it does not spiral.
   - If `unsentStorage` is configured, also persist to `tracker_unsent_notifications` table.

---

## Part 4 — Strategy Interface and `NotifyOnErrorsStrategy`

### 4.1 `INotificationStrategy`

`src/server/notifications/INotificationStrategy.ts`

```ts
interface INotificationStrategy {
  onEvent(
    event: StoredTrackerEvent,
    dispatcher: NotificationDispatcher,
  ): void | Promise<void>;
}
```

Strategies are plain classes. No framework coupling. Multiple strategies can be registered; each runs independently per event.

### 4.2 `NotifyOnErrorsStrategy`

`src/server/notifications/strategies/NotifyOnErrorsStrategy.ts`

Default strategy — handles all `type: 'error'` events and dispatches to email + webhook (if configured).

```ts
class NotifyOnErrorsStrategy implements INotificationStrategy {
  async onEvent(event: StoredTrackerEvent, dispatcher: NotificationDispatcher): Promise<void> {
    if (event.type !== 'error') return;

    const omit = resolveOmitFromFailedEvent(event);

    await dispatcher.notify(
      {
        subject: `[Error] ${event.message}`,
        body: event,
      },
      { omit, include: ['email', 'webhook'] },
    );
  }
}
```

`resolveOmitFromFailedEvent` is a utility in `utils/resolveOmit.ts`:

```ts
function resolveOmitFromFailedEvent(event: StoredTrackerEvent): ChannelType[] {
  if (event.category !== NotificationCategory.NotificationFailed) return [];
  const failedChannel = event.payload?.failedChannel as ChannelType | undefined;
  return failedChannel ? [failedChannel] : [];
}
```

---

## Part 5 — Loop Prevention

### 5.1 Category-based omit (primary guard)

When `NotifyOnErrorsStrategy` receives a `notification-failed` error event, it calls `resolveOmitFromFailedEvent` which extracts `payload.failedChannel` and passes it as `{ omit: ['email'] }` (or whichever channel failed). The dispatcher then skips that channel for this re-notification, but still attempts all others.

If those others also fail, they emit their own `notification-failed` events with their respective `failedChannel` values. Eventually all channels are exhausted. Each failure produces at most one re-attempt through a different channel.

### 5.2 Notification-level deduplication (secondary guard)

`NotificationDeduplicator` maintains an in-memory TTL map. The key is `${canonicalEventId}:${channelType}` where `canonicalEventId` is:
- For normal events: `event.id`
- For `notification-failed` events: `event.payload.originalEventId ?? event.id`

This means all re-notification attempts triggered by failures of the same original event share the same dedup space. If an identical `(originalEventId, channelType)` attempt is seen within `deduplication.windowMs` (default 60 seconds), it is skipped silently.

This catches:
- The loop case: original event fails → notification-failed triggers retry → that also fails → the retry would attempt the same `(originalEventId, channelType)` pair → dedup blocks it
- Strategy bugs that call `notify()` twice for the same event
- Duplicate stored events when tracker dedup is disabled

### 5.3 Why this design does not infinite-loop

Walk-through with 2 channels (email, webhook):

1. Original error `evt-1` → `notify()` → tries email + webhook → both fail
2. Dedup records `evt-1:email` and `evt-1:webhook`
3. `notification-failed` event (email) → strategy omits email → `notify()` tries webhook → dedup sees `evt-1:webhook` → **skipped**
4. `notification-failed` event (webhook) → strategy omits webhook → `notify()` tries email → dedup sees `evt-1:email` → **skipped**
5. No further events emitted. Both `notification-failed` events are stored in the tracker DB for visibility.

Maximum channel adapter calls per original error: `N` (one attempt per channel, all at step 1). Re-notification attempts are all blocked by dedup at steps 3–4. The category-based omit is a first-pass filter; dedup is the hard stop.

---

## Part 6 — Channel Adapters

### 6.1 Adapter interfaces

`src/server/notifications/INotificationAdapter.ts`

```ts
type ChannelType = 'email' | 'sms' | 'webhook' | 'firebase';

interface INotificationAdapter {
  readonly channelType: ChannelType;
  send(payload: FormattedNotification): Promise<void>;
}

interface FormattedNotification {
  channelType: ChannelType;
  raw: unknown;    // channel-specific formatted payload
}
```

### 6.2 Email adapters

All implement `IEmailAdapter extends INotificationAdapter`.

**`SmtpAdapter`** (`channels/email/SmtpAdapter.ts`)
- Uses nodemailer with any SMTP config
- Configured with `{ host, port, secure, auth: { user, pass } }`
- For SendGrid relay: `host: 'smtp.sendgrid.net', port: 587, auth: { user: 'apikey', pass: SENDGRID_API_KEY }`

**`SendGridApiAdapter`** (`channels/email/SendGridApiAdapter.ts`)
- SendGrid REST API (`POST https://api.sendgrid.com/v3/mail/send`)
- Config: `{ apiKey, defaultTemplateId? }`
- Sends dynamic template data or pre-rendered HTML

**`MailgunAdapter`** (`channels/email/MailgunAdapter.ts`)
- Mailgun REST API
- Config: `{ apiKey, domain, defaultTemplateId? }`

**`PostmarkAdapter`** (`channels/email/PostmarkAdapter.ts`)
- Postmark REST API
- Config: `{ serverToken, defaultTemplateId? }`

### 6.3 Other adapters

**`TwilioSmsAdapter`** (`channels/sms/TwilioSmsAdapter.ts`)
- Twilio REST API
- Config: `{ accountSid, authToken, from }`

**`WebhookAdapter`** (`channels/webhook/WebhookAdapter.ts`)
- HTTP POST to configured URL
- Config: `{ url, headers?: Record<string, string>, timeoutMs?: number }`

**`FirebaseAdapter`** (`channels/firebase/FirebaseAdapter.ts`)
- Firebase Admin SDK (`admin.messaging().sendEachForMulticast`)
- Config: `{ credential: admin.credential.Credential }`

### 6.4 Default formatters

`src/server/notifications/formatters/`

```ts
// defaultEmailFormatter.ts
function defaultEmailFormatter(data: NotificationData): EmailPayload {
  // Returns { subject, html, text } with a clean event dump
}

// defaultSmsFormatter.ts
function defaultSmsFormatter(data: NotificationData): SmsPayload {
  // Returns { body: `[${data.subject}] ${truncated message}` }
}

// defaultWebhookFormatter.ts
function defaultWebhookFormatter(data: NotificationData): WebhookPayload {
  // Returns the raw NotificationData as JSON
}

// defaultFirebaseFormatter.ts
function defaultFirebaseFormatter(data: NotificationData): FirebasePayload {
  // Returns { title, body } for push notification
}
```

Channel-level `formatter` in config overrides the default. If no formatter at all exists for a channel type, the raw `NotificationData` is passed through.

---

## Part 7 — Unsent Notification Storage

### 7.1 `IUnsentNotificationStorage`

`src/server/notifications/storage/IUnsentNotificationStorage.ts`

```ts
interface UnsentNotificationRecord {
  channelType: ChannelType;
  appId?: string;
  recipientInfo: string;          // JSON: email addresses, phone numbers, URL, etc.
  formattedPayload: string;       // JSON: what was attempted
  errorMessage: string;
  originalEventId?: string;
  retryCount: number;
  lastAttemptAt?: Date;
}

interface IUnsentNotificationStorage {
  save(record: UnsentNotificationRecord): Promise<void>;
  findPending(limit?: number): Promise<(UnsentNotificationRecord & { id: string; createdAt: Date })[]>;
  markRetried(id: string, error?: string): Promise<void>;
  delete(id: string): Promise<void>;
}
```

### 7.2 `TypeOrmUnsentNotificationStorage`

`src/server/notifications/storage/TypeOrmUnsentNotificationStorage.ts`

Backed by `UnsentNotificationEntity` → table `tracker_unsent_notifications`.

Fields: `id (uuid PK)`, `channelType`, `appId`, `recipientInfo (text)`, `formattedPayload (text)`, `errorMessage (text)`, `originalEventId`, `retryCount (int, default 0)`, `lastAttemptAt (timestamp nullable)`, `createdAt (timestamp)`.

---

## Part 8 — Shared Utilities

`src/server/notifications/utils/`

**`eventFilters.ts`**
```ts
function isErrorEvent(event: StoredTrackerEvent): boolean
function isNotificationFailedEvent(event: StoredTrackerEvent): boolean
function matchesCategory(event: StoredTrackerEvent, category: string): boolean
function matchesType(event: StoredTrackerEvent, type: EventType): boolean
function matchesAppId(event: StoredTrackerEvent, appId: string): boolean
```

**`eventFormatters.ts`**
```ts
function serializeEventToText(event: StoredTrackerEvent): string
function serializeEventToHtml(event: StoredTrackerEvent): string
function truncate(str: string, maxLen: number): string
```

**`resolveOmit.ts`**
```ts
function resolveOmitFromFailedEvent(event: StoredTrackerEvent): ChannelType[]
```

---

## Part 9 — Default rw3iss Configuration (`./new/api`)

The `./new/api` TrackerModule registration should include the notifications plugin configured with:

- **Strategy:** `NotifyOnErrorsStrategy`
- **Email channel:** `SmtpAdapter` with SendGrid SMTP relay credentials
  - `host: 'smtp.sendgrid.net'`, `port: 587`, `auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY }`
  - `recipients: ['rw3iss@gmail.com']`
  - `from: 'support@ryanweiss.net'`
- **appId:** matches the api's tracker appId (e.g. `'rw3iss-api'`)
- **Deduplication:** 60 seconds (suppress duplicate notification for the same event+channel)
- **unsentStorage:** wired to a TypeORM repo for `UnsentNotificationEntity`

`SENDGRID_API_KEY` is read from environment. The key is available as `...` — store it in `.env.development` / `.env.production` (never hardcoded).

---

## Part 10 — File Structure

```
src/server/notifications/
├── index.ts                                  # @rw3iss/tracker/notifications export
├── TrackerNotificationsPlugin.ts             # ITrackerPlugin implementation
├── NotificationDispatcher.ts                 # notify() orchestrator
├── NotificationDeduplicator.ts               # in-memory TTL dedup for (eventId, channel)
├── INotificationStrategy.ts                  # strategy interface
├── INotificationAdapter.ts                   # adapter interface + ChannelType + FormattedNotification
├── NotificationCategory.ts                   # 'notification-failed' constant
├── types.ts                                  # NotificationData, DispatchOptions, ChannelConfigMap, etc.
├── strategies/
│   └── NotifyOnErrorsStrategy.ts
├── channels/
│   ├── ChannelConfig.ts                      # per-channel config types
│   ├── email/
│   │   ├── IEmailAdapter.ts
│   │   ├── SmtpAdapter.ts
│   │   ├── SendGridApiAdapter.ts
│   │   ├── MailgunAdapter.ts
│   │   └── PostmarkAdapter.ts
│   ├── sms/
│   │   └── TwilioSmsAdapter.ts
│   ├── webhook/
│   │   └── WebhookAdapter.ts
│   └── firebase/
│       └── FirebaseAdapter.ts
├── formatters/
│   ├── defaultEmailFormatter.ts
│   ├── defaultSmsFormatter.ts
│   ├── defaultWebhookFormatter.ts
│   └── defaultFirebaseFormatter.ts
├── storage/
│   ├── IUnsentNotificationStorage.ts
│   ├── UnsentNotificationEntity.ts
│   └── TypeOrmUnsentNotificationStorage.ts
└── utils/
    ├── eventFilters.ts
    ├── eventFormatters.ts
    └── resolveOmit.ts

src/server/
├── ITrackerPlugin.ts                         # NEW: plugin interface
├── TrackerModule.ts                          # MODIFIED: plugins option
├── TrackerService.ts                         # MODIFIED: onInit, onEvent, onDestroy hooks

src/common/
└── types.ts                                  # MODIFIED: category?: string on TrackerEvent
```

Core tracker changes touch exactly 4 files. Everything else is additive.

---

## Part 11 — Package Export

`package.json` gains a fourth subpath in `exports`:

```json
"./notifications": {
  "import": "./dist/server/notifications/index.js",
  "require": "./dist/server/notifications/index.js",
  "types": "./dist/server/notifications/index.d.ts"
}
```

`src/server/notifications/index.ts` exports:
- `TrackerNotificationsPlugin`
- `NotificationCategory`
- `INotificationStrategy`
- `INotificationAdapter`
- `IUnsentNotificationStorage`
- `TypeOrmUnsentNotificationStorage`
- `UnsentNotificationEntity`
- `NotifyOnErrorsStrategy`
- All adapter classes
- All formatter functions
- Utility functions from `utils/`
- All config types

---

## Part 12 — README

A thorough `NOTIFICATIONS.md` (or section in the main README) is generated as part of implementation, covering:

- Installation and package exports
- Basic setup with `NotifyOnErrorsStrategy` + SMTP
- Registering multiple strategies
- Writing a custom strategy
- All channel adapter configs with examples
- Custom formatters
- `notify()` include/omit override usage
- Loop prevention explanation
- Unsent notification storage setup
- Full `./new/api` rw3iss default config example
- Environment variable reference

---

## Constraints and Non-Goals

- The core `TrackerModule` gains no runtime dependency on `@rw3iss/tracker/notifications`. The plugin array is typed as `ITrackerPlugin[]` — a plain interface.
- The notifications module has no NestJS module/DI of its own. It is a plugin object, not a NestJS module.
- No retry scheduler — failed notifications land in `tracker_unsent_notifications` for external tooling or a future retry job. A retry runner is out of scope for this spec.
- SMS (Twilio) and Firebase adapters are fully implemented but the rw3iss default config does not enable them — they require additional env setup.
- All third-party API adapter implementations make real HTTP calls; no mock/stub implementations are included in this spec.
