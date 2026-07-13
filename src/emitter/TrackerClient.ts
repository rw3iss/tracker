import type { TrackerEvent, TrackerContext, EnricherFn, EventType } from '../common/types';
import { EVENT_SEVERITY } from '../common/types';
import type { ITrackerClientPlugin, ITrackerClientRef } from './ITrackerClientPlugin';
import type { ITrackerTransport } from './ITrackerTransport';
import type { NetworkCaptureConfig } from './network-capture';
import { TrackerQueue, type TrackerQueueOptions } from './TrackerQueue';
import { TrackerFlusher, type RetryOptions } from './TrackerFlusher';
import { IDBEventQueue } from './IDBEventQueue';
import { TabCoordinator } from './TabCoordinator';
import { registerAutoCapture, unregisterAutoCapture } from './auto-capture';
import { registerNetworkCapture, unregisterNetworkCapture } from './network-capture';
import { SessionManager } from './SessionManager';
import type { SessionLifecycleHooks, SessionManagerOptions } from './SessionManager';
import { RateLimiter } from './RateLimiter';
import type { RateLimitConfig, RateLimitEventType } from './RateLimiter';
import { serializeError, type ErrorEnrichmentMode } from './serialize-error';

const isBrowser = typeof window !== 'undefined';
const isNode    = typeof process !== 'undefined' && !!process.versions?.node;

/**
 * Configuration for Service Worker-based event delivery with Background Sync.
 *
 * When enabled, events are written to IndexedDB so the Service Worker can
 * read and deliver them even after the page closes.
 *
 * @see {@link TrackerConfig.serviceWorkerTransport}
 */
export interface ServiceWorkerTransportConfig {
  /**
   * URL of the tracker Service Worker to register.
   * Omit if you are calling `setupTrackerSync()` from your own SW instead.
   */
  swUrl?:   string;
  /** SW registration scope. Defaults to the directory of `swUrl`. */
  scope?:   string;
  /**
   * Background Sync tag name. Must match the `syncTag` passed to
   * `setupTrackerSync()` in your SW.
   * @defaultValue `'__vt_sync__'`
   */
  syncTag?: string;
}

/**
 * Callback that can inspect/transform an event before it is queued.
 * Return `null` to silently drop the event.
 *
 * @param event - The event to inspect/transform.
 * @returns The event (possibly modified) to queue, or `null` to drop it.
 *
 * @see {@link TrackerConfig.beforeSend}
 */
export type BeforeSendFn = (event: TrackerEvent) => TrackerEvent | null;

/**
 * Per-field toggles for the built-in browser-context enricher. Each flag
 * controls whether the corresponding {@link TrackerContext} field is
 * stamped on every event.
 *
 * Server-side (Node) the toggles are no-ops — the source globals (`window`,
 * `navigator`, `document`, `screen`) don't exist there.
 *
 * @see {@link TrackerConfig.contextEnrichment}
 * @see {@link TrackerContext}
 */
export interface ContextEnrichmentFields {
  /** `window.location.href` → `context.url`. */
  url?:        boolean;
  /** `window.location.pathname` → `context.path`. */
  path?:       boolean;
  /** `document.referrer` → `context.referrer` (only when non-empty). */
  referrer?:   boolean;
  /** `navigator.userAgent` → `context.userAgent`. */
  userAgent?:  boolean;
  /** `navigator.language` → `context.language`. */
  language?:   boolean;
  /** `Intl.DateTimeFormat().resolvedOptions().timeZone` → `context.timezone`. */
  timezone?:   boolean;
  /** `{ width: window.innerWidth, height: window.innerHeight }` → `context.viewport`. */
  viewport?:   boolean;
  /** `{ width: screen.width, height: screen.height }` → `context.screen`. */
  screen?:     boolean;
  /** `navigator.connection.effectiveType` → `context.connection` (only when available). */
  connection?: boolean;
}

/**
 * Accepted values for {@link TrackerConfig.contextEnrichment}.
 *
 * - `true` (default) — comfortable / standard set: url, path, userAgent,
 *   language, timezone, viewport. Triage-useful without being noisy.
 * - `false` — opt out of all browser-host stamping.
 * - `'full'` — every field, including `referrer`, `screen`, `connection`.
 * - `'minimal'` — `url` and `path` only. Useful for privacy-sensitive
 *   embedded contexts.
 * - object — per-field overrides on top of the standard set (so e.g.
 *   `{ userAgent: false }` keeps the rest of the standard set).
 */
export type ContextEnrichmentMode =
  | boolean
  | 'full'
  | 'minimal'
  | ContextEnrichmentFields;

const CONTEXT_ENRICHMENT_ALL_ON: Required<ContextEnrichmentFields> = {
  url:        true,
  path:       true,
  referrer:   true,
  userAgent:  true,
  language:   true,
  timezone:   true,
  viewport:   true,
  screen:     true,
  connection: true,
};

const CONTEXT_ENRICHMENT_ALL_OFF: Required<ContextEnrichmentFields> = {
  url:        false,
  path:       false,
  referrer:   false,
  userAgent:  false,
  language:   false,
  timezone:   false,
  viewport:   false,
  screen:     false,
  connection: false,
};

/** Standard / "comfortable" subset returned for `true` and used as the
 *  base for object overrides. Triage-useful fields without referrer /
 *  screen / connection (those flip on with `'full'`). */
const CONTEXT_ENRICHMENT_STANDARD: Required<ContextEnrichmentFields> = {
  url:        true,
  path:       true,
  referrer:   false,
  userAgent:  true,
  language:   true,
  timezone:   true,
  viewport:   true,
  screen:     false,
  connection: false,
};

/** Minimal — just enough to identify which page the event came from. */
const CONTEXT_ENRICHMENT_MINIMAL: Required<ContextEnrichmentFields> = {
  ...CONTEXT_ENRICHMENT_ALL_OFF,
  url:  true,
  path: true,
};

function resolveContextEnrichment(cfg: TrackerConfig['contextEnrichment']): Required<ContextEnrichmentFields> {
  if (cfg === false)                             return CONTEXT_ENRICHMENT_ALL_OFF;
  if (cfg === true || cfg == null)               return CONTEXT_ENRICHMENT_STANDARD;
  if (cfg === 'full')                            return CONTEXT_ENRICHMENT_ALL_ON;
  if (cfg === 'minimal')                         return CONTEXT_ENRICHMENT_MINIMAL;
  return { ...CONTEXT_ENRICHMENT_STANDARD, ...cfg };
}

/**
 * Build the enriched portion of a {@link TrackerContext} from the current
 * browser globals, gated by `contextEnrichment` flags. Returns an empty
 * object in Node or when every flag is off.
 */
function buildAutoContext(flags: Required<ContextEnrichmentFields>): Partial<TrackerContext> {
  if (!isBrowser) return {};
  const ctx: Partial<TrackerContext> = {};

  if (flags.url       && typeof window !== 'undefined' && window.location?.href)     ctx.url       = window.location.href;
  if (flags.path      && typeof window !== 'undefined' && window.location?.pathname) ctx.path      = window.location.pathname;
  if (flags.userAgent && typeof navigator !== 'undefined' && navigator.userAgent)    ctx.userAgent = navigator.userAgent;
  if (flags.language  && typeof navigator !== 'undefined' && navigator.language)     ctx.language  = navigator.language;

  if (flags.referrer && typeof document !== 'undefined' && document.referrer) {
    ctx.referrer = document.referrer;
  }

  if (flags.timezone && typeof Intl !== 'undefined') {
    try { ctx.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* unsupported runtime */ }
  }

  if (flags.viewport && typeof window !== 'undefined'
      && typeof window.innerWidth === 'number' && typeof window.innerHeight === 'number') {
    ctx.viewport = { width: window.innerWidth, height: window.innerHeight };
  }

  if (flags.screen && typeof screen !== 'undefined'
      && typeof screen.width === 'number' && typeof screen.height === 'number') {
    ctx.screen = { width: screen.width, height: screen.height };
  }

  if (flags.connection && typeof navigator !== 'undefined') {
    const conn = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
    if (conn?.effectiveType) ctx.connection = conn.effectiveType;
  }

  return ctx;
}

/**
 * Configuration options for {@link TrackerClient}.
 *
 * Set `endpoint` to your tracker's ingest URL. Omit it entirely to fall
 * back to the public rw3iss tracker (`https://tracker.ryanweiss.net/ingest/events`),
 * or set `transport` for custom delivery (in-process, queued, etc.).
 *
 * @example
 * ```typescript
 * TrackerClient.init({
 *   endpoint: 'https://tracker.ryanweiss.net/ingest/events',
 *   appId: 'buyer-portal',
 *   environment: 'production',
 *   minLevel: 'info',
 *   autoCapture: true,
 * });
 * ```
 *
 * @see {@link TrackerClient.init}
 * @see {@link TrackerClient.configure}
 */
export interface TrackerConfig {
  /**
   * Full URL events POST to. Used as-is — no path appending. When unset
   * or empty, defaults to `https://tracker.ryanweiss.net/ingest/events`
   * so a fresh init still ships events somewhere useful for the public
   * tracker case. Ignored when `transport` is set.
   *
   * @remarks Events are POSTed as a JSON array to this URL.
   */
  endpoint?:     string;

  /**
   * Custom transport for event delivery. When provided, bypasses the built-in
   * HTTP queue/flusher entirely -- events are delivered via `transport.send()`
   * after the client-side pipeline (enrichers, plugins, beforeSend) runs.
   *
   * Use `DirectTransport` from `@rw3iss/tracker/consumer` for server
   * self-tracking without an HTTP roundtrip.
   *
   * @see {@link ITrackerTransport}
   */
  transport?:    ITrackerTransport;

  /**
   * API key for server-to-server authentication.
   * Sent as `X-Tracker-Key` header on every HTTP request.
   * Optional -- omit if the tracker server allows public ingestion.
   */
  apiKey?:       string;

  /** Application identifier stamped on every event (e.g. `'buyer-portal'`, `'api-server'`). */
  appId?:        string;
  /** Deployment environment. Merged into the event {@link TrackerContext}. */
  environment?:  TrackerContext['environment'];
  /** Application version string. Merged into the event {@link TrackerContext}. */
  appVersion?:   string;

  /**
   * Master switch -- set to `false` to disable all tracking.
   * Events are silently dropped, no listeners are installed.
   * @defaultValue `true`
   */
  enabled?:      boolean;

  /**
   * Log internal tracker activity to the console (queue sizes, flushes,
   * enricher errors, dropped events). Useful for integration debugging.
   * @defaultValue `false`
   */
  debug?:        boolean;

  /**
   * Minimum event severity to capture. Events below this level are dropped
   * before enrichment or queueing. Uses the ordering:
   *   `error > warning > info > debug > event`
   *
   * The `'event'` type (custom events) is always captured regardless of this setting.
   *
   * @defaultValue Captures all levels.
   *
   * @example
   * ```typescript
   * // Drop debug events in production
   * TrackerClient.init({ minLevel: 'info', ... });
   * ```
   */
  minLevel?:     EventType;

  /**
   * Last-chance hook before an event enters the queue.
   * Return the event (possibly modified) to allow it, or `null` to drop it.
   * Runs after enrichers and plugins' `onCapture`.
   *
   * @see {@link BeforeSendFn}
   */
  beforeSend?:   BeforeSendFn;

  /**
   * Automatically capture unhandled errors.
   * - Browser: installs `window.onerror` and `window.onunhandledrejection`
   * - Node.js: installs `process.on('uncaughtException')` and `process.on('unhandledRejection')`
   * @defaultValue `true`
   */
  autoCapture?:  boolean;

  /**
   * Browser-context enrichment — which {@link TrackerContext} fields the
   * SDK auto-stamps from `window` / `navigator` / `document` on every
   * event.
   *
   * - `true` (default) — comfortable standard set: url, path, userAgent,
   *   language, timezone, viewport.
   * - `false` — opt out of every field.
   * - `'full'` — everything, including referrer, screen, connection.
   * - `'minimal'` — url + path only.
   * - object — per-field overrides layered on the standard set
   *   (e.g. `{ userAgent: false }` drops only userAgent).
   *
   * Enriched values run *before* {@link enrichers} and `setContext()`,
   * so either can override them. In Node this is a no-op (the source
   * globals don't exist).
   *
   * @defaultValue `true` (standard set)
   * @see {@link ContextEnrichmentMode}
   * @see {@link ContextEnrichmentFields}
   */
  contextEnrichment?: ContextEnrichmentMode;

  /**
   * Error-payload enrichment — how much detail `error()` extracts from
   * the captured `Error` into the wire-format {@link SerializedError}.
   *
   * - `true` / `'full'` (default) — name, message, stack, plus best-
   *   effort file/line (parsed from the top stack frame), code (from
   *   `err.code`), and the wrapped-cause chain. Mirrors Go and PHP.
   * - `false` / `'minimal'` — name, message, stack only.
   * - object — per-field overrides on top of full
   *   (e.g. `{ previous: false }` drops the cause chain but keeps
   *   file/line/code).
   *
   * Primarily a payload-size knob. The CPU savings are modest — see
   * `benchmarks/serialize-error.bench.ts`.
   *
   * @defaultValue `true` ('full')
   * @see {@link ErrorEnrichmentMode}
   */
  errorEnrichment?: ErrorEnrichmentMode;

  /**
   * Enricher functions that transform events before plugin processing.
   * Executed in order; both sync and async enrichers are supported.
   *
   * @see {@link EnricherFn}
   */
  enrichers?:    EnricherFn[];

  /**
   * Client-side plugins that hook into the capture lifecycle.
   *
   * @see {@link ITrackerClientPlugin}
   */
  plugins?:      ITrackerClientPlugin[];

  /**
   * Automatically capture failed network requests (status >= 400 or network error)
   * as `type: 'error'` tracker events. Disabled by default.
   * Set to `true` to enable with defaults, or provide a {@link NetworkCaptureConfig} object.
   */
  networkCapture?: boolean | NetworkCaptureConfig;

  /**
   * Use a Service Worker with Background Sync to deliver queued events even after
   * the page closes. Events are written to IndexedDB so the SW can read them.
   *
   * @see {@link ServiceWorkerTransportConfig}
   */
  serviceWorkerTransport?: ServiceWorkerTransportConfig;

  /**
   * Elect one leader tab via BroadcastChannel so only a single tab flushes at a time.
   * Requires IndexedDB -- automatically activates the shared IDB queue.
   * @defaultValue `false`
   */
  crossTabCoordination?: boolean;

  /**
   * Queue configuration options.
   *
   * @remarks
   * - `maxSize` -- Maximum number of events in the in-memory queue (default: 200).
   *   When exceeded, the oldest event is dropped.
   * - `storageKey` -- localStorage key for persisting unflushed events (default: `'__vt_queue__'`).
   * - `flushInterval` -- Interval in ms between automatic flushes (default: 5000).
   */
  queue?: Partial<TrackerQueueOptions> & { flushInterval?: number };

  /**
   * Retry configuration for failed HTTP flushes.
   *
   * @see {@link RetryOptions}
   */
  retry?:        Partial<RetryOptions>;

  /**
   * Auto-generate and attach a sessionId to every event context.
   *
   * Set to `false` to disable session tracking entirely.
   * Set to an object to provide lifecycle hooks or an external session ID.
   *
   * @defaultValue `true`
   *
   * @see {@link SessionManager}
   */
  sessionTracking?: boolean | {
    /** Provide session lifecycle hooks. */
    hooks?: SessionLifecycleHooks;
    /** Override with your own session ID (e.g. from auth). */
    sessionId?: string;
  };

  /**
   * Rate-limit events per type to prevent event storms.
   * Uses a token-bucket algorithm per event type.
   *
   * @see {@link RateLimitConfig}
   */
  rateLimit?: RateLimitConfig;

  /**
   * Per-emitter deduplication policy. The SDK stamps `event.dedup = false`
   * on every captured event that matches the configured rule, so the
   * consumer skips dedup for that event. Lets each app declare its own
   * "events that legitimately repeat" without coordinating with the
   * tracker server.
   *
   * Either field is optional. Both can be set — they OR together.
   * Stamping happens before `beforeSend` runs, so a user-supplied
   * `beforeSend` can still override `event.dedup` if it really wants to.
   *
   * @example
   * ```typescript
   * TrackerClient.init({
   *   dedup: {
   *     // Bypass dedup for any of these message prefixes / exact matches.
   *     bypassMessages: ['bid.', 'auction.', 'order.'],
   *     // Or an arbitrary predicate. Matches alongside bypassMessages.
   *     bypassPredicate: (e) => e.type === 'event',
   *   },
   * });
   * ```
   *
   * Server-side `bypassDedup` (configured on the consumer) still runs
   * for events the client didn't pre-stamp — use it for cross-app
   * rules / emergency overrides without requiring an emitter redeploy.
   */
  dedup?: {
    /**
     * Stamp `dedup: false` when `event.message` either equals or
     * starts with any entry in this list. Most apps want the prefix
     * form (`'bid.'` matches `'bid.place_committed'`,
     * `'bid.place_started'`, …).
     */
    bypassMessages?:  string[];
    /**
     * Arbitrary predicate. Returning `true` stamps `dedup: false`.
     * Composes with `bypassMessages` (OR).
     */
    bypassPredicate?: (event: TrackerEvent) => boolean;
  };

  /**
   * Expose the tracker instance on a global variable for runtime access.
   *
   * - Browser: sets `window[globalName]`
   * - Node: sets `global[globalName]` (or `globalThis[globalName]`)
   *
   * @example
   * ```typescript
   * TrackerClient.init({ globalName: 'tracker', ... });
   * // Now accessible as: window.tracker.info('hello')
   * ```
   */
  globalName?:   string;

  /**
   * Injected delay function for testing. Replaces `setTimeout`-based delays
   * in the flusher's retry logic.
   * @internal
   */
  _delay?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  maxSize:       200,
  flushInterval: 5_000,
  storageKey:    '__vt_queue__',
  maxAttempts:   3,
  baseDelay:     1_000,
  backoffFactor: 2,
};

/**
 * Fallback `endpoint` when neither `endpoint` nor `transport` is set on
 * `TrackerConfig`. Points at the public rw3iss tracker's ingest URL
 * so a fresh `init({ appId })` works without any further config. Used
 * as-is — no path appending. Operators on a self-hosted cluster
 * override via `endpoint`.
 */
const DEFAULT_ENDPOINT = 'https://tracker.ryanweiss.net/ingest/events';

/**
 * Build the per-event "should this be stamped `dedup: false`?" predicate
 * from `TrackerConfig.dedup`. Returns undefined when no policy is set,
 * so the capture path can skip the call entirely.
 *
 * `bypassMessages` matches by exact equality OR prefix — `'bid.'`
 * matches `'bid.place_committed'` and `'bid.'` itself.
 *
 * `bypassPredicate` runs alongside `bypassMessages` (OR). A predicate
 * thrown out of doesn't kill the capture path — we treat any throw as
 * "no opinion" and let the next layer decide.
 */
function resolveDedupBypass(
  cfg?: TrackerConfig['dedup'],
): ((event: TrackerEvent) => boolean) | undefined {
  if (!cfg) return undefined;
  const messages  = cfg.bypassMessages?.length ? cfg.bypassMessages.slice() : null;
  const predicate = cfg.bypassPredicate ?? null;
  if (!messages && !predicate) return undefined;

  return (event: TrackerEvent) => {
    if (messages && typeof event.message === 'string') {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (event.message === m || event.message.startsWith(m)) return true;
      }
    }
    if (predicate) {
      try {
        if (predicate(event)) return true;
      } catch {
        // Treat predicate errors as "no opinion" — never block capture.
      }
    }
    return false;
  };
}

// ─── Node.js auto-capture ──────────────────────────────────────────────────

let nodeUncaughtHandler:   ((err: Error) => void) | null = null;
let nodeRejectionHandler:  ((reason: unknown) => void) | null = null;

function registerNodeAutoCapture(client: TrackerClient): void {
  if (!isNode || nodeUncaughtHandler) return;

  nodeUncaughtHandler = (err: Error) => {
    client.error(err, { tags: ['auto-capture', 'uncaught-exception'] });
  };

  nodeRejectionHandler = (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason ?? 'Unhandled rejection'));
    client.error(err, { tags: ['auto-capture', 'unhandled-promise'] });
  };

  process.on('uncaughtException', nodeUncaughtHandler);
  process.on('unhandledRejection', nodeRejectionHandler);
}

function unregisterNodeAutoCapture(): void {
  if (!isNode) return;
  if (nodeUncaughtHandler)  { process.removeListener('uncaughtException', nodeUncaughtHandler); nodeUncaughtHandler = null; }
  if (nodeRejectionHandler) { process.removeListener('unhandledRejection', nodeRejectionHandler); nodeRejectionHandler = null; }
}

// ─── Severity filter ───────────────────────────────────────────────────────

function passesSeverity(type: EventType, minLevel?: EventType): boolean {
  if (!minLevel) return true;
  // 'event' type always passes — it's a custom event, not a severity level
  if (type === 'event') return true;
  const minIdx = EVENT_SEVERITY.indexOf(minLevel);
  const typeIdx = EVENT_SEVERITY.indexOf(type);
  if (minIdx === -1 || typeIdx === -1) return true;
  return typeIdx <= minIdx;
}

// ─── TrackerClient ─────────────────────────────────────────────────────────

/**
 * Universal event and error tracking client.
 *
 * TrackerClient is the primary API surface for all tracking operations,
 * used identically in browser and Node.js environments. It provides:
 *
 * - Convenience methods for each event type ({@link error}, {@link warn}, {@link info}, {@link debug}, `event()`)
 * - A domain-specific {@link track} shorthand with automatic category extraction
 * - An extensible pipeline: enrichers -> plugins -> beforeSend -> transport
 * - Automatic session tracking, rate limiting, and error capture
 * - Pluggable delivery via {@link ITrackerTransport}
 *
 * Use the static {@link TrackerClient.init | init()} method to configure the
 * default singleton, or create instances directly with `new TrackerClient()`.
 *
 * @example
 * ```typescript
 * import { TrackerClient } from '@rw3iss/tracker';
 *
 * const tracker = TrackerClient.init({
 *   endpoint: 'https://tracker.ryanweiss.net/ingest/events',
 *   appId: 'my-app',
 *   environment: 'production',
 * });
 *
 * tracker.error(new Error('Something broke'));
 * tracker.info('User logged in', { userId: '123' });
 * tracker.track('auction:bid-placed', { amount: 50 });
 * ```
 *
 * @see {@link TrackerConfig} for all configuration options.
 * @see {@link defaultTracker} for the singleton instance.
 */
export class TrackerClient {
  private config!: TrackerConfig;
  private context: TrackerContext = {};
  private transport: ITrackerTransport | undefined;
  private queue!: TrackerQueue;
  private flusher!: TrackerFlusher;
  private idbQueue: IDBEventQueue | undefined;
  private tabCoordinator: TabCoordinator | undefined;
  private sessionManager: SessionManager | undefined;
  private rateLimiter: RateLimiter | undefined;
  /** Resolved at configure() from `config.dedup`. Undefined when no
   *  dedup policy is set. Returns true → stamp `event.dedup = false`. */
  private dedupBypass: ((event: TrackerEvent) => boolean) | undefined;
  private started = false;

  /**
   * Configure the default singleton instance and start the flush loop.
   *
   * This is the recommended way to initialize the tracker. It configures
   * the module-level {@link defaultTracker} singleton and returns it.
   *
   * @param config - Tracker configuration options.
   * @returns The configured singleton {@link TrackerClient} instance.
   *
   * @example
   * ```typescript
   * const tracker = TrackerClient.init({
   *   endpoint: 'https://tracker.ryanweiss.net/ingest/events',
   *   appId: 'buyer-portal',
   *   environment: 'production',
   * });
   * ```
   *
   * @see {@link TrackerConfig}
   * @see {@link defaultTracker}
   */
  static init(config: TrackerConfig): TrackerClient {
    defaultTracker.configure(config);
    return defaultTracker;
  }

  /** Whether the tracker is actively capturing events. */
  get isEnabled(): boolean {
    return this.started && this.config?.enabled !== false;
  }

  /**
   * Read-only access to the current configuration.
   *
   * @returns The current {@link TrackerConfig}, or `undefined` if not yet configured.
   */
  getConfig(): Readonly<TrackerConfig> | undefined {
    return this.config;
  }

  /**
   * Configure this TrackerClient instance and start all subsystems.
   *
   * If the client was previously configured, {@link destroy} is called first
   * to tear down the previous configuration. This method is called internally
   * by {@link TrackerClient.init | init()}.
   *
   * @param config - Tracker configuration options.
   * @remarks
   * Neither `endpoint` nor `transport` is required — when both are
   * absent, the SDK falls back to the public rw3iss tracker's ingest
   * URL (`https://tracker.ryanweiss.net/ingest/events`) so a fresh init
   * still works for the common case.
   *
   * @see {@link TrackerConfig}
   */
  configure(config: TrackerConfig): void {
    if (this.started) this.destroy();

    this.config = config;
    this.dedupBypass = resolveDedupBypass(config.dedup);

    // Disabled mode — nothing is installed, all methods become no-ops
    if (config.enabled === false) {
      this.debugLog('Tracker disabled by config');
      this.started = true;
      this.exposeGlobal(config.globalName);
      return;
    }

    // Merge environment/appVersion into context defaults
    if (config.environment || config.appVersion) {
      this.context = {
        ...this.context,
        ...(config.environment ? { environment: config.environment } : {}),
        ...(config.appVersion  ? { appVersion:  config.appVersion  } : {}),
      };
    }

    // ── Transport setup ──────────────────────────────────────────────────
    // Custom transport: events are delivered directly via transport.send().
    // No queue, flusher, IDB, tab coordination, or service worker needed.
    //
    // HTTP mode (no transport): built-in queue → periodic flush → POST to endpoint.
    // This is the implicit "HttpTransport" for browser and remote Node clients.

    if (config.transport) {
      this.transport = config.transport;
      this.transport.start?.();
    } else {
      // Endpoint is the FULL URL events POST to — used as-is, no path
      // appending. When unset / empty, fall back to the public rw3iss
      // tracker's ingest URL so a fresh `init({ appId })` still works
      // for the common case. Operators on a self-hosted cluster set
      // their own URL.
      const endpointUrl = (typeof config.endpoint === 'string' && config.endpoint.trim() !== '')
        ? config.endpoint
        : DEFAULT_ENDPOINT;

      this.queue = new TrackerQueue({
        maxSize:    config.queue?.maxSize    ?? DEFAULTS.maxSize,
        storageKey: config.queue?.storageKey ?? DEFAULTS.storageKey,
      });

      const useIDB = !!(config.serviceWorkerTransport || config.crossTabCoordination);

      if (useIDB) {
        this.idbQueue = new IDBEventQueue();
        void this.idbQueue.setMeta('endpoint', endpointUrl);
      }

      this.flusher = new TrackerFlusher({
        queue:         this.queue,
        endpoint:      endpointUrl,
        apiKey:        config.apiKey,
        flushInterval: config.queue?.flushInterval ?? DEFAULTS.flushInterval,
        retry: {
          maxAttempts:   config.retry?.maxAttempts   ?? DEFAULTS.maxAttempts,
          baseDelay:     config.retry?.baseDelay      ?? DEFAULTS.baseDelay,
          backoffFactor: config.retry?.backoffFactor  ?? DEFAULTS.backoffFactor,
        },
        idbQueue: this.idbQueue,
        _delay: (config as any)._delay,
      });

      if (!useIDB) {
        this.queue.drainStorage();
      }

      if (config.serviceWorkerTransport?.swUrl && isBrowser && 'serviceWorker' in navigator) {
        void navigator.serviceWorker.register(config.serviceWorkerTransport.swUrl, {
          scope: config.serviceWorkerTransport.scope,
        });
      }

      if (config.crossTabCoordination && isBrowser && typeof BroadcastChannel !== 'undefined') {
        this.tabCoordinator = new TabCoordinator({
          onLeaderChange: (isLeader) => {
            if (isLeader) this.flusher.start();
            else          this.flusher.stop();
          },
        });
      } else {
        this.flusher.start();
      }
    }

    // Auto-capture: browser uses window.onerror, Node uses process.on
    if (config.autoCapture !== false) {
      if (isBrowser) {
        registerAutoCapture(this);
      } else if (isNode) {
        registerNodeAutoCapture(this);
      }
    }

    if (config.networkCapture) {
      const ncConfig = typeof config.networkCapture === 'object' ? config.networkCapture : {};
      registerNetworkCapture(this, ncConfig);
    }

    // Session management
    if (config.sessionTracking !== false) {
      const stOpts: SessionManagerOptions =
        typeof config.sessionTracking === 'object'
          ? { hooks: config.sessionTracking.hooks }
          : {};
      this.sessionManager = new SessionManager(stOpts);
      if (typeof config.sessionTracking === 'object' && config.sessionTracking.sessionId) {
        this.sessionManager.setSessionId(config.sessionTracking.sessionId);
      }
    }

    // Rate limiting
    if (config.rateLimit) {
      this.rateLimiter = new RateLimiter(config.rateLimit, (dropped) => {
        this.enqueueWithPlugins({
          type:      'event',
          category:  'tracker:rate-limit',
          message:   'tracker rate limit: events dropped',
          timestamp: Date.now(),
          payload: {
            dropped,
            windowMs: config.rateLimit!.summaryIntervalMs ?? 30_000,
          },
          context: this.context,
          appId:   config.appId,
        });
      });
      this.rateLimiter.start();
    }

    this.started = true;

    // Initialise plugins after the client is fully started
    const ref = this.pluginRef();
    for (const plugin of config.plugins ?? []) {
      void plugin.onInit(ref);
    }

    // Expose to global namespace
    this.exposeGlobal(config.globalName);

    this.debugLog(`Tracker initialized`, {
      appId:     config.appId,
      env:       config.environment,
      transport: config.transport ? config.transport.constructor.name : `HTTP → ${config.endpoint}`,
      minLevel:  config.minLevel ?? 'all',
    });
  }

  /**
   * Manually set the session ID (e.g. after login from your auth system).
   *
   * @param id - The session ID to use for subsequent events.
   *
   * @see {@link SessionManager.setSessionId}
   */
  setSessionId(id: string): void {
    this.sessionManager?.setSessionId(id);
  }

  /**
   * Merge additional context fields into the current {@link TrackerContext}.
   *
   * Existing fields not present in `ctx` are preserved. Call
   * {@link clearContext} to reset all context.
   *
   * @param ctx - Partial context fields to merge.
   *
   * @example
   * ```typescript
   * tracker.setContext({ userId: 'user-123', environment: 'production' });
   * ```
   *
   * @see {@link clearContext}
   * @see {@link getContext}
   */
  setContext(ctx: Partial<TrackerContext>): void {
    this.context = { ...this.context, ...ctx };
  }

  /**
   * Reset the context to an empty object.
   *
   * All previously set context fields (userId, sessionId, etc.) are removed.
   *
   * @see {@link setContext}
   */
  clearContext(): void {
    this.context = {};
  }

  /**
   * Get a shallow copy of the current {@link TrackerContext}.
   *
   * @returns A copy of the current context object.
   */
  getContext(): TrackerContext {
    return { ...this.context };
  }

  /**
   * Capture an arbitrary tracker event.
   *
   * This is the core capture method. The convenience methods ({@link error},
   * {@link warn}, {@link info}, {@link debug}, `event()`) all delegate here.
   *
   * The event flows through the full client pipeline:
   * 1. Severity filter (`minLevel`)
   * 2. Rate limiter
   * 3. Context + timestamp stamping
   * 4. Enrichers
   * 5. Plugin `onCapture` hooks
   * 6. `beforeSend` callback
   * 7. Transport delivery or queue enqueue
   *
   * @param event - The event to capture. `timestamp`, `context`, and `appId` are auto-set.
   *
   * @example
   * ```typescript
   * tracker.capture({
   *   type: 'info',
   *   message: 'Order completed',
   *   payload: { orderId: '456' },
   *   tags: ['checkout'],
   * });
   * ```
   *
   * @see {@link TrackerEvent}
   */
  capture(event: Omit<TrackerEvent, 'timestamp' | 'context' | 'appId'>): void {
    if (!this.isEnabled) return;

    // Severity filter — before any work
    if (!passesSeverity(event.type, this.config?.minLevel)) {
      this.debugLog(`Dropped (below minLevel ${this.config?.minLevel}):`, event.type, event.message);
      return;
    }

    // Rate limit check before any enrichment
    if (this.rateLimiter && !this.rateLimiter.allow(event.type as RateLimitEventType)) {
      return;
    }

    const autoCtx = buildAutoContext(resolveContextEnrichment(this.config?.contextEnrichment));

    let e: TrackerEvent = {
      ...event,
      appId:     this.config?.appId,
      timestamp: Date.now(),
      context: {
        // Auto-generated sessionId first so setContext({ sessionId }) can override it.
        ...(this.sessionManager && !this.context.sessionId ? { sessionId: this.sessionManager.sessionId } : {}),
        // Auto-enriched browser fields next so explicit setContext() values win.
        ...autoCtx,
        ...this.context,
      },
    };

    // Per-emitter dedup opt-out — stamp `event.dedup = false` for events
    // matching the configured policy, unless the call site already set
    // `dedup` explicitly (in which case we honor the explicit value).
    if (e.dedup === undefined && this.dedupBypass?.(e)) {
      e = { ...e, dedup: false };
    }

    // Run enrichers synchronously when possible, async only if a Promise is returned
    const enrichers = this.config?.enrichers ?? [];
    if (enrichers.length === 0) {
      this.applyPluginsAndQueue(e);
      return;
    }

    let isAsync = false;
    for (let i = 0; i < enrichers.length; i++) {
      const result = enrichers[i](e);
      if (result instanceof Promise) {
        isAsync = true;
        void result.then(async (resolved) => {
          e = resolved;
          for (let j = i + 1; j < enrichers.length; j++) {
            e = await enrichers[j](e);
          }
          this.applyPluginsAndQueue(e);
        });
        break;
      } else {
        e = result;
      }
    }

    if (!isAsync) {
      this.applyPluginsAndQueue(e);
    }
  }

  /**
   * Capture an error with optional extras.
   *
   * Serializes the Error into a {@link SerializedError} (name, message,
   * stack, plus best-effort file/line/code and the `Error.cause` chain
   * as `previous`) and creates an event with `type: 'error'`. Mirrors
   * the PHP and Go SDKs' wire format — see `docs/API_CONTRACT.md`.
   *
   * @param err - The JavaScript Error object to capture.
   * @param extras - Additional event fields (tags, payload, category, etc.).
   *
   * @example
   * ```typescript
   * try {
   *   await processPayment();
   * } catch (err) {
   *   tracker.error(err, { tags: ['payment'], payload: { orderId: '123' } });
   * }
   * ```
   */
  error(err: Error, extras: Partial<Omit<TrackerEvent, 'type' | 'error' | 'timestamp' | 'context'>> = {}): void {
    this.capture({
      type:    'error',
      message: err.message,
      ...extras,
      error: serializeError(err, this.config?.errorEnrichment),
    });
  }

  /**
   * Capture a warning event.
   *
   * @param message - Warning description.
   * @param payload - Optional structured data.
   *
   * @example
   * ```typescript
   * tracker.warn('Auction ending soon', { auctionId: 123 });
   * ```
   */
  warn(message: string, payload?: Record<string, unknown>): void {
    this.capture({ type: 'warning', message, ...(payload ? { payload } : {}) });
  }

  /**
   * Capture an informational event.
   *
   * @param message - Info description.
   * @param payload - Optional structured data.
   *
   * @example
   * ```typescript
   * tracker.info('User logged in', { userId: 'user-123' });
   * ```
   */
  info(message: string, payload?: Record<string, unknown>): void {
    this.capture({ type: 'info', message, ...(payload ? { payload } : {}) });
  }

  /**
   * Capture a debug event.
   *
   * @param message - Debug description.
   * @param payload - Optional structured data.
   *
   * @example
   * ```typescript
   * tracker.debug('Bid state inconsistency', { expected: 5, got: 3 });
   * ```
   */
  debug(message: string, payload?: Record<string, unknown>): void {
    this.capture({ type: 'debug', message, ...(payload ? { payload } : {}) });
  }

  /**
   * Capture a custom analytics/tracking event.
   *
   * Always captured regardless of the `minLevel` setting.
   *
   * @param name - Event name (used as the `message` field).
   * @param payload - Optional structured data.
   *
   * @example
   * ```typescript
   * tracker.event('page_view', { page: '/auctions', referrer: '/home' });
   * ```
   */
  event(name: string, payload?: Record<string, unknown>): void {
    this.capture({ type: 'event', message: name, ...(payload ? { payload } : {}) });
  }

  /**
   * Shorthand for domain-specific tracking with automatic category extraction.
   *
   * If `name` contains a colon (`:`), the part before the first colon is used
   * as the `category`. This enables easy filtering and grouping in the dashboard.
   *
   * @param name - Event name, optionally prefixed with `category:` (e.g. `'auction:bid-placed'`).
   * @param payload - Optional structured data.
   * @param type - Event type to use.
   * @defaultValue type is `'event'`
   *
   * @example
   * ```typescript
   * tracker.track('auction:stale-state', { auctionId: 123 });
   * // Creates: { type: 'event', message: 'auction:stale-state', category: 'auction', payload: { auctionId: 123 } }
   * ```
   *
   * @see {@link capture}
   */
  track(name: string, payload?: Record<string, unknown>, type: EventType = 'event'): void {
    const colonIdx = name.indexOf(':');
    const category = colonIdx > 0 ? name.slice(0, colonIdx) : undefined;
    this.capture({
      type,
      message: name,
      ...(category ? { category } : {}),
      ...(payload ? { payload } : {}),
    });
  }

  /**
   * Flush all queued events immediately.
   *
   * In HTTP mode, this triggers an immediate POST of all queued events.
   * In transport mode, delegates to `transport.flush()`.
   * No-op if the tracker is disabled.
   *
   * @returns A promise that resolves when the flush is complete.
   */
  async flush(): Promise<void> {
    if (!this.isEnabled) return;
    if (this.transport) {
      await this.transport.flush?.();
    } else {
      await this.flusher?.flush();
    }
  }

  /**
   * Tear down the tracker: flush remaining events, remove all listeners,
   * and release resources.
   *
   * @remarks
   * This method is async because it flushes remaining events before teardown.
   * Always `await` this call to ensure events are delivered.
   *
   * @returns A promise that resolves when teardown is complete.
   *
   * @example
   * ```typescript
   * // On app shutdown
   * await tracker.destroy();
   * ```
   */
  async destroy(): Promise<void> {
    // Stop rate limiter first — emits summary event into the queue
    this.rateLimiter?.stop();
    this.rateLimiter = undefined;
    this.dedupBypass = undefined;

    // Flush remaining events (including any rate-limit summary) before tearing down
    if (this.isEnabled) {
      if (this.transport) {
        try { await this.transport.flush?.(); } catch { /* best-effort */ }
      } else if (this.flusher) {
        try { await this.flusher.flush(); } catch { /* best-effort */ }
      }
    }

    this.transport?.stop?.();
    this.transport = undefined;
    this.flusher?.stop();
    this.tabCoordinator?.destroy();
    this.tabCoordinator = undefined;
    this.idbQueue       = undefined;
    this.sessionManager?.destroy();
    this.sessionManager = undefined;
    unregisterAutoCapture();
    unregisterNetworkCapture();
    unregisterNodeAutoCapture();
    for (const plugin of this.config?.plugins ?? []) {
      plugin.onDestroy?.();
    }
    this.removeGlobal();
    this.started = false;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /** Run plugin onCapture transforms, then beforeSend, then enqueue. */
  private applyPluginsAndQueue(event: TrackerEvent): void {
    let e = event;
    for (const plugin of this.config?.plugins ?? []) {
      if (plugin.onCapture) e = plugin.onCapture(e);
    }

    // beforeSend — last chance to drop or modify
    if (this.config?.beforeSend) {
      const result = this.config.beforeSend(e);
      if (result === null) {
        this.debugLog('Dropped by beforeSend:', e.type, e.message);
        return;
      }
      e = result;
    }

    this.enqueueWithPlugins(e);
  }

  /** Deliver the event via the configured transport or built-in queue. */
  private enqueueWithPlugins(event: TrackerEvent): void {
    if (this.transport) {
      // Custom transport — deliver directly, no queue
      void this.transport.send([event]).catch(() => {});
    } else if (this.idbQueue) {
      void this.idbQueue.push([event]);
      void this.requestSWSync();
    } else {
      this.queue.enqueue(event);
    }
    this.debugLog(`Queued [${event.type}]:`, event.message);
  }

  /** Ask the Service Worker to register a Background Sync tag so it flushes even
   *  after the page closes. Falls back gracefully when SW / Background Sync is absent. */
  private async requestSWSync(): Promise<void> {
    if (!isBrowser || !('serviceWorker' in navigator)) return;
    try {
      const reg     = await navigator.serviceWorker.ready;
      const syncTag = this.config.serviceWorkerTransport?.syncTag ?? '__vt_sync__';
      // SyncManager is not in all TS lib defs — use bracket notation
      await (reg as any).sync?.register(syncTag);
    } catch {
      // Background Sync unsupported or SW not active — flush timer covers it
    }
  }

  /** Minimal ref exposed to plugins — avoids circular dependency on full TrackerClient. */
  private pluginRef(): ITrackerClientRef {
    return {
      capture:    (event) => this.capture(event),
      getContext: () => this.getContext(),
    };
  }

  private exposeGlobal(name?: string): void {
    if (!name) return;
    const g = (typeof globalThis !== 'undefined' ? globalThis : (isBrowser ? window : (typeof global !== 'undefined' ? global : undefined))) as any;
    if (g) g[name] = this;
  }

  private removeGlobal(): void {
    const name = this.config?.globalName;
    if (!name) return;
    const g = (typeof globalThis !== 'undefined' ? globalThis : (isBrowser ? window : (typeof global !== 'undefined' ? global : undefined))) as any;
    if (g && g[name] === this) delete g[name];
  }

  private debugLog(msg: string, ...args: unknown[]): void {
    if (this.config?.debug) {
      console.debug(`[tracker]`, msg, ...args);
    }
  }
}

/**
 * Default singleton TrackerClient instance.
 *
 * Configured via {@link TrackerClient.init | TrackerClient.init()}. Import this
 * directly when you need the tracker without calling `init()` again.
 *
 * @example
 * ```typescript
 * import { defaultTracker } from '@rw3iss/tracker';
 * defaultTracker.info('hello from default tracker');
 * ```
 */
export const defaultTracker = new TrackerClient();
