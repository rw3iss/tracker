# @rw3iss/tracker — Google Analytics Plugin (Design)

> **Status:** **Implemented.** Ships as `@rw3iss/tracker/ga` (browser, gtag.js
> + GTM adapters) and `@rw3iss/tracker/ga/server` (Node, Measurement
> Protocol adapter). Three modes — `ga-only`, `tandem`, `forward` — plus
> multi-ID, batched forwarding, Consent Mode v2 wiring, and `gaPresets`. This
> document remains as the design rationale; the implementation reference is
> [`src/ga/README.md`](../src/ga/README.md).

## Goal

Make adopting GA4 a one-liner from the tracker's perspective: pass a
measurement ID, get GA running. Avoid touching `gtag.js` boilerplate, the GA
admin UI, or the various confused tutorials about page-view firing in SPAs.

```typescript
// One line — that's the whole integration:
TrackerClient.init({
  endpoint: '...',
  plugins: [new GoogleAnalyticsPlugin({ measurementId: 'G-XXXXXXXX' })],
});
```

The plugin lazy-loads `gtag.js`, mounts the consent boilerplate, hooks GA's
event firing through our pipeline (or in parallel — see modes below), exposes a
typed API for runtime configuration, and inherits visitor / session / consent
state from the tracker so the two systems stay in sync.

## Why this exists

Self-hosted analytics ([AnalyticsPlugin](./Analytics.md)) is the right answer
for a lot of teams, but not all of them:

- Marketing has GA dashboards they're not switching off
- The CMO wants `gclid` attribution into Google Ads
- Compliance signed off on GA already; switching is paperwork
- A brochure site hasn't earned the operational cost of self-hosting

For those cases this plugin gives the same one-line integration story we have
for our own analytics — but pointed at GA. And for teams that want both, the
two plugins coexist and share state.

## Three modes of operation

The same plugin supports three deployment modes; the choice is a config
option.

### Mode A — GA only (lightweight)

The simplest case. The user has GA, doesn't care about self-hosted analytics,
just wants the one-line setup.

```typescript
plugins: [
  new GoogleAnalyticsPlugin({
    measurementId: 'G-XXXXXXXX',
    mode:          'ga-only',  // default when AnalyticsPlugin is not present
  }),
],
```

What happens:
- Lazy-loads `https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXX`
- Initializes `gtag('js', new Date())` and `gtag('config', measurementId, ...)`
- GA does its thing — page views, sessions, all of it
- The plugin exposes a typed `ga.set/track/identify` API on top
- **Tracker error events are not forwarded** — they go to our consumer
  pipeline as before. GA stays focused on user behavior.

Even Mode A adds value: typed config, lazy loading, consent integration, and
runtime configuration (custom dimensions, user properties, debug mode toggle)
without writing `gtag(...)` calls.

### Mode B — Tandem with AnalyticsPlugin (parallel)

Both plugins active. Each captures user behavior independently and sends it to
its own backend. They share the same visitor and session IDs so cross-system
analysis is possible.

```typescript
plugins: [
  new AnalyticsPlugin({ /* full config */ }),
  new GoogleAnalyticsPlugin({
    measurementId: 'G-XXXXXXXX',
    mode:          'tandem',
    shareIdentity: true,        // tracker clientId/sessionId → GA client_id/session_id
  }),
],
```

What happens:
- Both plugins mount their collectors (page views, scroll, etc.)
- Each emits to its own destination — no double-counting on either backend
- `shareIdentity: true` injects the tracker's `clientId` as GA's `client_id`
  via `gtag('config', id, { client_id: ... })`, so the same visitor
  resolves on both systems
- Consent gate is shared — granting consent ungates both plugins together

This is the obvious mode for teams running both during a migration period, or
permanently if marketing wants GA dashboards and engineering wants the
self-hosted error/event store.

### Mode C — Tracker drives GA (forward)

The AnalyticsPlugin captures everything, and the GA plugin forwards a
configurable subset to GA via `gtag()`. Only one set of collectors runs (the
tracker's), GA gets a firehose-or-filtered stream.

```typescript
plugins: [
  new AnalyticsPlugin({ /* full config */ }),
  new GoogleAnalyticsPlugin({
    measurementId: 'G-XXXXXXXX',
    mode:          'forward',
    forward: {
      events:    ['page_view', 'session_start', 'view_item', 'purchase', /* ... */],
      // Or a predicate for fine control:
      filter:    (event) => event.category === 'ecommerce' || event.message === 'page_view',
      mapName:   (msg) => msg,           // identity by default; override for renames
      mapParams: (event) => ({ ...event.payload }),
    },
  }),
],
```

What happens:
- GA's auto-tracking is **disabled** (`gtag('config', id, { send_page_view: false })`)
- Tracker collectors drive everything; matching events get a `gtag('event', ...)` call
- Single source of truth on the client; GA becomes a downstream sink
- Avoids double counts (the failure mode of running both with auto-tracking on)

Mode C is the right setup for "we want GA's analytics UI but our tracker's
events are canonical".

## API

```typescript
import { TrackerClient } from '@rw3iss/tracker';
import { GoogleAnalyticsPlugin } from '@rw3iss/tracker/ga';

const ga = new GoogleAnalyticsPlugin({
  measurementId: 'G-XXXXXXXX',         // required
  mode:          'ga-only',            // 'ga-only' | 'tandem' | 'forward'

  // ── Loading ──────────────────────────────────────────────────────────
  load: 'lazy',                        // 'lazy' (default — on first use) | 'eager' | 'manual'
  scriptSrc: 'https://www.googletagmanager.com/gtag/js',  // override for proxying
  nonce:     '...',                    // CSP nonce if your CSP requires it
  defer:     true,

  // ── Configuration forwarded to gtag('config', id, { ... }) ──────────
  config: {
    debug_mode:     process.env.NODE_ENV !== 'production',
    send_page_view: true,              // false in 'forward' mode automatically
    cookie_domain:  'auto',
    cookie_flags:   'SameSite=None;Secure',
    // GA4-style options pass through unchanged
  },

  // ── Identity sharing (tandem / forward modes) ────────────────────────
  shareIdentity: true,                 // tracker clientId → GA client_id
  shareSession:  true,                 // tracker sessionId → GA session_id

  // ── Consent integration ──────────────────────────────────────────────
  consent: {
    defaults: {                        // gtag('consent', 'default', ...)
      analytics_storage:    'denied',
      ad_storage:           'denied',
      ad_user_data:         'denied',
      ad_personalization:   'denied',
    },
    // Promise that resolves to the granted-state object when consent lands.
    // Plugin calls gtag('consent', 'update', resolvedValue) on resolution.
    waitFor: myConsentBanner.onAccept,
  },

  // ── Filtering (forward mode) ─────────────────────────────────────────
  forward: {
    events:    ['page_view', 'purchase' /* ... */],
    filter:    (event) => true,
    mapName:   (msg) => msg,
    mapParams: (event) => event.payload ?? {},
  },

  // ── Privacy ──────────────────────────────────────────────────────────
  respectDoNotTrack: true,             // don't load gtag at all if DNT set
  ipAnonymization:   true,             // sets anonymize_ip on GA events
});

TrackerClient.init({ endpoint: '...', plugins: [ga] });
```

After init, the plugin exposes a typed runtime API:

```typescript
// Custom event — same call shape as gtag('event', ...) but typed
ga.event('add_to_cart', { value: 1200, currency: 'USD', items: [...] });

// User properties / custom dimensions
ga.setUserProperty('plan_tier', 'pro');
ga.setUserId('u_123');               // login
ga.clearUserId();                    // logout

// Update GA configuration at runtime (e.g. after consent)
ga.updateConfig({ send_page_view: false });
ga.setConsent({ analytics_storage: 'granted' });

// Programmatic page view (useful when SPAs control routing)
ga.pageView({ page_path: '/auctions/42', page_title: 'Spring Auction — 42' });

// Lifecycle
await ga.flush();                    // gtag('event', 'flush') wrapper
ga.disable();                        // sets window['ga-disable-G-XXXXXXXX'] = true
ga.enable();
```

The same instance is also available via the `TrackerClient` plugin registry:

```typescript
import { tracker } from '@rw3iss/tracker';
const ga = tracker.getPlugin('GoogleAnalyticsPlugin') as GoogleAnalyticsPlugin;
```

## Internal architecture

```
GoogleAnalyticsPlugin
├── ScriptLoader            lazy / eager / manual injection of gtag.js
├── ConsentBridge           gtag('consent', 'default'/'update', ...) — defaults + waitFor
├── ConfigBridge            gtag('config', id, { ... })
├── IdentityBridge          tracker → GA client_id / session_id sync
├── EventBridge             tracker pipeline tap (forward mode)
└── ApiSurface              typed wrapper over gtag() for runtime calls
```

### `ScriptLoader`

Injects `<script src="...gtag/js?id=...">` once, on first use (lazy) or
eagerly. Honors CSP `nonce`, `defer`, and a custom `scriptSrc` (for teams
proxying GA through their own domain to avoid third-party-cookie issues).
DNT short-circuits loading entirely when `respectDoNotTrack: true`.

Maintains a tiny in-memory `dataLayer` queue before the script lands so calls
made before script load aren't lost — `gtag.js` itself drains this on init.

### `ConsentBridge`

Wraps GA's [Consent Mode v2](https://developers.google.com/tag-platform/security/guides/consent)
with a single config block:

- `consent.defaults` becomes `gtag('consent', 'default', defaults)` *before*
  GA loads (so signals like `wait_for_update` are honored)
- `consent.waitFor` resolves to a partial update object →
  `gtag('consent', 'update', resolved)`
- Consent state is also propagated to the tracker's own `ConsentGate` if
  AnalyticsPlugin is present, so granting consent in one place ungates both

### `IdentityBridge` (tandem / forward modes)

If AnalyticsPlugin is also active, IdentityBridge subscribes to the tracker's
`VisitorManager` and `SessionLifecycle` and pushes their IDs into GA via
`gtag('config', id, { client_id, session_id })`. Two effects:

1. The same visitor resolves to one GA `client_id` even across our
   `localStorage.clear()` events (we control the source).
2. The same session boundaries align — GA's "session" matches the tracker's
   `sessionId` rather than GA's own inactivity logic.

Without AnalyticsPlugin (Mode A), IdentityBridge is a no-op — GA generates its
own `client_id` as usual.

### `EventBridge` (forward mode)

Subscribes to the host `TrackerClient`'s `onCapture` hook (we already have
this — `ITrackerClientPlugin.onCapture`). For each event:

1. Run `forward.filter(event)` — bail if false
2. Map name with `forward.mapName(event.message)`
3. Map params with `forward.mapParams(event)`
4. Emit `gtag('event', mappedName, mappedParams)`

The original event is unchanged; the GA forward is purely additive. If GA
isn't loaded yet (lazy mode), the call falls into gtag's pre-init queue and
fires once the script lands.

### `ApiSurface`

Plain typed wrapper over `gtag()`. The interesting part is type safety: GA4
defines a fixed set of recommended events with documented param shapes (e.g.
`add_to_cart` expects `{ value, currency, items }`). The wrapper ships TS
types for the recommended events so autocomplete works, while still allowing
arbitrary string event names with `Record<string, unknown>` params.

```typescript
type GA4Event =
  | { name: 'add_to_cart';     params: { value: number; currency: string; items: GA4Item[] } }
  | { name: 'purchase';        params: { transaction_id: string; value: number; currency: string; items: GA4Item[] } }
  | { name: 'view_item';       params: { value?: number; currency?: string; items: GA4Item[] } }
  | { name: 'login';           params: { method?: string } }
  | { name: 'sign_up';         params: { method?: string } }
  | /* ...the full GA4 recommended-events catalog... */;

ga.event(name, params);  // typed against GA4Event union, falls back to string for custom events
```

## Privacy + compliance

GA is a third-party-cookie-grade tool; the plugin doesn't pretend otherwise.
It does make compliance easier:

- **Consent Mode v2** is wired by default with `denied` defaults — GA loads
  but doesn't write storage until consent updates. This is the GDPR-safe
  pattern Google recommends.
- **DNT respect** is opt-in but the default. With `respectDoNotTrack: true`,
  the plugin doesn't even inject `gtag.js` for DNT users.
- **`anonymize_ip` / `ip_override`** are exposed via config.
- **Server-side proxying** is supported — set `scriptSrc` to your proxy and
  GA still works while keeping first-party cookies and bypassing some ad
  blockers.

Document these clearly in the README; teams adopting GA still need to handle
the cookie banner and privacy-policy disclosures themselves — the plugin can't
do that for them.

## Configuration shortcuts

A few convenience helpers for common GA configurations:

```typescript
// Pre-baked option packages users can spread into config
import { gaPresets } from '@rw3iss/tracker/ga';

new GoogleAnalyticsPlugin({
  measurementId: 'G-XXX',
  ...gaPresets.privacyFirst,    // DNT respect + IP anon + cookieless mode + denied defaults
  // ...gaPresets.spaApp,       // disables auto page views, use ga.pageView() manually
  // ...gaPresets.brochureSite, // GA defaults — auto page views, all enhanced measurement on
});
```

`spaApp` is the one most teams want in practice — GA's auto page-view in SPAs
is a known footgun (fires on initial load only, misses route changes), and
the standard fix is to disable auto and call `ga.pageView()` from the router.
Our preset packages this:

```typescript
gaPresets.spaApp = {
  config: { send_page_view: false },
  // implementation also auto-wires history.pushState/popstate to ga.pageView()
  // so even brochure-style SPAs work without router glue.
};
```

## Filtering / opinionated defaults

GA's enhanced measurement fires events for things the host might not want:

- `click` events on every outbound link
- `file_download` for any extension GA recognizes
- `scroll` at 90% depth

The plugin exposes a single config block to opt out of any of these without
visiting the GA admin UI:

```typescript
new GoogleAnalyticsPlugin({
  measurementId: 'G-XXX',
  enhancedMeasurement: {
    pageViews:        true,
    scrolls:          false,
    outboundClicks:   true,
    siteSearch:       true,
    videoEngagement:  false,
    fileDownloads:    true,
    formInteractions: false,
  },
});
```

This translates to a single `gtag('config', id, { enhanced_measurement_settings:
{ ... } })` call — but the config block is much more discoverable than GA's
admin UI buried under Data Streams → Web → Enhanced Measurement.

## Comparing the modes — when to pick each

| Need | Mode |
|---|---|
| Just want GA running with one line | A (`ga-only`) |
| Already have AnalyticsPlugin, want GA dashboards too | B (`tandem`) |
| AnalyticsPlugin events are canonical, GA is downstream | C (`forward`) |
| Migrating off GA — want both running until the cutover | B, then drop the GA plugin |
| Migrating *to* GA from analytics in `tracker.event()` calls | C — keep the events, route them to GA |
| GDPR-strict deployment | Any mode + `gaPresets.privacyFirst` |
| SPA app | Any mode + `gaPresets.spaApp` |

## Tradeoffs vs. just calling `gtag()` directly

What this plugin gives you that hand-rolled `gtag` doesn't:
- **One-line setup**, including consent defaults, lazy loading, CSP nonce
- **TS types** for GA4 recommended events
- **SPA page views** working out of the box (a major source of GA pain)
- **Identity sharing** with the rest of the tracker
- **Forward mode** — single source of truth for events
- **Configuration in code**, not the GA admin UI

What it doesn't give you:
- A way to manage GA's own admin settings (audiences, conversions,
  custom dimension *definitions*) — those still happen in GA UI. The plugin
  configures *runtime* behavior, not GA account configuration.
- Custom report building inside GA — that's still GA's UI.
- Server-side GA Measurement Protocol — out of scope for a client plugin.
  Could be a future `@rw3iss/tracker/ga-server` if there's demand.

## Open questions

1. **Server-side companion.** GA's Measurement Protocol lets servers post
   events directly to GA, useful for purchases that happen post-redirect or
   for hardening against ad blockers. Worth a separate `/ga-server`
   subpackage for the consumer side? Probably yes, but later — start client-only.

2. **Multiple GA properties.** Some sites send to multiple measurement IDs
   (e.g. brand + agency). Either accept `measurementId: string | string[]`
   or instantiate the plugin twice. Probably the latter is cleaner; document it.

3. **GTM (Google Tag Manager) instead of gtag.js.** Some teams use GTM as the
   tag aggregator. Different script URL, different command syntax (`dataLayer.push`
   instead of `gtag()`). Worth a `googleTagManager: true` mode that swaps the
   loader and the API surface. Defer until asked.

4. **Forward mode performance.** For a high-traffic site with full
   AnalyticsPlugin firing 15 events / page view, forwarding all of them to GA
   is wasteful. The default forward filter should be opinionated — page views,
   sessions, and ecommerce events; everything else stays tracker-only.

5. **Consent bridging direction.** If the user clicks "deny" in our
   `ConsentGate`, should we *also* call `gtag('consent', 'update',
   { analytics_storage: 'denied' })` on their behalf? Probably yes — but we
   shouldn't override an explicit GA consent the host has set elsewhere.
   Need a "consent ownership" config to disambiguate.

## Phasing

| Phase | Scope | Estimate |
|---|---|---|
| 1 | `GoogleAnalyticsPlugin` Mode A — script loader, config, consent, typed `ga.event/setUserProperty/setUserId/pageView` API. | 3 days |
| 2 | Mode B (tandem) — IdentityBridge sharing visitor + session with AnalyticsPlugin. | 2 days |
| 3 | Mode C (forward) — EventBridge tap on tracker pipeline + filter/map config. | 2 days |
| 4 | `gaPresets` (privacyFirst, spaApp, brochureSite) + `enhancedMeasurement` config translation. | 1 day |
| 5 | Documentation: cookbook with the common setups, migration guide from raw gtag.js | 2 days |

Total: ~2 weeks for full coverage. Phase 1 alone is the right MVP.

## See also

- [`docs/Analytics.md`](./Analytics.md) — the standalone, self-hosted analytics
  plugin design. This GA plugin is designed to coexist with it (Mode B/C) or
  to stand alone (Mode A).
- [GA4 Consent Mode v2](https://developers.google.com/tag-platform/security/guides/consent)
- [GA4 Recommended Events](https://support.google.com/analytics/answer/9267735)
- [GA4 Enhanced Measurement](https://support.google.com/analytics/answer/9216061)
