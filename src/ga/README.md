# `@rw3iss/tracker/ga`

Browser-side Google Analytics 4 integration. One plugin, three modes, multi-ID support, typed `gtag` wrapper, Consent Mode v2 wiring, GTM adapter, batched forward queue, SPA page-view fix as a default.

For server-side GA via the Measurement Protocol, see the companion subpackage [`@rw3iss/tracker/ga/server`](#server-side-google-analyticstrackergaserver).

```typescript
import { TrackerClient } from '@rw3iss/tracker';
import { GoogleAnalyticsPlugin } from '@rw3iss/tracker/ga';

TrackerClient.init({
  endpoint: 'https://tracker.example.com/ingest/events',
  plugins: [
    new GoogleAnalyticsPlugin({
      measurementIds: ['G-XXXXXXXX'],
      mode:           'ga-only',
    }),
  ],
});
```

---

## Three modes

| Mode | When to pick | What runs | What's forwarded |
|---|---|---|---|
| `'ga-only'` | You want GA, period. AnalyticsPlugin is not in play. | gtag.js with auto-tracking | Nothing from the tracker pipeline — errors stay tracker-side |
| `'tandem'` | Want both backends. Useful during migration or for permanent dual-write. | Both AnalyticsPlugin and gtag.js auto-tracking | AnalyticsPlugin events also forwarded to GA so dashboards align |
| `'forward'` | AnalyticsPlugin is canonical; GA is a downstream dashboard. | AnalyticsPlugin only — gtag's auto page-view is auto-disabled | AnalyticsPlugin events forwarded to GA via `gtag('event', ...)`, batched |

Mode is set via the `mode:` config option.

---

## Configuration — `GoogleAnalyticsPluginOptions`

```typescript
new GoogleAnalyticsPlugin({
  // ── Required ─────────────────────────────────────────────────────────
  measurementIds: ['G-XXXXXXXX'],     // one or many — fanned out via gtag's send_to
  mode:           'ga-only',          // 'ga-only' | 'tandem' | 'forward'

  // ── Loader ───────────────────────────────────────────────────────────
  loader:    'gtag',                  // 'gtag' (default) | 'gtm' | 'manual'
  scriptSrc: undefined,               // override the gtag.js URL (proxying)
  nonce:     undefined,               // CSP nonce
  defer:     true,
  skipInject: false,                  // don't inject the script — host already loaded gtag.js
  dataLayerName: 'dataLayer',         // GTM-only

  // ── Initial gtag('config', id, ...) ──────────────────────────────────
  config: {
    debug_mode:       process.env.NODE_ENV !== 'production',
    send_page_view:   true,           // auto-set to `false` in 'forward' mode
    cookie_domain:    'auto',         // | host | '<domain>'
    cookie_flags:     'SameSite=None;Secure',
    cookie_expires:   63072000,       // seconds (default: 2 years)
    anonymize_ip:     true,
    allow_google_signals:               true,
    allow_ad_personalization_signals:   true,
    user_properties: { plan_tier: 'pro' },
    // GA4 accepts arbitrary extra fields — pass through unchanged
  },

  // ── Identity sharing ─────────────────────────────────────────────────
  identitySource: analyticsPlugin,    // pass an AnalyticsPlugin instance — its
                                      // client_id/session_id/user_id are
                                      // automatically synced to GA
                                      // (works in 'tandem' and 'forward' modes)

  // ── Consent (GA Consent Mode v2) ─────────────────────────────────────
  consent: {
    defaults: {                       // gtag('consent', 'default', { ... })
      analytics_storage:    'denied', // 'granted' | 'denied'
      ad_storage:           'denied',
      ad_user_data:         'denied',
      ad_personalization:   'denied',
      personalization_storage: 'denied',
      functionality_storage:   'granted',
      security_storage:        'granted',
    },
    waitFor:           myCookieBanner.onAccept,  // Promise<GaConsentState>
    respectDoNotTrack: true,
  },
  respectDoNotTrack: true,

  // ── Forward mode rule (mode === 'forward') ───────────────────────────
  forward: {
    events: ['page_view', 'session_start', 'view_item', 'add_to_cart', 'purchase'],
    // OR a predicate (mutually exclusive):
    filter:    (event) => event.category === 'analytics' || event.category === 'ecommerce',
    mapName:   (msg) => msg,                       // identity by default
    mapParams: (event) => ({ ...event.payload }),  // passthrough by default
  },

  // ── Forward batching (mode === 'forward') ────────────────────────────
  batching: {
    strategy:       'size-or-time',   // 'immediate' | 'size-or-time' | 'time'
    batchSize:      10,               // flush when this many events queued
    batchTimeoutMs: 5_000,            // OR this many ms since the first queued
    maxSize:        1_000,            // hard cap; oldest items dropped beyond
  },

  // ── Enhanced measurement (translates to gtag config) ─────────────────
  enhancedMeasurement: {
    pageViews:        true,
    scrolls:          true,
    outboundClicks:   true,
    siteSearch:       true,
    videoEngagement:  false,
    fileDownloads:    true,
    formInteractions: true,
  },
});
```

### Possible values reference

| Field | Possible values |
|---|---|
| `mode` | `'ga-only'` \| `'tandem'` \| `'forward'` |
| `loader` | `'gtag'` \| `'gtm'` \| `'manual'` |
| `consent.defaults.*_storage` | `'granted'` \| `'denied'` |
| `consent.defaults.*_user_data` | `'granted'` \| `'denied'` |
| `batching.strategy` | `'immediate'` \| `'size-or-time'` \| `'time'` |
| `config.cookie_flags` | A semicolon-joined string — `'SameSite=Lax'`, `'SameSite=None;Secure'`, `'Max-Age=600'`, ... |
| `config.cookie_domain` | `'auto'` \| `'<domain>'` (any string) |

---

## Public API

After `TrackerClient.init({ plugins: [ga] })`, the plugin's runtime API:

### Core methods

```typescript
// Custom event — same shape as gtag('event', ...) but typed
ga.event('add_to_cart', { value: 1200, currency: 'USD', items: [...] });

// Programmatic page view (typical fix for GA's broken SPA auto-pageview)
ga.pageView({ page_path: '/auctions/42', page_title: 'Spring Auction' });

// Forward queue (mode === 'forward')
await ga.flush();

// Master switch — sets window['ga-disable-MEASUREMENT_ID']
ga.disable();
ga.enable();
```

### Convenience methods (typed wrappers over `event()`)

```typescript
// CTA click — `cta_click` event with stable id
ga.cta('hero-signup', { variant: 'A', section: 'hero' });

// Standard GA4 events with typed params:
ga.login('email');                                          // 'login' event
ga.signUp('google');                                        // 'sign_up' event
ga.share({ method: 'twitter', content_type: 'article' });   // 'share' event
ga.search('vintage watch');                                 // 'search' event
ga.selectContent({ content_type: 'product', item_id: 'sku-42' });
```

### Identity + consent

```typescript
// User properties / custom dimensions
ga.setUserProperty('plan_tier', 'pro');

// Identify / sign out
ga.setUserId('u_123');
ga.clearUserId();

// Runtime config update — fans out across every measurement ID
ga.updateConfig({ send_page_view: false, debug_mode: true });

// Consent
ga.setConsent({ analytics_storage: 'granted', ad_storage: 'granted' });

// Identity snapshot (debug)
ga.getIdentity();   // { clientId?, sessionId?, userId? }
```

### Readiness watchdog

```typescript
// Resolves once gtag.js is fully loaded AND a /g/collect hit was observed,
// or rejects with a specific reason at the timeout. Surfaces silent failures
// (DNT, tracking protection, ad blockers) that gtag itself doesn't log.
const status = await ga.ready();
if (!status.ok) console.warn(`GA blocked: ${status.reason}`);
```

### Auto CTA tracking — global click delegator

Authors opt a button into tracking by adding a `data-cta-id` attribute (or `data-cta`). One delegated listener at the document root catches every click — works with any framework, no per-component wiring needed.

```typescript
// Default — track elements with data-cta-id or data-cta:
ga.installAutoTracking();

// Or track ALL buttons + links, fall back to id → text → class:
ga.installAutoTracking({
  selector: 'button, a',
  fallback: ['id', 'text', 'class'],
});

// HTML side:
//   <button data-cta-id="hero-signup">Sign up</button>
//   <a href="/pricing" data-cta-id="footer-pricing" data-cta-section="footer">Pricing</a>
```

Captured payload:

```json
{
  "cta_id":      "hero-signup",
  "cta_text":    "Sign up",
  "cta_tag":     "button",
  "cta_section": "footer",   // from data-cta-section="footer"
  "cta_href":    "/pricing", // anchors only
  "page_path":   "/"
}
```

All `data-*` attributes (except `data-cta-id` / `data-cta`) flow through to the GA payload as snake_case keys, so `data-cta-variant="B"` becomes `cta_variant: "B"` in the event params. Useful for A/B test labels, section names, list positions.

See [Framework integration](#framework-integration) for `installAutoTracking()` examples in React, Vue, Solid, etc.

---

## Framework integration

`@rw3iss/tracker/ga` is framework-agnostic — `GoogleAnalyticsPlugin` is just a class. The two integration touchpoints are:

1. **Init** — call `TrackerClient.init({ plugins: [ga] })` once per page load.
2. **SPA navigation** — fire `ga.pageView()` on every route change (GA does NOT auto-track SPA navigations — only initial page load + full document reloads).

For `cta_click` events, either install `ga.installAutoTracking()` once and add `data-cta-id` attributes, or call `ga.cta(id, data?)` from event handlers.

<details open>
<summary><strong>Astro</strong></summary>

```typescript
// src/lib/tracker.ts
import { TrackerClient } from '@rw3iss/tracker';
import { GoogleAnalyticsPlugin } from '@rw3iss/tracker/ga';

const ga = new GoogleAnalyticsPlugin({ measurementIds: ['G-XXXXXXXX'] });
TrackerClient.init({ endpoint: '...', plugins: [ga] });
ga.installAutoTracking();   // [data-cta-id] elements site-wide

// SPA navigation — Astro fires `astro:page-load` after every transition:
document.addEventListener('astro:page-load', () => {
  ga.pageView({
    page_path:     location.pathname + location.search,
    page_title:    document.title,
    page_location: location.href,
  });
});

// Then in any .astro file:
//   <button data-cta-id="hero-signup" data-cta-variant="A">Sign up</button>
```

Wire this from a `<script>` tag inside your `BaseLayout.astro`. Astro keeps the document alive across `<ClientRouter />` transitions, so init runs once per actual page load.

</details>

<details open>
<summary><strong>React (with React Router v6)</strong></summary>

```typescript
// src/tracker.ts — module-load init (runs once)
import { TrackerClient } from '@rw3iss/tracker';
import { GoogleAnalyticsPlugin } from '@rw3iss/tracker/ga';

export const ga = new GoogleAnalyticsPlugin({ measurementIds: ['G-XXXXXXXX'] });
TrackerClient.init({ endpoint: '...', plugins: [ga] });
ga.installAutoTracking();
```

```tsx
// src/App.tsx — fire pageView on route change
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ga } from './tracker';

function GaRouteTracker() {
  const location = useLocation();
  useEffect(() => {
    ga.pageView({ page_path: location.pathname + location.search });
  }, [location.pathname, location.search]);
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <GaRouteTracker />
      <Routes>{/* ... */}</Routes>
    </BrowserRouter>
  );
}

// In any component:
//   <button data-cta-id="hero-signup" onClick={...}>Sign up</button>
// or fire explicitly:
//   <button onClick={() => ga.cta('hero-signup', { variant: 'A' })}>Sign up</button>
```

</details>

<details>
<summary><strong>Next.js (App Router)</strong></summary>

```tsx
// app/_components/Tracker.tsx
'use client';
import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { TrackerClient } from '@rw3iss/tracker';
import { GoogleAnalyticsPlugin } from '@rw3iss/tracker/ga';

const ga = new GoogleAnalyticsPlugin({ measurementIds: ['G-XXXXXXXX'] });
TrackerClient.init({ endpoint: '...', plugins: [ga] });
ga.installAutoTracking();

export function Tracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  useEffect(() => {
    ga.pageView({ page_path: `${pathname}?${searchParams}` });
  }, [pathname, searchParams]);
  return null;
}
```

```tsx
// app/layout.tsx
import { Tracker } from './_components/Tracker';
export default function RootLayout({ children }) {
  return (
    <html><body>
      <Tracker />
      {children}
    </body></html>
  );
}
```

</details>

<details>
<summary><strong>Next.js (Pages Router)</strong></summary>

```tsx
// pages/_app.tsx
import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { TrackerClient } from '@rw3iss/tracker';
import { GoogleAnalyticsPlugin } from '@rw3iss/tracker/ga';

const ga = new GoogleAnalyticsPlugin({ measurementIds: ['G-XXXXXXXX'] });
if (typeof window !== 'undefined') {
  TrackerClient.init({ endpoint: '...', plugins: [ga] });
  ga.installAutoTracking();
}

export default function App({ Component, pageProps }) {
  const router = useRouter();
  useEffect(() => {
    const onChange = (url: string) => ga.pageView({ page_path: url });
    router.events.on('routeChangeComplete', onChange);
    return () => router.events.off('routeChangeComplete', onChange);
  }, [router]);
  return <Component {...pageProps} />;
}
```

</details>

<details>
<summary><strong>Vue 3 (with Vue Router)</strong></summary>

```typescript
// src/main.ts
import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { TrackerClient } from '@rw3iss/tracker';
import { GoogleAnalyticsPlugin } from '@rw3iss/tracker/ga';
import App from './App.vue';

const ga = new GoogleAnalyticsPlugin({ measurementIds: ['G-XXXXXXXX'] });
TrackerClient.init({ endpoint: '...', plugins: [ga] });
ga.installAutoTracking();

const router = createRouter({ history: createWebHistory(), routes: [/* ... */] });

router.afterEach((to) => {
  ga.pageView({ page_path: to.fullPath });
});

createApp(App).use(router).mount('#app');

// Then in any .vue template:
//   <button data-cta-id="hero-signup">Sign up</button>
```

</details>

<details>
<summary><strong>Solid (with @solidjs/router)</strong></summary>

```tsx
// src/index.tsx
import { render } from 'solid-js/web';
import { Router, useLocation } from '@solidjs/router';
import { createEffect } from 'solid-js';
import { TrackerClient } from '@rw3iss/tracker';
import { GoogleAnalyticsPlugin } from '@rw3iss/tracker/ga';

const ga = new GoogleAnalyticsPlugin({ measurementIds: ['G-XXXXXXXX'] });
TrackerClient.init({ endpoint: '...', plugins: [ga] });
ga.installAutoTracking();

function GaRouteTracker() {
  const location = useLocation();
  createEffect(() => {
    ga.pageView({ page_path: location.pathname + location.search });
  });
  return null;
}

render(() => (
  <Router>
    <GaRouteTracker />
    {/* routes */}
  </Router>
), document.getElementById('root')!);
```

</details>

<details>
<summary><strong>Svelte / SvelteKit</strong></summary>

```typescript
// src/routes/+layout.svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { afterNavigate } from '$app/navigation';
  import { TrackerClient } from '@rw3iss/tracker';
  import { GoogleAnalyticsPlugin } from '@rw3iss/tracker/ga';

  let ga: GoogleAnalyticsPlugin;
  onMount(() => {
    ga = new GoogleAnalyticsPlugin({ measurementIds: ['G-XXXXXXXX'] });
    TrackerClient.init({ endpoint: '...', plugins: [ga] });
    ga.installAutoTracking();
  });

  afterNavigate(() => {
    ga?.pageView({ page_path: $page.url.pathname + $page.url.search });
  });
</script>

<slot />

<!-- In any .svelte file:
     <button data-cta-id="hero-signup">Sign up</button> -->
```

</details>

<details>
<summary><strong>Vanilla JS / no framework</strong></summary>

```html
<!-- in your <head> or before </body> -->
<script type="module">
  import { TrackerClient } from 'https://esm.sh/@rw3iss/tracker';
  import { GoogleAnalyticsPlugin } from 'https://esm.sh/@rw3iss/tracker/ga';

  const ga = new GoogleAnalyticsPlugin({ measurementIds: ['G-XXXXXXXX'] });
  TrackerClient.init({ endpoint: 'https://tracker.example.com/ingest/events', plugins: [ga] });
  ga.installAutoTracking();
  window.ga = ga;   // optional — for console access

  // For full page-reload sites (no SPA), GA's auto page_view handles
  // navigation. For pushState-driven sites, listen for popstate + patch
  // history yourself, or fire ga.pageView() at the right moments.
</script>

<!-- Then anywhere on the page: -->
<button data-cta-id="hero-signup" data-cta-variant="A">Sign up</button>
<a href="/pricing" data-cta-id="footer-pricing">Pricing</a>
```

</details>

## Presets

```typescript
import { GoogleAnalyticsPlugin, gaPresets } from '@rw3iss/tracker/ga';

new GoogleAnalyticsPlugin({
  measurementIds: ['G-XXX'],
  ...gaPresets.privacyFirst,    // GDPR-safe defaults: deny consent, anonymize_ip, respect DNT
  ...gaPresets.spaApp,          // disable GA's auto pageview, use mode:'forward'
});
```

| Preset | What it sets |
|---|---|
| `gaPresets.privacyFirst` | Denied-by-default consent (analytics + ad), `anonymize_ip: true`, `respectDoNotTrack: true` |
| `gaPresets.spaApp` | `mode: 'forward'`, `send_page_view: false`, all enhanced-measurement OFF (the AnalyticsPlugin or your router calls `ga.pageView()`) |
| `gaPresets.brochureSite` | `mode: 'ga-only'`, all enhanced-measurement ON — GA out of the box |

---

## Multi-ID strategy

Multiple measurement IDs are passed as an array:

```typescript
new GoogleAnalyticsPlugin({
  measurementIds: ['G-PRIMARY', 'G-AGENCY', 'G-INTERNAL'],
});
```

The adapter loads gtag.js exactly **once** and uses GA's `send_to: [...]` parameter to fan every event out to all configured IDs in a single call. No duplicate listeners, no double-counted events, no per-ID lag. Adding more IDs costs zero extra CPU/network on the client.

---

## Loaders

- **`'gtag'`** (default) — standard `https://www.googletagmanager.com/gtag/js`. Use measurement IDs (`G-XXXX`).
- **`'gtm'`** — Google Tag Manager dataLayer. Use container IDs (`GTM-XXXX`). Useful when an existing GTM workspace defines tags and triggers.
- **`'manual'`** — host already loaded gtag.js or GTM; this plugin just pushes config + events. Equivalent to `loader: 'gtag', skipInject: true`.

The adapter abstraction (`ITransportAdapter`) makes adding new loaders straightforward — see `src/ga/adapters/`.

---

## Forward batching

In `'forward'` mode, every captured tracker event passes through the
`EventMapper` (filter + name/param mapping) and lands in a `BatchQueue`. The
queue triggers `gtag('event', ...)` calls based on the configured strategy:

- `'immediate'` — every event fires `gtag('event', ...)` immediately. Lowest latency, highest call volume. Use for low-traffic sites or when ordering must be preserved at all costs.
- `'size-or-time'` (default) — flush when queue size hits `batchSize` OR `batchTimeoutMs` elapses since the first queued item. Coalesces bursts.
- `'time'` — flush every `batchTimeoutMs` regardless of queue size.

The plugin also installs a `pagehide` listener that synchronously drains the
queue before navigation, so events queued just before a page transition still
land. `flushNow()` is the synchronous escape hatch (intended for `pagehide`,
also exposed publicly).

---

## Server-side — `@rw3iss/tracker/ga/server`

Companion plugin for `tracker-server` (or your own consumer). Sends events to GA via the [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4). Useful for:

- Server-originating events (webhooks, batch jobs, backend conversions)
- Hardening against ad-blockers (call originates from your server, not the browser)
- Native-app backends or non-DOM environments

```typescript
import { TrackerModule } from '@rw3iss/tracker/consumer';
import { GoogleAnalyticsServerPlugin } from '@rw3iss/tracker/ga/server';

TrackerModule.register({
  plugins: [
    new GoogleAnalyticsServerPlugin({
      measurementIds: ['G-XXXXXXXX'],
      apiSecret:      process.env.GA_MP_API_SECRET,
      forward: {
        events: ['purchase', 'refund', 'sign_up'],   // server-only conversions
      },
      batching: { batchSize: 25 },                  // GA cap is 25 events / payload
    }),
  ],
});
```

The server plugin shares the same core (`GaCore`, `EventMapper`, `BatchQueue`, `ConsentManager`) as the browser plugin — only the transport adapter differs (`MeasurementProtocolAdapter` vs `GtagAdapter`/`GtmAdapter`).

### `GoogleAnalyticsServerPluginOptions`

```typescript
new GoogleAnalyticsServerPlugin({
  measurementIds: ['G-XXX'],
  apiSecret:      'YOUR_MP_API_SECRET',  // GA admin → Data Streams → Measurement Protocol API secrets
  mode:           'forward',              // 'forward' | 'ga-only' (server ga-only is a no-op)
  debug:          false,                  // POST to /debug/mp/collect for testing
  fetch:          undefined,              // override fetch (useful for axios wrappers, signing, logging)
  forward:        { events: [...], filter: ..., mapName: ..., mapParams: ... },
  batching:       { strategy: 'size-or-time', batchSize: 25, batchTimeoutMs: 5_000 },
  config:         { user_properties: { ... } },
  consent:        { defaults: {...}, waitFor: Promise<...> },
  adapter:        undefined,              // inject custom ITransportAdapter (testing)
});
```

---

## Architecture

```
GoogleAnalyticsPlugin (browser)         GoogleAnalyticsServerPlugin (server)
        ↓                                          ↓
        └────────────── GaCore ───────────────────┘   (shared orchestrator)
                ├── ConsentManager      (Consent Mode v2 state machine)
                ├── IdentityManager     (client_id / session_id / user_id sync)
                ├── EventMapper         (TrackerEvent → GA event + filter + remap)
                └── BatchQueue          (size + time + manual flush)
                          ↓
                ITransportAdapter
                ├── GtagAdapter                  (browser, gtag.js)
                ├── GtmAdapter                   (browser, GTM dataLayer)
                └── MeasurementProtocolAdapter   (server, HTTP POST to /mp/collect)
```

Adapters are stateless from the orchestrator's perspective. Adding a new transport (e.g. server-side GTM, custom logging) is a new adapter file plus a constructor argument — no changes elsewhere.

---

## Privacy + compliance

- **GA Consent Mode v2** is wired by default. With `respectDoNotTrack: true` the consent defaults override to deny analytics + ad storage when DNT is set, and `update` is gated on explicit grant.
- **Server-side proxying** is supported for GA via `scriptSrc` override. First-party cookies, ad-blocker bypass.
- **`anonymize_ip`** is exposed as a config option.
- **Forward mode + AnalyticsPlugin's consent gate** compose naturally: the tracker pipeline blocks events upstream, so nothing reaches the GA queue if consent is denied.

The plugin can't replace your cookie banner or privacy policy — it just makes them easy to wire up correctly.
