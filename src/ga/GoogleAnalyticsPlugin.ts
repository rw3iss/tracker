import type { ITrackerClientPlugin, ITrackerClientRef } from '../emitter/ITrackerClientPlugin';
import type { TrackerEvent } from '../common/types';
import { GaCore, type GaCoreOptions } from './core/GaCore';
import { GtagAdapter, type GtagReadyStatus } from './adapters/GtagAdapter';
import { GtmAdapter } from './adapters/GtmAdapter';
import type { ITransportAdapter } from './adapters/ITransportAdapter';
import { AutoCtaTracker, type AutoCtaTrackerOptions } from './AutoCtaTracker';
import type { IIdentitySource, IdentitySnapshot } from './core/IdentityManager';
import type { GaConfigOptions, GaConsentState, ForwardMode } from './core/types';

/** Loader strategy for the GA library script. */
export type LoaderKind = 'gtag' | 'gtm' | 'manual';

/** Top-level options for the browser-side `GoogleAnalyticsPlugin`. */
export interface GoogleAnalyticsPluginOptions extends Omit<GaCoreOptions, 'identitySource'> {
  /**
   * Loader to use:
   *
   * - `'gtag'` (default) — standard GA4 via `gtag.js`. Use measurement IDs (`G-XXXX`).
   * - `'gtm'` — Google Tag Manager dataLayer. Use container IDs (`GTM-XXXX`).
   * - `'manual'` — assume the host has already loaded the GA library; this
   *   plugin only pushes config + events.
   */
  loader?: LoaderKind;
  /** Override the loader script src — useful for proxying. */
  scriptSrc?: string;
  /** CSP nonce for the injected script. */
  nonce?:     string;
  /** Add `defer` attribute to the script tag. Default: `true`. */
  defer?:     boolean;
  /** Skip script injection — when set to `true`, equivalent to `loader: 'manual'`. */
  skipInject?: boolean;
  /** GTM dataLayer name. Default: `'dataLayer'`. Only used when `loader: 'gtm'`. */
  dataLayerName?: string;
  /**
   * Optional identity source — if provided, GA `client_id`/`session_id`/
   * `user_id` will be synced from it. When `AnalyticsPlugin` is also wired
   * in, you can pass it directly here for tandem/forward identity sharing.
   */
  identitySource?: IIdentitySource;
}

/**
 * Browser-side GA integration. Implements `ITrackerClientPlugin` so it slots
 * into `TrackerClient.init({ plugins: [...] })` alongside the rest of the
 * tracker pipeline.
 *
 * @example
 * ```typescript
 * import { TrackerClient } from '@rw3iss/tracker';
 * import { GoogleAnalyticsPlugin, gaPresets } from '@rw3iss/tracker/ga';
 *
 * TrackerClient.init({
 *   endpoint: 'https://tracker.example.com/ingest/events',
 *   plugins: [
 *     new GoogleAnalyticsPlugin({
 *       measurementIds: ['G-XXXXXXXX'],
 *       mode:           'ga-only',
 *       ...gaPresets.privacyFirst,
 *     }),
 *   ],
 * });
 * ```
 */
export class GoogleAnalyticsPlugin implements ITrackerClientPlugin {
  static readonly PLUGIN_NAME = 'GoogleAnalyticsPlugin';
  readonly name = GoogleAnalyticsPlugin.PLUGIN_NAME;

  private readonly core: GaCore;
  private readonly mode: ForwardMode;
  private clientRef: ITrackerClientRef | null = null;
  /** Active delegator from `installAutoTracking()`, or null. */
  private autoTracker: AutoCtaTracker | null = null;

  /** Page-hide listener — drains the forward-mode batch queue before the page closes. */
  private pageHideListener: (() => void) | null = null;

  constructor(private readonly opts: GoogleAnalyticsPluginOptions) {
    if (opts.skipInject) opts.loader = 'manual';
    const loader = opts.loader ?? 'gtag';
    const adapter = makeAdapter(loader, opts);
    this.mode = opts.mode;

    this.core = new GaCore(adapter, {
      measurementIds:     opts.measurementIds,
      mode:               opts.mode,
      config:             opts.config,
      consent:            opts.consent,
      forward:            opts.forward,
      batching:           opts.batching,
      enhancedMeasurement: opts.enhancedMeasurement,
      identitySource:     opts.identitySource,
      respectDoNotTrack:  opts.respectDoNotTrack,
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  //  ITrackerClientPlugin lifecycle
  // ──────────────────────────────────────────────────────────────────────

  async onInit(client: ITrackerClientRef): Promise<void> {
    this.clientRef = client;
    await this.core.init();

    // Register page-hide flusher — guarantees forward-mode batches deliver
    // before the page closes.
    if (typeof window !== 'undefined' && this.mode === 'forward') {
      const onHide = (): void => {
        this.core.flushNow();
      };
      this.pageHideListener = onHide;
      window.addEventListener('pagehide', onHide);
    }
  }

  /**
   * Synchronous transform — used in `'forward'` mode to fan events out to
   * GA. We intentionally don't mutate the event so the tracker pipeline is
   * unaffected.
   */
  onCapture(event: TrackerEvent): TrackerEvent {
    if (this.mode === 'forward' || this.mode === 'tandem') {
      // tandem mode also forwards — gives GA the events from AnalyticsPlugin
      // (page_view, session_start, etc.) so GA's dashboards reflect them.
      // GA's own auto-tracking isn't disabled in tandem; users opt in to
      // tandem because they want both data sources.
      try { this.core.forwardEvent(event); }
      catch { /* never break the host */ }
    }
    return event;
  }

  onDestroy(): void {
    if (this.pageHideListener && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.pageHideListener);
    }
    this.pageHideListener = null;
    this.autoTracker?.uninstall();
    this.autoTracker = null;
    void this.core.flush();
    this.core.destroy();
    this.clientRef = null;
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Send a custom event directly to GA via the loader. Bypasses the tracker
   * pipeline — useful for events you only want in GA, not in the consumer.
   *
   * @param name    GA event name. The GA4 recommended-events catalog is
   *                preferred (`'add_to_cart'`, `'purchase'`, `'login'`, …)
   *                but any string is accepted.
   * @param params  Event parameters. GA enforces a 25-key limit per event.
   */
  event(name: string, params: Record<string, unknown> = {}): void {
    this.core.sendDirect({ name, params });
  }

  /** Push a runtime config update across every measurement ID. */
  updateConfig(opts: GaConfigOptions): void {
    this.core.updateConfig(opts);
  }

  /** Set a user-property — bumps `gtag('set', 'user_properties', { ... })`. */
  setUserProperty(name: string, value: string | number | boolean | null): void {
    this.core.updateConfig({ user_properties: { [name]: value } });
  }

  /** Identify the current user. Sends `gtag('config', id, { user_id })`. */
  setUserId(userId: string): void {
    this.core.updateConfig({ user_id: userId });
  }

  /** Forget the current user. */
  clearUserId(): void {
    this.core.updateConfig({ user_id: undefined });
  }

  /** Imperatively update consent — `gtag('consent', 'update', state)`. */
  setConsent(state: GaConsentState): void {
    this.core.setConsent(state);
  }

  /**
   * Manually emit a `page_view` — the typical replacement for GA's
   * disabled-by-default auto page view in SPAs.
   */
  pageView(params: { page_path?: string; page_location?: string; page_title?: string } = {}): void {
    this.core.sendDirect({
      name: 'page_view',
      params: {
        page_location: params.page_location ?? (typeof location !== 'undefined' ? location.href : undefined),
        page_path:     params.page_path     ?? (typeof location !== 'undefined' ? location.pathname + location.search : undefined),
        page_title:    params.page_title    ?? (typeof document !== 'undefined' ? document.title : undefined),
      },
    });
  }

  /** Drain the forward batch queue (pending events) immediately. */
  async flush(): Promise<void> {
    return this.core.flush();
  }

  /**
   * Disable GA — sets the `window['ga-disable-MEASUREMENT_ID']` flag for
   * every configured ID. After this, gtag.js silently no-ops. Use when a
   * user revokes consent and you want to ensure even queued events stop
   * shipping.
   */
  disable(): void {
    if (typeof window === 'undefined') return;
    for (const id of this.opts.measurementIds) {
      (window as unknown as Record<string, boolean>)[`ga-disable-${id}`] = true;
    }
  }

  /** Re-enable GA after `disable()`. */
  enable(): void {
    if (typeof window === 'undefined') return;
    for (const id of this.opts.measurementIds) {
      (window as unknown as Record<string, boolean>)[`ga-disable-${id}`] = false;
    }
  }

  /**
   * Get the current identity snapshot the plugin is using to stamp events.
   * Useful for debugging tandem/forward mode.
   */
  getIdentity(): IdentitySnapshot {
    return this.core.identity.get();
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Convenience methods — typed wrappers over `event()` for the most
  //  common GA4 patterns. All emit through `gtag('event', name, params)`.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Fire a CTA click event with a stable identifier.
   *
   * Equivalent to `event('cta_click', { cta_id: id, ...data })`. The
   * `cta_click` event name is custom (not in GA4's recommended list) but
   * shows up in GA Realtime + Events reports just like any custom event.
   *
   * @example
   * ```typescript
   * function onSignupClick() {
   *   ga.cta('hero-signup', { variant: 'A', section: 'hero' });
   * }
   * ```
   */
  cta(id: string, data?: Record<string, unknown>): void {
    this.event('cta_click', { cta_id: id, ...(data ?? {}) });
  }

  /**
   * Standard GA4 `login` event. Fires when a user signs in.
   * @param method Optional auth method — `'email'`, `'google'`, `'github'`, etc.
   */
  login(method?: string): void {
    this.event('login', method ? { method } : {});
  }

  /**
   * Standard GA4 `sign_up` event. Fires when a user creates an account.
   * @param method Optional signup method — `'email'`, `'google'`, etc.
   */
  signUp(method?: string): void {
    this.event('sign_up', method ? { method } : {});
  }

  /**
   * Standard GA4 `share` event. Fires when content is shared.
   */
  share(opts: { method?: string; content_type?: string; item_id?: string } = {}): void {
    this.event('share', opts);
  }

  /**
   * Standard GA4 `search` event. Fires when a user runs a search.
   * @param searchTerm The query string the user submitted.
   */
  search(searchTerm: string): void {
    this.event('search', { search_term: searchTerm });
  }

  /**
   * Standard GA4 `select_content` event. Fires when a user selects an
   * item from a list / grid / menu.
   */
  selectContent(opts: { content_type: string; item_id: string }): void {
    this.event('select_content', opts);
  }

  /**
   * Install a global click delegator that auto-emits `cta_click` events
   * for elements matching the configured selector. By default, picks up
   * elements with `data-cta-id` or `data-cta` attributes — authors opt
   * a button into tracking by adding one attribute, no JS required.
   *
   * Returns a cleanup function. Calling install again replaces the
   * existing tracker so re-configuration is safe.
   *
   * @example
   * ```typescript
   * // Default — track [data-cta-id] elements site-wide:
   * ga.installAutoTracking();
   *
   * // Track ALL buttons + links, fall back to id → text → class:
   * ga.installAutoTracking({
   *   selector: 'button, a',
   *   fallback: ['id', 'text', 'class'],
   * });
   *
   * // Track only buttons in a specific section, with custom enrichment:
   * ga.installAutoTracking({
   *   selector: '[data-track-area="checkout"] button',
   *   enrich: (el) => ({ checkout_step: el.closest('[data-step]')?.dataset.step }),
   * });
   * ```
   */
  installAutoTracking(opts: AutoCtaTrackerOptions = {}): () => void {
    if (typeof document === 'undefined') return () => undefined;
    if (this.autoTracker) this.autoTracker.uninstall();
    this.autoTracker = new AutoCtaTracker(
      (name, params) => this.event(name, params),
      opts,
    );
    this.autoTracker.install();
    return () => {
      this.autoTracker?.uninstall();
      this.autoTracker = null;
    };
  }

  /**
   * Resolves once the GA loader's post-load readiness watchdog completes.
   *
   * - `{ ok: true }` — gtag.js initialized AND a `g/collect` request was
   *   observed leaving the page within the configured timeout (default 5s).
   *   GA is genuinely working.
   * - `{ ok: false, reason, detail }` — one or both signals didn't happen.
   *   `reason` is a human-readable explanation pointing at the most common
   *   causes (DNT, browser tracking protection, ad blocker, DNS filter).
   *
   * For loaders that don't expose a readiness signal (`gtm`, `manual`),
   * this resolves immediately with `{ ok: true }`.
   *
   * Use this to surface a clear status to developers — gtag silently
   * fails to send events in many common dev environments without throwing
   * or logging anything itself.
   *
   * @example
   * ```typescript
   * const ga = new GoogleAnalyticsPlugin({ measurementIds: ['G-XXX'] });
   * TrackerClient.init({ endpoint: '...', plugins: [ga] });
   *
   * ga.ready().then(({ ok, reason }) => {
   *   if (!ok) console.warn(`GA blocked: ${reason}`);
   * });
   * ```
   */
  ready(): Promise<GtagReadyStatus> {
    type Adapter = { ready?: () => Promise<GtagReadyStatus> };
    const adapter = (this.core as unknown as { adapter: Adapter }).adapter;
    return adapter.ready?.() ?? Promise.resolve({ ok: true });
  }
}

/** Pick the right adapter based on `loader`. */
function makeAdapter(loader: LoaderKind, opts: GoogleAnalyticsPluginOptions): ITransportAdapter {
  switch (loader) {
    case 'gtm':
      return new GtmAdapter({
        scriptSrc:     opts.scriptSrc,
        nonce:         opts.nonce,
        skipInject:    false,
        dataLayerName: opts.dataLayerName,
      });
    case 'manual':
      return new GtagAdapter({
        scriptSrc: opts.scriptSrc,
        nonce:     opts.nonce,
        defer:     opts.defer,
        skipInject: true,   // host owns the script
      });
    case 'gtag':
    default:
      return new GtagAdapter({
        scriptSrc:  opts.scriptSrc,
        nonce:      opts.nonce,
        defer:      opts.defer,
        skipInject: opts.skipInject ?? false,
      });
  }
}
