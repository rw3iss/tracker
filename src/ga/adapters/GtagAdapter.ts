import type { ITransportAdapter } from './ITransportAdapter';
import type { GaConfigOptions, GaConsentState } from '../core/types';
import type { GaEventEnvelope } from '../core/EventMapper';

interface GtagAdapterOptions {
  /** Override the gtag.js script URL — useful when proxying GA through a CDN. */
  scriptSrc?: string;
  /** CSP nonce for the injected script tag. */
  nonce?:    string;
  /** Add `defer` to the script tag. Default: `true`. */
  defer?:    boolean;
  /** Skip script injection — useful when the host already loads gtag.js. */
  skipInject?: boolean;
  /** Timeout (ms) for the post-load readiness check. Default: 5000. */
  readinessTimeoutMs?: number;
  /**
   * Called once when readiness check resolves — either with `{ ok: true }`
   * after gtag.js initializes successfully and a hit is observed leaving
   * the page, or `{ ok: false, reason }` after the timeout if either of
   * those didn't happen. Hosts can use this to surface a clear status to
   * developers ("GA confirmed working" vs "GA blocked — DNT / tracking
   * protection / extension").
   */
  onReady?: (status: GtagReadyStatus) => void;
}

/** Outcome of the post-load readiness check. */
export interface GtagReadyStatus {
  /** True if gtag.js initialized AND we observed a hit leaving the page. */
  ok: boolean;
  /** When `ok: false`, a human-readable description of which signal failed. */
  reason?: string;
  /** Diagnostic detail useful in logs / dashboards. */
  detail?: {
    initObserved:   boolean;
    hitObserved:    boolean;
    elapsedMs:      number;
    dnt:            string | null | undefined;
    dataLayerLen:   number;
    measurementId:  string;
  };
}

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?:      (...args: unknown[]) => void;
    google_tag_manager?: Record<string, unknown>;
  }
}

const DEFAULT_GTAG_SRC = 'https://www.googletagmanager.com/gtag/js';

/**
 * Browser adapter — talks to GA via the standard `gtag.js` library.
 *
 * Lifecycle:
 * 1. Constructor: synchronously sets up `window.dataLayer` + a `gtag`
 *    queue stub so calls made before `init()` (e.g. consent defaults from
 *    `GaCore`'s ConsentManager subscription) land in the queue rather than
 *    being dropped.
 * 2. `init(ids, config)` injects the gtag.js script tag (idempotent across
 *    instances) and pushes the canonical `js` + `config` calls. After the
 *    script loads, a readiness watchdog confirms gtag.js fully wired up
 *    AND that a hit actually left the page within a configurable timeout.
 * 3. `send([events])` dispatches `gtag('event', name, params)` for every
 *    event × every measurement ID via `send_to` fanout.
 *
 * **Multi-ID:** one script, one set of listeners, one stream of events
 * fanned out via `send_to`. Adding measurement IDs is free.
 *
 * **Readiness signal:** {@link ready} resolves once gtag.js has fully
 * initialized AND a `g/collect` request has been observed leaving the
 * page (or after a 5s timeout, with `ok: false` and a diagnostic reason).
 * Hosts can `await adapter.ready()` to know whether GA is actually working
 * — critical because gtag.js silently fails to send events under several
 * common conditions (DNT, browser tracking protection, ad blockers,
 * extensions) without throwing or logging.
 */
export class GtagAdapter implements ITransportAdapter {
  readonly name = 'gtag';

  private measurementIds: string[] = [];
  private installed = false;
  private scriptInjected = false;
  /** Resolved when gtag.js's `<script>` finishes loading (or fails). */
  private scriptLoaded: Promise<void> = Promise.resolve();
  /** Resolved when readiness watchdog finishes — see {@link ready}. */
  private readyPromise: Promise<GtagReadyStatus>;
  private resolveReady!: (status: GtagReadyStatus) => void;
  private observer: PerformanceObserver | null = null;

  /**
   * Set up `window.dataLayer` + the `gtag` stub *eagerly* at construction
   * time so any caller — including `GaCore`'s synchronous consent-default
   * replay during `new GaCore(...)` — can call `consent()` / `config()` /
   * `send()` and have those calls land in the queue before `gtag.js` even
   * loads. Mirrors the canonical Google install snippet which sets up the
   * queue synchronously and async-loads the script.
   */
  constructor(private readonly opts: GtagAdapterOptions = {}) {
    this.readyPromise = new Promise(resolve => { this.resolveReady = resolve; });

    if (typeof window === 'undefined') {
      // Server-side or test env without DOM — readiness is irrelevant.
      this.resolveReady({ ok: true });
      return;
    }
    if (!Array.isArray(window.dataLayer)) window.dataLayer = [];
    if (typeof window.gtag !== 'function') {
      window.gtag = function gtag(...args: unknown[]): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window.dataLayer as unknown[]).push(args as any);
      };
    }

    // Pre-init DNT warning — most common silent killer of gtag init.
    this.warnIfDoNotTrack();
  }

  async init(measurementIds: string[], config: GaConfigOptions): Promise<void> {
    if (typeof window === 'undefined') {
      this.resolveReady({ ok: true });
      return;
    }
    this.measurementIds = [...measurementIds];

    // Inject the script once across instances.
    if (!this.scriptInjected && !this.opts.skipInject) {
      const firstId = measurementIds[0];
      if (!firstId) {
        this.resolveReady({ ok: false, reason: 'no measurementIds configured' });
        return;
      }
      const src = `${this.opts.scriptSrc ?? DEFAULT_GTAG_SRC}?id=${encodeURIComponent(firstId)}`;
      this.scriptLoaded = injectScript(src, this.opts.nonce, this.opts.defer ?? true);
      this.scriptInjected = true;
    } else if (this.opts.skipInject) {
      // Host claims gtag is already loaded — skip readiness check, trust them.
      this.resolveReady({ ok: true });
    }

    // Time-of-init queue: js + config calls. (Consent calls already landed
    // in the queue when `GaCore`'s ConsentManager subscribed at construction
    // time — gtag.js drains them in order when it loads.)
    this.gtag('js', new Date());
    for (const id of measurementIds) {
      this.gtag('config', id, { ...config });
    }
    this.installed = true;

    // Kick off the watchdog. Don't await — `init` should return promptly so
    // the host can continue. Result is observable via `ready()`.
    if (!this.opts.skipInject) {
      void this.scheduleReadinessCheck(measurementIds[0] ?? '');
    }
  }

  config(measurementId: string, opts: GaConfigOptions): void {
    if (!this.installed) return;
    this.gtag('config', measurementId, opts);
  }

  consent(op: 'default' | 'update', state: GaConsentState): void {
    this.gtag('consent', op, state);
  }

  send(events: GaEventEnvelope[]): void {
    if (!this.installed) return;
    for (const event of events) {
      this.gtag('event', event.name, {
        ...event.params,
        send_to: this.measurementIds.length === 1 ? this.measurementIds[0] : this.measurementIds,
      });
    }
  }

  destroy(): void {
    this.installed = false;
    this.observer?.disconnect();
    this.observer = null;
  }

  /**
   * Resolves once the post-load readiness watchdog completes.
   *
   * - `{ ok: true }` — gtag.js initialized AND at least one `g/collect`
   *   request was observed leaving the page within the timeout.
   * - `{ ok: false, reason, detail }` — one or both signals didn't happen
   *   within the timeout. Common causes:
   *   - **DNT enabled** (`navigator.doNotTrack === '1'`) — gtag.js refuses
   *     to send hits silently.
   *   - **Browser tracking protection** (Brave Shields, Firefox ETP,
   *     Chrome incognito Tracking Protection) — blocks the network
   *     request before it leaves.
   *   - **Ad blocker / privacy extension** (uBlock Origin, etc.) — drops
   *     the request at the JS API level (no entry in DevTools Network).
   *   - **System-level filter** (Pi-hole, NextDNS, AdGuard DNS) — DNS-
   *     resolves the GA domain to a sinkhole.
   *
   * @example
   * ```ts
   * const ga = new GoogleAnalyticsPlugin({ measurementIds: ['G-X'] });
   * await ga.ready();        // returns adapter.ready() under the hood
   * ```
   */
  ready(): Promise<GtagReadyStatus> {
    return this.readyPromise;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Single point of contact with `window.gtag`. Silently no-ops if absent. */
  private gtag(...args: unknown[]): void {
    if (typeof window === 'undefined') return;
    try { window.gtag?.(...args); }
    catch { /* swallow — never break the host */ }
  }

  /**
   * Watchdog that confirms gtag.js actually wired up *and* that a hit left
   * the page. Two signals are tracked in parallel:
   *
   * - **Init signal** — `window.google_tag_manager[measurementId]` is set
   *   by gtag.js once it finishes registering the property.
   * - **Hit signal** — `PerformanceObserver` for `resource` entries with
   *   names containing `google-analytics.com/g/collect` (or proxies of
   *   it). If we see any, gtag is actually sending.
   *
   * Resolves `ok: true` when both are detected. Resolves `ok: false` with
   * a specific reason at timeout. Calls `opts.onReady` if configured.
   */
  private scheduleReadinessCheck(measurementId: string): void {
    if (typeof window === 'undefined') {
      this.resolveReady({ ok: true });
      return;
    }
    const start = Date.now();
    const timeoutMs = this.opts.readinessTimeoutMs ?? 5_000;

    let initObserved = false;
    let hitObserved  = false;

    // Hit observer — non-invasive, watches resource timing entries.
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        this.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (isCollectUrl(entry.name)) {
              hitObserved = true;
              return;
            }
          }
        });
        this.observer.observe({ type: 'resource', buffered: true });
      } catch { /* swallow */ }
    }

    const finish = (status: GtagReadyStatus): void => {
      this.observer?.disconnect();
      this.observer = null;
      this.resolveReady(status);
      try { this.opts.onReady?.(status); }
      catch { /* swallow */ }
      if (!status.ok && typeof console !== 'undefined') {
        try {
          console.warn(`[@rw3iss/tracker/ga] ${status.reason}`, status.detail);
        } catch { /* swallow */ }
      }
    };

    const tick = (): void => {
      if (window.google_tag_manager?.[measurementId]) initObserved = true;

      if (initObserved && hitObserved) {
        finish({
          ok: true,
          detail: { initObserved, hitObserved, elapsedMs: Date.now() - start,
                    dnt: (navigator as unknown as { doNotTrack?: string | null })?.doNotTrack ?? null,
                    dataLayerLen: window.dataLayer?.length ?? 0,
                    measurementId },
        });
        return;
      }

      const elapsedMs = Date.now() - start;
      if (elapsedMs > timeoutMs) {
        const reason = !initObserved
          ? `gtag.js loaded but did not initialize within ${timeoutMs}ms — most commonly caused by navigator.doNotTrack='1', browser tracking protection, or an extension. Check chrome://settings/privacy.`
          : `gtag.js initialized but no /g/collect requests left the page within ${timeoutMs}ms — most commonly caused by an ad blocker (uBlock, AdBlock, Privacy Badger), Brave Shields, or system-level DNS filtering (Pi-hole, NextDNS).`;
        finish({
          ok: false,
          reason,
          detail: { initObserved, hitObserved, elapsedMs,
                    dnt: (navigator as unknown as { doNotTrack?: string | null })?.doNotTrack ?? null,
                    dataLayerLen: window.dataLayer?.length ?? 0,
                    measurementId },
        });
        return;
      }
      setTimeout(tick, 200);
    };

    // First tick — wait briefly for the script element to load.
    void this.scriptLoaded.catch(() => undefined);
    setTimeout(tick, 100);
  }

  /** DNT pre-init warning — fires from the constructor for visibility. */
  private warnIfDoNotTrack(): void {
    if (typeof navigator === 'undefined' || typeof console === 'undefined') return;
    const navAny = navigator as unknown as { doNotTrack?: string | null; msDoNotTrack?: string | null };
    const dnt = navAny.doNotTrack ?? navAny.msDoNotTrack;
    if (dnt === '1' || dnt === 'yes') {
      try {
        console.warn(
          '[@rw3iss/tracker/ga] navigator.doNotTrack is enabled — gtag.js ' +
          'typically loads but refuses to send events under DNT. To test GA ' +
          'locally: chrome://settings/privacy → "Send a Do Not Track request" → OFF, then restart Chrome.',
        );
      } catch { /* swallow */ }
    }
  }
}

/**
 * Inject a `<script>` tag. Resolves on `load`, rejects on `error`. If the
 * same `src` is already attached, resolves immediately.
 */
function injectScript(src: string, nonce: string | undefined, defer: boolean): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    if (defer) script.defer = true;
    if (nonce) script.nonce = nonce;
    script.addEventListener('load',  () => resolve());
    script.addEventListener('error', (err) => reject(err));
    document.head.appendChild(script);
  });
}

function isCollectUrl(url: string): boolean {
  return /\/g\/collect/.test(url) || /google-analytics\.com\/(j|r)\/collect/.test(url);
}
