# @rw3iss/tracker — Notifications Plugin

Sends alerts via email, SMS, webhook, or Firebase push when tracker events match a configured strategy. Wired into `TrackerModule` via the `plugins` option — the core server module has no knowledge of this plugin.

```typescript
import { /* ... */ } from '@rw3iss/tracker/notifications';
```

---

## Quickstart

```bash
npm install nodemailer   # only required for SmtpAdapter
```

```typescript
import { TrackerModule } from '@rw3iss/tracker/server';
import { EventStoragePlugin, TypeOrmTrackerStorage, TrackerEventEntity } from '@rw3iss/tracker/storage';
import { TrackerNotificationsPlugin, NotifyOnErrorsStrategy, SmtpAdapter } from '@rw3iss/tracker/notifications';

TrackerModule.registerAsync({
  inject: [DataSource],
  useFactory: (ds: DataSource) => ({
    plugins: [
      EventStoragePlugin.create(new TypeOrmTrackerStorage(ds.getRepository(TrackerEventEntity))),
      TrackerNotificationsPlugin.create({
        strategies: [new NotifyOnErrorsStrategy()],
        channels: {
          email: {
            adapter:    new SmtpAdapter({ host: 'smtp.example.com', port: 587, secure: false,
                          auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! } }),
            from:       'alerts@example.com',
            recipients: ['oncall@example.com'],
          },
        },
      }),
    ],
  }),
});
```

Every `type: 'error'` event will now trigger an email to `oncall@example.com`.

---

## Plugin config

```typescript
TrackerNotificationsPlugin.create(config: TrackerNotificationsConfig)
```

```typescript
interface TrackerNotificationsConfig {
  strategies:     INotificationStrategy[];      // required — one or more strategies
  channels?:      Partial<ChannelConfigMap>;     // configure which channels to dispatch to
  appId?:         string;                        // used in notification-failure tracker events
  deduplication?: { windowMs: number };          // default: 60_000 ms
  unsentStorage?: IUnsentNotificationStorage;    // persist failed sends for auditing / retry
  events?:        EventType[];                   // plugin-level type filter (strategies can override)
}
```

The `events` field acts as a plugin-level gate: only events whose `type` is in the list reach any strategy. Individual strategies can override this with their own `events` property.

<details>
<summary><code>ChannelConfigMap</code> — full channel config types</summary>

```typescript
interface ChannelConfigMap {
  email: {
    adapter:     IEmailAdapter;    // SmtpAdapter | SendGridApiAdapter | MailgunAdapter | PostmarkAdapter
    recipients:  string[];
    from:        string;
    formatter?:  EmailFormatter;   // override default formatting
  };
  sms: {
    adapter:    ISmsAdapter;       // TwilioSmsAdapter
    to:         string[];
    formatter?: SmsFormatter;
  };
  webhook: {
    adapter:    IWebhookAdapter;   // WebhookAdapter
    formatter?: WebhookFormatter;
  };
  firebase: {
    adapter:    IFirebaseAdapter;  // FirebaseAdapter
    tokens:     string[];          // FCM device tokens
    formatter?: FirebaseFormatter;
  };
}
```

Only channels with a configured adapter can be dispatched to. A strategy calling `dispatcher.notify()` on an unconfigured channel records a `notification-failed` tracker event instead of throwing.

</details>

---

## Strategies

A strategy receives events that pass the filter and decides whether to call `dispatcher.notify()`.

```typescript
interface INotificationStrategy {
  /**
   * Limit this strategy to the given event types.
   * Overrides the plugin-level `events` filter for this strategy.
   */
  events?: EventType[];
  /**
   * If set, notify() is called with `{ include: channels }` — only these channels receive
   * the notification. Implement `onEvent` yourself to call dispatcher.notify() with custom options.
   */
  channels?: ChannelType[];
  onEvent(event: StoredTrackerEvent, dispatcher: NotificationDispatcher): void | Promise<void>;
}
```

Multiple strategies run independently per event — one failing strategy does not block others.

### Event type filtering

Filtering is layered: the plugin-level `events` array is evaluated first, then each strategy's own `events` array (if set) overrides it for that strategy.

```
event arrives
    │
    ▼
plugin.events? → if set and type not in list → skip all strategies
    │
    ▼  (for each strategy)
strategy.events? → if set and type not in list → skip this strategy
    │
    ▼
strategy.onEvent(event, dispatcher)
```

### Built-in: `NotifyOnErrorsStrategy`

Fires on every `event.type === 'error'`. Dispatches to `email` and `webhook` channels. Automatically omits any channel involved in a failure loop (see [Loop prevention](#loop-prevention)).

```typescript
strategies: [new NotifyOnErrorsStrategy()]
```

### Built-in: `DefaultStrategy`

Zero-code strategy — forwards events to configured channels without custom logic. Use `events` to restrict which types it handles and `channels` to target specific channels.

```typescript
import { DefaultStrategy } from '@rw3iss/tracker/notifications';

// Notify all configured channels for all event types
new DefaultStrategy()

// Only errors and warnings, email + webhook only
new DefaultStrategy({ events: ['error', 'warning'], channels: ['email', 'webhook'] })

// Custom subject template — supports {{type}} and {{message}} placeholders
new DefaultStrategy({ subject: '[{{type}}] {{message}}', channels: ['email'] })
```

```typescript
interface DefaultStrategyConfig {
  subject?:   string;        // default: '[{{type}}] {{message}}'
  events?:    EventType[];   // overrides plugin-level events
  channels?:  ChannelType[]; // restrict to these channels; default: all configured
}
```

### Writing a custom strategy

```typescript
import type { INotificationStrategy } from '@rw3iss/tracker/notifications';
import type { StoredTrackerEvent } from '@rw3iss/tracker';
import type { NotificationDispatcher } from '@rw3iss/tracker/notifications';
import { resolveOmitFromFailedEvent } from '@rw3iss/tracker/notifications';

export class NotifyOnCriticalStrategy implements INotificationStrategy {
  readonly events = ['error'] as const;  // strategy-level filter

  async onEvent(event: StoredTrackerEvent, dispatcher: NotificationDispatcher): Promise<void> {
    if (event.payload?.severity !== 'critical') return;

    const omit = resolveOmitFromFailedEvent(event);  // loop-prevention helper
    await dispatcher.notify(
      { subject: `[CRITICAL] ${event.message}`, body: event },
      { include: ['email', 'sms'], omit },
    );
  }
}
```

---

## `dispatcher.notify()`

```typescript
dispatcher.notify(data: NotificationData, opts?: NotificationDispatchOptions): Promise<void>
```

```typescript
interface NotificationData {
  subject: string;
  body:    StoredTrackerEvent | Record<string, unknown>;
  [key: string]: unknown;   // extra fields passed through to custom formatters
}

interface NotificationDispatchOptions {
  omit?:    ChannelType[];   // skip these channels — takes precedence over include
  include?: ChannelType[];   // restrict dispatch to only these channels
}

type ChannelType = 'email' | 'sms' | 'webhook' | 'firebase';
```

**`include` restricts — it does not expand.** When provided, only the listed channels (that are configured and not in `omit`) receive the notification. When omitted, all configured channels are used.

```typescript
// Only email (even if webhook/sms are configured)
await dispatcher.notify(data, { include: ['email'] });

// All configured channels except SMS
await dispatcher.notify(data, { omit: ['sms'] });

// omit wins — only webhook receives it
await dispatcher.notify(data, { include: ['email', 'webhook'], omit: ['email'] });
```

---

## Channel adapters

### Email

<details>
<summary><code>SmtpAdapter</code> — any SMTP server (SendGrid relay, Mailgun SMTP, etc.)</summary>

Requires `npm install nodemailer`.

```typescript
interface SmtpAdapterConfig {
  host:   string;
  port:   number;
  secure: boolean;              // true for port 465, false for 587
  auth:   { user: string; pass: string };
}

new SmtpAdapter({ host: 'smtp.sendgrid.net', port: 587, secure: false,
                  auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY! } })
```

</details>

<details>
<summary><code>SendGridApiAdapter</code> — SendGrid HTTP API (higher throughput than SMTP relay)</summary>

```typescript
interface SendGridApiAdapterConfig {
  apiKey: string;
}

new SendGridApiAdapter({ apiKey: process.env.SENDGRID_API_KEY! })
```

</details>

<details>
<summary><code>MailgunAdapter</code></summary>

```typescript
interface MailgunAdapterConfig {
  apiKey: string;
  domain: string;
  host?:  string;   // 'api.mailgun.net' (US, default) | 'api.eu.mailgun.net' (EU)
}

new MailgunAdapter({ apiKey: process.env.MAILGUN_API_KEY!, domain: 'mg.example.com' })
```

</details>

<details>
<summary><code>PostmarkAdapter</code></summary>

```typescript
interface PostmarkAdapterConfig {
  serverToken: string;
}

new PostmarkAdapter({ serverToken: process.env.POSTMARK_TOKEN! })
```

</details>

### SMS

<details>
<summary><code>TwilioSmsAdapter</code></summary>

```typescript
interface TwilioSmsAdapterConfig {
  accountSid: string;
  authToken:  string;
  from:       string;   // your Twilio number
}

channels: {
  sms: {
    adapter: new TwilioSmsAdapter({
      accountSid: process.env.TWILIO_SID!,
      authToken:  process.env.TWILIO_TOKEN!,
      from:       '+15005550006',
    }),
    to: ['+12025551234'],
  },
}
```

</details>

### Webhook

<details>
<summary><code>WebhookAdapter</code> — POST JSON to any URL (Slack, PagerDuty, etc.)</summary>

```typescript
interface WebhookAdapterConfig {
  url:        string;
  headers?:   Record<string, string>;   // e.g. auth headers
  timeoutMs?: number;                   // default: 10_000
}

channels: {
  webhook: {
    adapter: new WebhookAdapter({ url: process.env.SLACK_WEBHOOK_URL! }),
  },
}
```

</details>

### Firebase

<details>
<summary><code>FirebaseAdapter</code> — Firebase Cloud Messaging push</summary>

Requires `npm install firebase-admin`.

```typescript
interface FirebaseAdapterConfig {
  serviceAccount: Record<string, unknown>;   // imported from your Firebase JSON key file
}

import serviceAccount from './firebase-service-account.json';

channels: {
  firebase: {
    adapter: new FirebaseAdapter({ serviceAccount }),
    tokens:  ['device-token-1', 'device-token-2'],
  },
}
```

</details>

---

## Custom formatters

Formatters shape the payload before it reaches the adapter. Each channel has a default formatter; override per channel as needed.

```typescript
type EmailFormatter    = (data: NotificationData, recipients: string[], from: string) => EmailPayload;
type SmsFormatter      = (data: NotificationData, to: string[]) => SmsPayload;
type WebhookFormatter  = (data: NotificationData) => WebhookPayload;
type FirebaseFormatter = (data: NotificationData, tokens: string[]) => FirebasePayload;
```

```typescript
channels: {
  email: {
    adapter:   new SmtpAdapter({ ... }),
    from:      'alerts@example.com',
    recipients: ['ops@example.com'],
    formatter: (data, recipients, from) => ({
      from,
      to:      recipients,
      subject: `[ALERT] ${data.subject}`,
      html:    `<h1>${data.subject}</h1><pre>${JSON.stringify(data.body, null, 2)}</pre>`,
      text:    data.subject,
    }),
  },
}
```

<details>
<summary>Payload types</summary>

```typescript
interface EmailPayload {
  from:    string;
  to:      string[];
  subject: string;
  html:    string;
  text:    string;
}

interface SmsPayload {
  to:   string[];
  body: string;
}

interface WebhookPayload {
  [key: string]: unknown;
}

interface FirebasePayload {
  tokens: string[];
  title:  string;
  body:   string;
  data?:  Record<string, string>;
}
```

</details>

---

## Loop prevention

**The problem:** An error event triggers a notification → the adapter fails → the failure is recorded as a new `type: 'error'` event → `NotifyOnErrorsStrategy` sees it → tries to notify again → infinite loop.

**Two guards prevent this:**

1. **Category-based omit** — failure events carry `category: 'notification-failed'` and `payload.failedChannel`. `resolveOmitFromFailedEvent(event)` extracts that channel and returns it as `omit`, so the retry skips the channel that just failed.

2. **Deduplication** — `NotificationDeduplicator` tracks `(canonicalEventId, channelType)` pairs within the dedup window (default 60s). For `notification-failed` events the canonical ID is `payload.originalEventId`, so all retries share the same dedup slot as the original dispatch.

**Result (2 channels, both fail):**

| Step | What happens |
|---|---|
| `evt-1` stored | `notify()` → email fails, webhook fails |
| Dedup records | `evt-1:email`, `evt-1:webhook` |
| `notification-failed` (email) | strategy omits `email` → tries `webhook` → dedup blocks |
| `notification-failed` (webhook) | strategy omits `webhook` → tries `email` → dedup blocks |

Maximum adapter calls per original error: **N** (one per configured channel).

---

## Unsent notification storage

Failed sends can be persisted for auditing or manual retry:

```typescript
interface IUnsentNotificationStorage {
  save(record: UnsentNotificationRecord): Promise<void>;
  findPending(limit?: number): Promise<StoredUnsentNotification[]>;
  markRetried(id: string, error?: string): Promise<void>;
  delete(id: string): Promise<void>;
}

interface UnsentNotificationRecord {
  channelType:      ChannelType;
  appId?:           string;
  recipientInfo:    string;        // JSON — addresses, numbers, URL, or tokens
  formattedPayload: string;        // JSON — the payload that was attempted
  errorMessage:     string;
  originalEventId?: string;
  retryCount:       number;
  lastAttemptAt?:   Date;
}
```

### TypeORM adapter

```typescript
import { TypeOrmUnsentNotificationStorage, UnsentNotificationEntity } from '@rw3iss/tracker/notifications';

// Add UnsentNotificationEntity to your DataSource entities, then:
TrackerNotificationsPlugin.create({
  strategies:    [new NotifyOnErrorsStrategy()],
  channels:      { /* ... */ },
  unsentStorage: new TypeOrmUnsentNotificationStorage(ds.getRepository(UnsentNotificationEntity)),
})
```

Table: `tracker_unsent_notifications` — columns: `id`, `channelType`, `appId`, `recipientInfo`, `formattedPayload`, `errorMessage`, `originalEventId`, `retryCount`, `lastAttemptAt`, `createdAt`.

---

## Utility functions

Useful when writing custom strategies:

```typescript
import {
  isErrorEvent,              // event.type === 'error'
  isNotificationFailedEvent, // event.category === 'notification-failed'
  matchesCategory,           // matchesCategory(event, 'notification-failed')
  matchesType,               // matchesType(event, 'error')
  matchesAppId,              // matchesAppId(event, 'my-api')
  matchesEventFilter,        // matchesEventFilter(event, filter) — EventFilter union
  serializeEventToText,      // plain-text summary of a StoredTrackerEvent
  serializeEventToHtml,      // HTML summary
  truncate,                  // truncate(str, maxLength)
  resolveOmitFromFailedEvent, // extract failedChannel from a notification-failed event
} from '@rw3iss/tracker/notifications';
```

### `EventFilter` — composable event matching

`matchesEventFilter` supports both function predicates and config objects:

```typescript
import { matchesEventFilter, type EventFilter } from '@rw3iss/tracker/notifications';

// Function predicate
const onlyErrors: EventFilter = (event) => event.type === 'error';

// Config object (all fields are AND-combined)
const onlyProdErrors: EventFilter = { type: ['error'], appId: 'my-api' };

if (matchesEventFilter(event, onlyProdErrors)) { /* ... */ }
```

---

## Environment variable reference

| Variable | Adapter |
|---|---|
| `SMTP_USER` / `SMTP_PASS` | `SmtpAdapter` |
| `SENDGRID_API_KEY` | `SmtpAdapter` (SendGrid relay) or `SendGridApiAdapter` |
| `MAILGUN_API_KEY` | `MailgunAdapter` |
| `POSTMARK_TOKEN` | `PostmarkAdapter` |
| `TWILIO_SID` / `TWILIO_TOKEN` | `TwilioSmsAdapter` |
| `SLACK_WEBHOOK_URL` | `WebhookAdapter` (if targeting Slack) |
