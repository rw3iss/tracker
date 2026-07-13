# `@rw3iss/tracker/analytics`

Self-hosted, GA-style behavioral analytics on top of the tracker pipeline. One opt-in plugin auto-emits a stable vocabulary of `page_view`, `session_start`/`session_end`, `scroll`, `click_outbound`, `file_download`, `form_start`/`form_submit`, `view_search_results`, `user_engagement`, and `first_visit` events with full session/visitor context.

```typescript
import { TrackerClient } from '@rw3iss/tracker';
import { AnalyticsPlugin } from '@rw3iss/tracker/analytics';

TrackerClient.init({
  endpoint: 'https://tracker.example.com/ingest/events',
  appId:    'buyer-portal',
  plugins:  [new AnalyticsPlugin()],   // GA4-equivalent enhanced measurement
});
```

That alone gives you page views (incl. SPA route changes), inactivity-bounded sessions, engagement time, scroll milestones, outbound clicks, downloads, form interactions, UTM/referrer attribution, anonymous visitor identity, and identity-merge events when users sign in. No further code required.

For consumer-side queries (DAU/MAU, top pages, funnels, cohorts, last-touch attribution), see [`@rw3iss/tracker/storage`](../consumer/storage) → `AnalyticsQueryHelpers`.

---

## Configuration — `AnalyticsConfig`

Every option is optional. Defaults match GA4's enhanced-measurement set.

```typescript
new AnalyticsPlugin({
  // ── Visitor + session ────────────────────────────────────────────────
  visitor: {
    storage:        'localStorage',  // 'localStorage' | 'cookie' | 'sessionStorage' | 'memory'
    cookieDomain:   '.example.com',  // when storage: 'cookie'
    cookieMaxAge:   2 * 365 * 86_400, // 2 years (GA default)
    cookiePath:     '/',
    cookieSameSite: 'Lax',           // 'Strict' | 'Lax' | 'None'
    cookieSecure:   undefined,       // default: derives from `https:`
  },
  sessions: {
    inactivityMs:   30 * 60_000,     // 30 min — GA4 default
    endOnPageHide:  true,            // fire session_end on pagehide
    multiTab:       'shared',        // 'shared' (one session per visitor across tabs) | 'per-tab'
  },

  // ── Page tracking ────────────────────────────────────────────────────
  pageViews:           true,
  pageViewDebounceMs:  100,

  // ── Engagement ───────────────────────────────────────────────────────
  engagement: {
    flushIntervalMs:  30_000,
    idleTimeoutMs:    30_000,
    signals:          ['mousemove', 'keydown', 'scroll', 'touchstart', 'click'],
  },
  // OR `engagement: false` to disable

  // ── Interaction collectors ───────────────────────────────────────────
  scrollDepth:    [25, 50, 75, 90],   // milestones in % — `false` to disable
  outboundClicks: true,
  fileDownloads: {
    extensions: ['pdf', 'zip', 'csv', 'xlsx', 'mp4', 'mov', /* ... */],
    respectDownloadAttr: true,        // honor HTML5 `download` attr regardless of extension
  },
  forms: {
    start:    true,
    submit:   true,
    identify: 'name|id|action',       // pipe-separated precedence for form identifier
  },

  // ── Attribution ──────────────────────────────────────────────────────
  utm: {
    params:     ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
                 'utm_content', 'gclid', 'gbraid', 'wbraid', 'dclid',
                 'fbclid', 'msclkid', 'ttclid'],
    persistFor: 'session',            // 'session' | 'visitor' | 'never'
  },
  referrer:     true,
  searchParams: ['q', 'search', 'query'],

  // ── Identity merge ───────────────────────────────────────────────────
  emitIdentityMergeEvent: true,       // emit `user_identified` on sign-in (anonymous → identified)

  // ── Sampling ─────────────────────────────────────────────────────────
  sampleRate:     1.0,                // 0..1; default no sampling
  alwaysEmit:     ['session_start', 'session_end', 'first_visit',
                   'user_identified', 'purchase'],
  alwaysEmitWhen: (event) => event.type === 'error',

  // ── Privacy ──────────────────────────────────────────────────────────
  respectDoNotTrack: true,
  consent: {
    required: true,
    granted:  () => myCookieBanner.isAccepted,
    waitFor:  myCookieBanner.onAccept,
  },
  ipAnonymization: true,              // hint to consumer (`payload.ip_anonymization: true`)

  // ── Filtering ────────────────────────────────────────────────────────
  ignorePaths:      [/^\/admin/, '/internal'],
  ignoreReferrers:  ['localhost', 'staging.example.com'],
});
```

Boolean shortcuts: any object option (`engagement`, `forms`, `fileDownloads`, `utm`) accepts `true` (defaults), `false` (disabled), or an object override.

---

## Event vocabulary

Stable v1 names. Every event is `type: 'event'` with `category: 'analytics'` (or `'ecommerce'` for commerce) and the listed payload.

| Message | When | Payload |
|---|---|---|
| `first_visit` | First time we see a visitor | `{ client_id, ... }` |
| `session_start` | New session begins | `{ session_number, session_start_ts, utm_source, utm_medium, utm_campaign, page_referrer, ... }` |
| `session_end` | Session ends (pagehide or inactivity rotation) | `{ session_number, session_duration_ms }` |
| `user_identified` | Anonymous → identified (host called `setContext({ userId })`) | `{ user_id, client_id }` |
| `user_anonymized` | Identified → anonymous (sign out) | `{ previous_user_id, client_id }` |
| `page_view` | Navigation (initial + SPA pushState/popstate) | `{ page_location, page_path, page_title, page_referrer }` |
| `view_search_results` | Page load with `?q=` / `?search=` / configured param | `{ search_term, search_param }` |
| `user_engagement` | Periodic active-time accumulator emit | `{ engagement_time_msec }` |
| `scroll` | Per scroll-depth milestone, once per page view | `{ percent_scrolled }` |
| `click_outbound` | Click on link to external host | `{ link_url, link_domain, link_text, link_id, link_classes, outbound: true }` |
| `file_download` | Click on link with download extension or `download` attr | `{ file_url, file_name, file_extension, link_text, link_id }` |
| `form_start` | First focus into any field of a form | `{ form_id, field_count }` |
| `form_submit` | Form submit | `{ form_id, field_count, submit_text, submit_id }` |

Every event is additionally stamped with:
- `client_id` — long-lived visitor identity
- `session_id` — current session
- `session_number` — Nth session for this visitor
- All UTM + referrer values from the session's `AttributionStore`
- `ip_anonymization: true` (when configured) — a hint the consumer's `GeoIpEnricher` truncates the IP before lookup

---

## Public API

```typescript
const analytics = new AnalyticsPlugin({ /* ... */ });

analytics.getClientId();    // long-lived 'v_...' id
analytics.getSessionId();   // current 's_...' id
analytics.resetVisitor();   // forget visitor — next event creates new client_id and fires first_visit
analytics.rotateSession();  // force session_end + session_start
analytics.grantConsent();   // imperative consent grant
analytics.revokeConsent();  // imperative revoke + reset visitor
```

---

## Ecommerce

Type-safe wrappers around the GA4 ecommerce vocabulary:

```typescript
import { ecommerce } from '@rw3iss/tracker/analytics';

ecommerce.viewItem({ items: [
  { item_id: 'sku-42', item_name: 'Vintage Watch', price: 1200, currency: 'USD' },
] });

ecommerce.addToCart({
  value: 1200, currency: 'USD',
  items: [{ item_id: 'sku-42', quantity: 1, price: 1200, currency: 'USD' }],
});

ecommerce.beginCheckout({ value: 1200, currency: 'USD', items: [...] });

ecommerce.purchase({
  transaction_id: 'ord-99',
  value: 1200, currency: 'USD',
  shipping: 12.50, tax: 96,
  items: [...],
});

ecommerce.refund({ transaction_id: 'ord-99' });
```

Available helpers: `viewItemList`, `selectItem`, `viewItem`, `addToCart`, `removeFromCart`, `viewCart`, `addToWishlist`, `beginCheckout`, `addPaymentInfo`, `addShippingInfo`, `purchase`, `refund`, `viewPromotion`, `selectPromotion`.

---

## Service-Worker delivery

For sites that already have a service worker, integrate the tracker sync:

```typescript
// my-sw.js
import { setupTrackerSync } from '@rw3iss/tracker/sw';
setupTrackerSync();
```

Or use the standalone SW (`@rw3iss/tracker` ships `dist/tracker-sw.mjs`):

```typescript
TrackerClient.init({
  endpoint: '...',
  serviceWorkerTransport: { swUrl: '/tracker-sw.js' },
  plugins: [new AnalyticsPlugin()],
});
```

Browsers run one service worker per scope, so if your site already registers one, you must integrate `setupTrackerSync()` into it rather than adding a second.

---

## Consumer-side queries

```typescript
import { AnalyticsQueryHelpers } from '@rw3iss/tracker/storage';

const a = new AnalyticsQueryHelpers(storage, 'buyer-portal');

await a.dau();                                                   // distinct client_ids in last 24h
await a.dauWauMau();                                             // 1d / 7d / 30d
await a.topPages({ limit: 25 });                                 // top page paths
await a.sessionDuration();                                        // avg / p50 / p95 ms
await a.trafficSources();                                         // utm_source breakdown
await a.funnel(['view_item', 'add_to_cart', 'purchase']);
await a.cohortRetention({ retentionWindowDays: 30 });
await a.lastTouchAttribution({ conversionEvent: 'purchase' });
```

For high-volume deployments, attach `SessionRollupPlugin` to maintain a `tracker_sessions` summary table that supports flat SQL queries:

```typescript
import { SessionRollupPlugin } from '@rw3iss/tracker/consumer';

TrackerModule.register({
  plugins: [
    new SessionRollupPlugin({
      sink:            myPostgresSessionsSink,    // implements ISessionRollupSink
      flushIntervalMs: 60_000,
    }),
    /* other plugins... */
  ],
});
```

For consumer-side sampling override:

```typescript
import { SamplingPlugin } from '@rw3iss/tracker/consumer';

TrackerModule.register({
  plugins: [
    new SamplingPlugin({
      rate:       0.1,                      // drop 90% of low-value events
      alwaysEmit: ['session_start', 'session_end', 'purchase' /* ... */],
    }),
    /* other plugins... */
  ],
});
```

---

## Privacy

- `localStorage` storage for `client_id` — no cookies by default, no third-party tracking
- DNT respected by default (`respectDoNotTrack: true`)
- Consent gate buffers `first_visit` and `session_start` until granted, then replays
- Form values are never captured — only field counts and form identifiers
- IP anonymization hint propagated to the consumer
- Per-event sampling supports privacy-grade aggregation modes
