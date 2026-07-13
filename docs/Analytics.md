# @rw3iss/tracker — Analytics Plugin (Design)

> **Status:** **Implemented.** Ships as `@rw3iss/tracker/analytics` (browser
> emitter) plus `AnalyticsQueryHelpers`, `SessionRollupPlugin`, and
> `SamplingPlugin` on the consumer side. This document remains as the design
> rationale; the implementation reference is [`src/analytics/README.md`](../src/analytics/README.md).

## Goal

Add a single opt-in plugin that turns the manually-driven tracker into an
automatic, GA-style behavioral analytics tool — without changing the existing
emitter API or wire format. Users wire it in once and stop hand-writing
`tracker.event('page_view', ...)` calls; the plugin emits a standardized
vocabulary as the user navigates and interacts.

```typescript
// Today (manual):
tracker.event('page_view', { page: '/auctions' });
tracker.event('button_click', { id: 'cta-bid' });

// With AnalyticsPlugin (automatic):
TrackerClient.init({
  endpoint: '...',
  plugins: [new AnalyticsPlugin({ pageViews: true, scrollDepth: true, /* ... */ })],
});
// Page views, sessions, engagement time, scroll depth, outbound clicks,
// form interactions, downloads, UTM, visitor IDs — all auto-emitted.
```

## Non-goals

- **Replacing the manual API.** `tracker.error()` / `tracker.info()` /
  `tracker.event()` keep working unchanged. AnalyticsPlugin is purely additive.
- **Matching Google's identity graph.** No Signals, no cross-device-via-Google-account.
  Anonymous visitor identity stays first-party.
- **ML-derived metrics.** No predicted purchase probability, no churn scoring,
  no audience auto-discovery. Could be added later as a separate consumer-side
  ML pipeline; out of scope here.
- **Mature attribution modeling.** Last-touch is straightforward; multi-touch /
  data-driven attribution is a separate larger effort.
- **AdWords / paid-campaign tooling.** Out of scope.

## Vocabulary

The plugin emits events with `type: 'event'` (so they always pass `minLevel`)
and a stable category/message convention modeled loosely on GA4 events:

| Category | Message | When |
|---|---|---|
| `analytics` | `page_view` | Initial load + every SPA route change |
| `analytics` | `session_start` | First event of a new session |
| `analytics` | `session_end` | Last event before inactivity timeout (best-effort, on `pagehide`) |
| `analytics` | `first_visit` | First event from a new visitor (no stored `clientId`) |
| `analytics` | `user_engagement` | Periodic active-time accumulation per page |
| `analytics` | `scroll` | Each scroll-depth milestone reached |
| `analytics` | `click_outbound` | Click on link to external host |
| `analytics` | `file_download` | Click on link with download-extension or `download` attr |
| `analytics` | `form_start` | First focus into any field of a form |
| `analytics` | `form_submit` | Form `submit` event |
| `analytics` | `view_search_results` | Page load with `?q=` / `?search=` / configured search params |
| `ecommerce` | (GA4-compatible names) | `view_item`, `add_to_cart`, `begin_checkout`, `purchase`, etc. — emitted manually by the host app, but with a typed helper for compatibility |

All events get the standard `TrackerContext` plus an `analytics` payload block:

```typescript
// Example event emitted by AnalyticsPlugin.PageViewCollector
{
  type:      'event',
  category:  'analytics',
  message:   'page_view',
  timestamp: 1735689600123,
  appId:     'buyer-portal',
  payload: {
    page_location:  'https://example.com/auctions/42?ref=newsletter',
    page_title:     'Spring Auction — 42',
    page_path:      '/auctions/42',
    page_referrer:  'https://example.com/',
    // attribution (carried for the session lifetime):
    utm_source:     'newsletter',
    // visitor / engagement:
    client_id:      'v_8c4e...e2a1',
    session_id:     's_1f3a...20bd',
    session_number: 7,
    is_first_visit: false,
  },
  context: {
    userId:      'u_123',         // if known
    sessionId:   's_1f3a...20bd', // mirrored into context for indexing
    environment: 'production',
    appVersion:  '36.0.0',
    url:         'https://example.com/auctions/42?ref=newsletter',
    userAgent:   '...',
  },
}
```

## API

```typescript
import { TrackerClient } from '@rw3iss/tracker';
import { AnalyticsPlugin } from '@rw3iss/tracker/analytics';

TrackerClient.init({
  endpoint: 'https://tracker.example.com/ingest/events',
  appId:    'buyer-portal',
  plugins: [
    new AnalyticsPlugin({
      // ── Visitor + session ────────────────────────────────────────────────
      visitor: {
        storage:        'localStorage',  // or 'cookie' | 'sessionStorage' | 'memory'
        cookieDomain:   '.example.com',  // when storage: 'cookie'
        cookieMaxAge:   2 * 365 * 86_400, // 2 years (GA default)
      },
      sessions: {
        inactivityMs:   30 * 60_000,    // GA4 default: 30 min idle → new session
        endOnPageHide:  true,           // fire session_end on pagehide
      },

      // ── Page tracking ────────────────────────────────────────────────────
      pageViews: true,                  // every nav (including SPA pushState)
      pageViewDebounceMs: 100,          // dedupe synchronous double-pushes

      // ── Engagement ───────────────────────────────────────────────────────
      engagement: {
        flushIntervalMs: 30_000,        // emit accumulator every 30s
        idleTimeoutMs:   30_000,        // user idle threshold
        signals: ['mousemove', 'keydown', 'scroll', 'touchstart', 'click'],
      },

      // ── Interaction collectors ───────────────────────────────────────────
      scrollDepth:    [25, 50, 75, 90], // % milestones per page view
      outboundClicks: true,             // links to external hosts
      fileDownloads:  {
        extensions: ['pdf', 'zip', 'csv', 'xlsx', 'mp4', 'mov'],
        // or honor the HTML5 `download` attribute:
        respectDownloadAttr: true,
      },
      forms: {
        start:        true,             // first focus per form
        submit:       true,             // submit event
        identify:     'name|id|action', // pick which form attr to use as identifier
      },

      // ── Attribution ──────────────────────────────────────────────────────
      utm: {
        params: ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid'],
        persistFor: 'session',          // 'session' | 'visitor' | 'never'
      },
      referrer: true,                   // capture document.referrer on session start
      searchParams: ['q', 'search', 'query'],  // emit view_search_results when present

      // ── Privacy ──────────────────────────────────────────────────────────
      respectDoNotTrack:    true,
      consent: {
        required:   true,               // gate all emission until granted
        granted:    () => myConsent.analytics === 'granted',
        // OR use the promise-based "wait for grant" form:
        waitFor:    new Promise((resolve) => myConsent.onGrant = resolve),
      },
      ipAnonymization: true,            // hint to server; consumer truncates IP

      // ── Filtering ────────────────────────────────────────────────────────
      ignorePaths:    [/^\/admin/, '/internal'],
      ignoreReferrers: ['localhost', 'staging.example.com'],
      sampleRate:     1.0,              // 0..1; emitted events are sampled here
    }),
  ],
});
```

Every option above is optional with sane defaults. Pass an empty config to get
"GA4-equivalent enhanced measurement" (page views + sessions + scroll + outbound
+ downloads + forms + engagement, all on).

## Internal architecture

`AnalyticsPlugin` is an `ITrackerClientPlugin` that owns a small set of single-
responsibility collectors. Each collector is independently toggleable from the
config above. They all funnel events through the host `TrackerClient` — no new
transport, no parallel queue.

```
AnalyticsPlugin
├── ConsentGate              gates emission until grant resolved
├── VisitorManager           long-lived clientId in localStorage/cookie
├── SessionLifecycle         inactivity-bounded; emits session_start / session_end
├── AttributionStore         captures UTM + referrer on session start; persists
├── PageViewCollector        history.pushState/replaceState patch + popstate listener
├── EngagementTracker        Visibility API + interaction listeners → active-time
├── ScrollDepthCollector     IntersectionObserver-based; once per milestone
├── OutboundLinkCollector    click delegation; classify by host
├── DownloadCollector        click delegation; classify by extension / download attr
├── FormCollector            focusin (once-per-form) + submit
└── SearchCollector          inspect query string on page_view
```

### `VisitorManager`

Generates and persists a long-lived random ID (`v_<hex>`) the first time the
plugin runs. Default storage is `localStorage`; cookie-mode is provided for
cross-subdomain continuity and analytics-grade attribution flows. Emits exactly
one `first_visit` event the first time a visitor is seen (after consent, if
gated).

API surface for consumers:

```typescript
analytics.getClientId();              // 'v_8c4e...'
analytics.resetVisitor();             // clears storage; next event creates a new ID
```

### `SessionLifecycle`

Reuses our existing `SessionManager` for ID generation but adds GA-style
boundaries:

- **Start** — first event after no prior session, or after the inactivity
  timeout has elapsed, or after `pagehide` fired with `endOnPageHide`. Emits
  `session_start` (with attribution payload).
- **Active** — any captured event resets the inactivity clock.
- **End** — best-effort: `pagehide` listener emits `session_end` synchronously
  via `sendBeacon`. If the page closes silently (browser kill), the next
  session_start in the gap > inactivityMs implicitly closes the prior session
  on the consumer side via query.

Persists `sessionId`, `session_number`, `session_start_ts`, and last activity
timestamp in `sessionStorage` so refreshes don't break sessions.

### `PageViewCollector`

Patches `history.pushState` / `history.replaceState` and subscribes to
`popstate` and `hashchange`. Debounces to dedupe synchronous double-pushes
(e.g. React Router during `<StrictMode>`). Emits one `page_view` per resolved
URL with title resolved from `document.title` *after* a microtask (so SPA
title updates land on the right event).

### `EngagementTracker`

The non-trivial one. GA4's `engagement_time_msec` is "active foreground time
since the last engagement event". Approach:

- Page load → start an accumulator
- On any of `mousemove` / `keydown` / `scroll` / `touchstart` / `click`,
  reset an idle timer (default 30s)
- While idle timer is running and tab is foreground (`document.visibilityState
  === 'visible'`), tick the accumulator each 1s
- Pause accumulator on `visibilitychange → hidden`
- Emit `user_engagement` at `flushIntervalMs` and on page change / `pagehide`
- Reset accumulator after each emit

Throttled signal listeners (capture phase, passive) keep CPU overhead minimal.

### `ScrollDepthCollector`

Uses an `IntersectionObserver` on a synthetic absolutely-positioned sentinel
at each milestone position relative to `document.scrollingElement`. Each
milestone emits exactly once per page view; collector resets on
`PageViewCollector` page-change events.

### `OutboundLinkCollector` / `DownloadCollector`

Delegated `click` listener at `document` level (capture, passive). Classifies:
- **Outbound** — link `href` host !== `location.host` (with optional same-org
  whitelist). Emits `click_outbound` with `link_url`, `link_text`, `link_id`.
- **Download** — has `download` attribute, or extension matches config.
  Emits `file_download`.

For browsers that ignore `preventDefault` on the listener (most modern), the
event is queued and `sendBeacon`-flushed before navigation completes.

### `FormCollector`

Two listeners, both delegated:
- `focusin` — first focus into any field of a form (tracked by form identifier),
  emits `form_start`.
- `submit` — emits `form_submit`. Captures form identifier (configurable —
  default precedence: `name` → `id` → `action`), submitter button text/id,
  and field count (not values — privacy default).

### `AttributionStore`

On the first event of each session:
1. Read `utm_*` + `gclid` (configurable) from `location.search`
2. Read `document.referrer`
3. Persist into `sessionStorage` keyed by `sessionId`
4. Stamp these on every subsequent event in the session

Survives navigation; expires with the session.

### `ConsentGate`

When `consent.required: true`:
- All collectors instantiate but their listeners stay detached
- `ConsentGate.grant()` (called from app code, or auto-resolved via `waitFor`)
  attaches listeners and replays a single deferred `first_visit` /
  `session_start` if appropriate
- `ConsentGate.revoke()` detaches listeners + clears `clientId` storage

Pairs with `respectDoNotTrack: true` which short-circuits `grant()` if the
browser has DNT set.

## Wire format compatibility

All AnalyticsPlugin events conform to the existing `TrackerEvent` schema. They
arrive at the consumer through the same pipeline as errors, breadcrumbs, and
manual events. No new schema, no parallel pipeline, no consumer-side branching.

Consumers that don't care about analytics queries can ignore the
`category: 'analytics'` events; they coexist with errors and other events.

## E-commerce vocabulary

Adopt GA4's standard event names + item structure. Provide a typed helper so
host code can emit them with autocomplete instead of stringly-typed track
calls:

```typescript
import { ecommerce } from '@rw3iss/tracker/analytics';

ecommerce.viewItem({ items: [{ item_id: 'sku-42', item_name: 'Vintage Watch',
                              price: 1200, currency: 'USD' }] });
ecommerce.addToCart({ items: [...], value: 1200, currency: 'USD' });
ecommerce.beginCheckout({ items: [...], value: 1200 });
ecommerce.purchase({ transaction_id: 'ord_99', value: 1200, items: [...] });
```

These are thin wrappers around `tracker.event(name, params)` with `category:
'ecommerce'`. The vocabulary is documented but not enforced — apps can emit
custom event shapes; consumers will just see them as `category: 'ecommerce'`
events with whatever payload the app sent.

## Server side

Most analytics views fall out of the existing query infrastructure. The new
work is a query helper class and a few materialization plugins.

### `AnalyticsQueryHelpers`

```typescript
import { AnalyticsQueryHelpers } from '@rw3iss/tracker/storage';

const helpers = new AnalyticsQueryHelpers(storage, 'buyer-portal');

await helpers.dauWauMau({ since: Date.now() - 30 * 86_400_000 });
await helpers.topPages({ since, limit: 50 });
await helpers.sessionDurationP95({ since });
await helpers.engagementRate({ since });
await helpers.trafficSources({ since });
await helpers.exitPages({ since, limit: 25 });
await helpers.entryPages({ since, limit: 25 });

// Funnels — ordered events, drop-off at each step
await helpers.funnel(
  ['view_item', 'add_to_cart', 'begin_checkout', 'purchase'],
  { since, windowMs: 30 * 60_000 },
);

// Cohorts — N-day retention curves
await helpers.cohortRetention({
  cohortEvent: 'first_visit',
  returnEvent: 'session_start',
  cohortBucketDays: 1,
  retentionWindowDays: 30,
});

// Last-touch attribution for a conversion event
await helpers.attribution({
  conversionEvent: 'purchase',
  model:           'last-touch',
  lookbackMs:      7 * 86_400_000,
});
```

### Materialization plugins (consumer-side)

Funnel and retention queries become expensive at volume. Two new server plugins
keep them fast:

- **`SessionRollupPlugin`** — `onEvent` listener that incrementally maintains a
  `tracker_sessions` summary table (one row per session, with first/last
  timestamps, event count, page count, attribution).
- **`DailyAggregatePlugin`** — cron-driven (BullMQ schedule) that materializes
  daily DAU / MAU / top-pages tables overnight.

Both are optional; without them queries hit `tracker_events` directly with the
same indexes that already exist.

### Dashboard panels

Add purpose-built analytics panels to the existing dashboard:

- **Realtime** (already feasible via SSE) — active sessions in the last 5 min
- **Audience** — DAU / WAU / MAU, returning vs new, geo
- **Acquisition** — traffic sources, UTM breakdown, top referrers
- **Engagement** — top pages, sessions, average session duration, engagement
  rate, scroll depth distribution
- **Conversions** — funnel builder, conversion rate over time

Panels are read-only from `AnalyticsQueryHelpers`. The funnel builder is the
only one with significant UI work; the rest are tables and time-series charts.

## Privacy + consent

Self-hosted analytics is the privacy story. Defaults:

- **No cross-site tracking.** `clientId` is per-domain; we don't ship anything
  that joins it to other sites.
- **Honor DNT** when `respectDoNotTrack: true` — no events emitted at all.
- **IP anonymization** — `ipAnonymization: true` is a hint forwarded to the
  consumer; consumer-side `GeoIpEnricher` truncates the last octet (IPv4) /
  last 80 bits (IPv6) before lookup.
- **Cookie mode is opt-in.** `localStorage` default has no GDPR cookie-banner
  obligation; cookie mode is for sites that need cross-subdomain continuity.
- **Form values are never captured.** Field count yes, identifier yes, values
  no. Override paths require explicit per-field opt-in (future feature).
- **Consent gate** wraps everything. Granular categories (`analytics`,
  `marketing`, `personalization`) can be wired by passing different gate
  callbacks for different collector subsets.

## Performance

Targets:

- **Idle CPU overhead** — ≤ 0.1% on a modern laptop. Achieved via passive
  listeners, capture-phase delegation, accumulator-based engagement (one timer,
  not per-event), IntersectionObserver for scroll.
- **Bundle size** — ≤ 8 KB gzipped for the full plugin (achievable; reuses
  existing breadcrumb collector primitives, IDB queue, transport).
- **Event volume** — opinionated defaults emit roughly 5–15 events per page
  view. Sampling and `ignorePaths` tune this for high-traffic sites.

## Open questions

1. **Anonymous user merge.** When an anonymous visitor signs in, GA reconciles
   `client_id` ↔ `user_id` so prior sessions attribute to the user. Should we
   replay session events with the new `userId`? Emit a `user_id_assigned` event
   that the consumer uses to backfill on query? Leaving anonymous-only at
   query time is simplest but loses pre-login attribution.

2. **Cross-tab sessions.** Our `TabCoordinator` already exists for the shared
   IDB queue. Should sessions span tabs (one session per visitor, regardless
   of tab) or be per-tab (GA's default)? Probably per-visitor with optional
   per-tab override — but the inactivity heuristic gets fuzzier across tabs.

3. **Where should sampling live?** "Sampling" means recording only a fraction
   of events instead of all of them — a cost lever for high-volume sites that
   trades absolute counts for cheaper bandwidth / storage / compute. Ratios
   (bounce rate, conversion rate) survive sampling; totals don't. Three places
   it could live:

   | Where | What happens | Saves | Loses |
   |---|---|---|---|
   | **Client** (the "edge") | Plugin rolls a random number per event; if `Math.random() > sampleRate`, the event never leaves the browser | Bandwidth + server ingest + storage + network | The data — gone forever, can't recover it later |
   | **Consumer / ingest** | All events arrive at `tracker-ingest`; the consumer drops a fraction before persisting | Storage only | Same data loss as edge, plus you've paid for the bandwidth |
   | **At read time** | Store every event; downsample (or use approximate aggregations) when *querying* | Dashboard query time / compute | Nothing — full fidelity preserved, queries choose their own fidelity |

   Edge sampling is the cheap one but it's a one-way decision: if next year you
   need to answer a new question, the dropped 90% of events never existed from
   the data store's perspective. Read-time sampling is the high-fidelity one
   but storage costs scale with traffic.

   **Sharp edge:** sampling *rare* events at the edge is especially bad. If
   the error rate is 0.1% and we sample at 10%, we now see 0.01% — a user's
   error storm becomes invisible because the dice rolled wrong every time.
   So the realistic shape is "sample the cheap, high-volume stuff; always
   emit the high-value stuff":

   ```typescript
   new AnalyticsPlugin({
     sampleRate: 0.1,                 // 10% by default (page views, scroll, engagement, …)
     alwaysEmit: [                    // these bypass sampling — full fidelity
       'session_start', 'session_end', 'first_visit',
       'purchase', 'view_item',
     ],
     // OR a predicate:
     alwaysEmitWhen: (event) =>
       event.type === 'error' || event.category === 'ecommerce',
   });
   ```

   **Recommendation for v1:**
   - Default `sampleRate: 1.0` (no sampling). Most sites won't hit volume
     where sampling matters, and premature sampling is a data-loss footgun.
   - Ship `alwaysEmit` / `alwaysEmitWhen` so when users do turn sampling on,
     errors and conversions stay full-fidelity by default.
   - Defer read-time sampling — add it to `AnalyticsQueryHelpers`
     (`helpers.topPages({ sample: 0.1 })`) once query cost is a real
     complaint. Edge sampling is one flag and a `Math.random()` check;
     read-time is more plumbing and not worth it until funnels and cohorts
     exist.

4. **Event vocabulary versioning.** Once apps depend on `page_view` /
   `user_engagement` event names, we can't rename them without breaking
   queries. Document the vocabulary as v1 and gate vocabulary changes behind
   plugin major versions.

5. **Out-of-process workers.** For very high-volume sites, the plugin's
   IndexedDB queue can be backed by the existing `serviceWorkerTransport`
   so analytics events keep delivering after the page closes. Already
   plumbed; just needs documentation and a default-on toggle for analytics
   mode.

## Phasing

| Phase | Scope | Estimate |
|---|---|---|
| 1 | `AnalyticsPlugin` with PageView, Session, Engagement, ScrollDepth, OutboundClick, Download, Form, UTM. Visitor + Consent gates. ~1000 LOC. | 1 week |
| 2 | `AnalyticsQueryHelpers` (DAU/MAU, top pages, sessions, traffic sources). Server-side dashboards: realtime + audience + acquisition + engagement panels. | 1 week |
| 3 | `SessionRollupPlugin` + `DailyAggregatePlugin` for materialized aggregates. | 3 days |
| 4 | Funnels — query + dashboard funnel builder UI. | 2 weeks |
| 5 | Cohort retention + last-touch attribution. | 1 week |
| 6 | E-commerce vocabulary helpers + standard ecommerce dashboard panels. | 3 days |

Phase 1 alone unlocks the majority of the value — page views and engagement on
top of error tracking, all in one self-hosted pipeline. Phases 4–5 are where
we cross from "GA replacement on a brochure site" into "GA replacement on a
marketplace".

## See also

- [`docs/GoogleAnalytics.md`](./GoogleAnalytics.md) — companion plugin design
  for sites that want to keep GA in addition to (or instead of) the
  AnalyticsPlugin.
- [`docs/API_CONTRACT.md`](./API_CONTRACT.md) — wire format, unchanged by this
  proposal.
