import type { TrackerEvent } from '../common/types';
import type { AnalyticsEventName } from './vocabulary';

/**
 * Where the visitor's long-lived `clientId` is persisted.
 *
 * - `'localStorage'` — default; one ID per origin, no cookie banner needed for the analytics ID itself.
 * - `'cookie'` — set a first-party cookie; needed for cross-subdomain continuity.
 * - `'sessionStorage'` — per-tab, expires when the tab closes. Effectively disables "returning visitor".
 * - `'memory'` — held in JS only; lost on every page load. Useful for incognito-respect or strict modes.
 */
export type VisitorStorageKind = 'localStorage' | 'cookie' | 'sessionStorage' | 'memory';

/** Where attribution (UTM, referrer) is persisted. */
export type AttributionPersistence = 'session' | 'visitor' | 'never';

/** How sessions span multiple open tabs. GA4-style default is per-visitor (one session shared across tabs). */
export type MultiTabSessionMode = 'shared' | 'per-tab';

/** Visitor configuration. */
export interface VisitorConfig {
  /** Where to persist the long-lived `clientId`. Default: `'localStorage'`. */
  storage?:      VisitorStorageKind;
  /** Cookie domain when `storage: 'cookie'`. Default: omitted (host-only cookie). */
  cookieDomain?: string;
  /** Cookie max-age in seconds when `storage: 'cookie'`. Default: 2 years. */
  cookieMaxAge?: number;
  /** Cookie path when `storage: 'cookie'`. Default: `'/'`. */
  cookiePath?:   string;
  /** Cookie SameSite policy when `storage: 'cookie'`. Default: `'Lax'`. */
  cookieSameSite?: 'Strict' | 'Lax' | 'None';
  /** Cookie Secure flag when `storage: 'cookie'`. Default: derives from `location.protocol === 'https:'`. */
  cookieSecure?: boolean;
}

/** Session lifecycle configuration. */
export interface SessionConfig {
  /** Idle threshold before a new session starts. Default: 30 min (GA4 default). */
  inactivityMs?:   number;
  /** Fire `session_end` on `pagehide` (best-effort, via `sendBeacon` if needed). Default: `true`. */
  endOnPageHide?:  boolean;
  /**
   * How sessions span tabs. Default: `'shared'` (one session per visitor across tabs — GA4 behavior).
   * Use `'per-tab'` if each tab should track an independent session.
   */
  multiTab?:       MultiTabSessionMode;
}

/** Engagement (active-time) tracking configuration. */
export interface EngagementConfig {
  /** Periodic accumulator flush interval. Default: 30000 (30s). */
  flushIntervalMs?: number;
  /** Idle threshold for active-time. Default: 30000 (30s). */
  idleTimeoutMs?:   number;
  /** DOM events that count as activity. Default: mouse/key/scroll/touch/click. */
  signals?:         string[];
}

/** Form interaction configuration. */
export interface FormConfig {
  /** Emit `form_start` on first focus into any field of a form. Default: true. */
  start?:    boolean;
  /** Emit `form_submit` on form submit. Default: true. */
  submit?:   boolean;
  /**
   * Pipe-separated precedence list of form attributes to use as the form's
   * identifier in events. Default: `'name|id|action'`.
   */
  identify?: string;
}

/** File-download tracking configuration. */
export interface DownloadConfig {
  /** Lowercase extensions (without dots) to flag as downloads. */
  extensions?:          string[];
  /** Honor the HTML5 `download` attribute regardless of extension. Default: true. */
  respectDownloadAttr?: boolean;
}

/** UTM / attribution-parameter capture configuration. */
export interface UtmConfig {
  /** Query-string parameter names to capture. Default: full GA4 set + `gclid`. */
  params?:     string[];
  /** How long to persist captured UTM. Default: `'session'`. */
  persistFor?: AttributionPersistence;
}

/** Privacy / consent configuration. */
export interface ConsentConfig {
  /** Gate all event emission until consent is granted. Default: `false`. */
  required?: boolean;
  /**
   * Synchronous predicate — return `true` if consent is granted.
   * If both `granted` and `waitFor` are provided, `granted` is checked first.
   */
  granted?: () => boolean;
  /**
   * Promise that resolves when consent is granted. Plugin replays deferred
   * `first_visit` and `session_start` after resolution.
   */
  waitFor?: Promise<unknown>;
}

/** Top-level configuration for {@link AnalyticsPlugin}. */
export interface AnalyticsConfig {
  // ── Visitor + session ────────────────────────────────────────────────
  visitor?:  VisitorConfig;
  sessions?: SessionConfig;

  // ── Page tracking ────────────────────────────────────────────────────
  /** Auto-emit `page_view` on every navigation (incl. SPA pushState). Default: `true`. */
  pageViews?:           boolean;
  /** Debounce window for synchronous double-pushes. Default: `100` ms. */
  pageViewDebounceMs?:  number;

  // ── Engagement ───────────────────────────────────────────────────────
  /** `true` for sane defaults, `false` to disable, or an object to override. */
  engagement?: boolean | EngagementConfig;

  // ── Interaction collectors ───────────────────────────────────────────
  /** Scroll-depth milestones in % (0–100). `false` disables. Default: `[25, 50, 75, 90]`. */
  scrollDepth?:    false | number[];
  /** Track outbound link clicks. Default: `true`. */
  outboundClicks?: boolean;
  /** Track file downloads. `true` for default extensions, `false` to disable, or an object. */
  fileDownloads?:  boolean | DownloadConfig;
  /** Track form interactions. `true` for both start+submit, `false` to disable, or an object. */
  forms?:          boolean | FormConfig;

  // ── Attribution ──────────────────────────────────────────────────────
  /** UTM capture. `true` for defaults, `false` to disable, or an object. */
  utm?:           boolean | UtmConfig;
  /** Capture `document.referrer` on session start. Default: `true`. */
  referrer?:      boolean;
  /** Query-string params that mark a search results page. Default: `['q', 'search', 'query']`. */
  searchParams?:  string[];

  // ── Identity merge ───────────────────────────────────────────────────
  /**
   * When the host calls `tracker.setContext({ userId: ... })`, emit a
   * `user_identified` event so consumers can backfill prior anonymous
   * events to the new userId. Default: `true`.
   */
  emitIdentityMergeEvent?: boolean;

  // ── Sampling ─────────────────────────────────────────────────────────
  /** Per-event keep probability (0..1). Default: `1.0` (no sampling). */
  sampleRate?:     number;
  /** Event names that bypass sampling — full-fidelity always. */
  alwaysEmit?:     AnalyticsEventName[] | string[];
  /** Predicate alternative to `alwaysEmit` — return `true` to bypass sampling. */
  alwaysEmitWhen?: (event: TrackerEvent) => boolean;

  // ── Privacy ──────────────────────────────────────────────────────────
  /** Don't emit anything if `navigator.doNotTrack === '1'`. Default: `true`. */
  respectDoNotTrack?: boolean;
  consent?:           ConsentConfig;
  /** Hint forwarded to consumer (`payload.ip_anonymization: true`). Default: `true`. */
  ipAnonymization?:   boolean;

  // ── Filtering ────────────────────────────────────────────────────────
  /** Skip emission when `location.pathname` matches any of these. */
  ignorePaths?:      (string | RegExp)[];
  /** Skip session attribution when referrer host matches. */
  ignoreReferrers?:  string[];

  // ── Storage (advanced) ────────────────────────────────────────────────
  /** Override the default storage key prefix. Default: `'__vt_a_'`. */
  storagePrefix?: string;
}

/**
 * Defaults — exported so consumers can introspect what they get with
 * `new AnalyticsPlugin()` and an empty config.
 */
export const ANALYTICS_DEFAULTS = {
  // Toggles
  pageViews:              true,
  pageViewDebounceMs:     100,
  outboundClicks:         true,
  scrollDepth:            [25, 50, 75, 90] as number[],
  referrer:               true,
  searchParams:           ['q', 'search', 'query'],
  emitIdentityMergeEvent: true,
  sampleRate:             1.0,
  respectDoNotTrack:      true,
  ipAnonymization:        true,

  // Nested config defaults
  visitor: {
    storage:        'localStorage' as VisitorStorageKind,
    cookieMaxAge:   2 * 365 * 86_400,
    cookiePath:     '/',
    cookieSameSite: 'Lax' as const,
  },
  sessions: {
    inactivityMs:  30 * 60_000,
    endOnPageHide: true,
    multiTab:      'shared' as MultiTabSessionMode,
  },
  engagement: {
    flushIntervalMs: 30_000,
    idleTimeoutMs:   30_000,
    signals:         ['mousemove', 'keydown', 'scroll', 'touchstart', 'click'] as string[],
  },
  forms: {
    start:    true,
    submit:   true,
    identify: 'name|id|action',
  },
  fileDownloads: {
    extensions:          [
      // Documents
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'rtf',
      // Archives
      'zip', 'rar', '7z', 'tar', 'gz', 'tgz',
      // Media
      'mp3', 'wav', 'mp4', 'mov', 'avi', 'webm', 'mkv',
      // Images
      'svg',
    ] as string[],
    respectDownloadAttr: true,
  },
  utm: {
    params:     [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'ttclid',
    ] as string[],
    persistFor: 'session' as AttributionPersistence,
  },
};
