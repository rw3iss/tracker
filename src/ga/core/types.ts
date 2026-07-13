import type { TrackerEvent } from '../../common/types';

/**
 * The three modes the GA plugin operates in. Picked by the host based on
 * deployment intent — see `docs/GoogleAnalytics.md` for the decision matrix.
 *
 * - `'ga-only'`: GA is the only analytics. AnalyticsPlugin is not running.
 *   Lazy-loads `gtag.js`, exposes a typed wrapper, no event forwarding from
 *   the tracker pipeline (errors stay tracker-side).
 *
 * - `'tandem'`: AnalyticsPlugin and GA both run. Both produce GA events
 *   (AnalyticsPlugin via the tracker; GA's own auto-tracking via gtag.js).
 *   IdentityBridge syncs `client_id` / `session_id` so the same visitor
 *   resolves on both backends.
 *
 * - `'forward'`: AnalyticsPlugin's collectors are canonical. GA's auto-
 *   tracking is disabled; matching tracker events are forwarded to GA via
 *   `gtag('event', ...)`. Single source of truth on the client.
 */
export type ForwardMode = 'ga-only' | 'tandem' | 'forward';

/**
 * GA4 Consent Mode v2 signals.
 * @see https://developers.google.com/tag-platform/security/guides/consent
 */
export interface GaConsentState {
  ad_storage?:           'granted' | 'denied';
  ad_user_data?:         'granted' | 'denied';
  ad_personalization?:   'granted' | 'denied';
  analytics_storage?:    'granted' | 'denied';
  functionality_storage?: 'granted' | 'denied';
  personalization_storage?: 'granted' | 'denied';
  security_storage?:     'granted' | 'denied';
}

/**
 * GA4 enhanced-measurement settings — toggles for GA's built-in collectors.
 * Mirrors the GA admin UI's Data Streams → Web → Enhanced Measurement panel.
 *
 * In `'forward'` mode these default to all-off because the tracker drives
 * everything. In `'ga-only'` and `'tandem'` modes these default to all-on.
 */
export interface EnhancedMeasurementSettings {
  pageViews?:        boolean;
  scrolls?:          boolean;
  outboundClicks?:   boolean;
  siteSearch?:       boolean;
  videoEngagement?:  boolean;
  fileDownloads?:    boolean;
  formInteractions?: boolean;
}

/** What `gtag('config', id, opts)` accepts — keep loose since GA expands the field set over time. */
export interface GaConfigOptions {
  debug_mode?:           boolean;
  send_page_view?:       boolean;
  cookie_domain?:        string;
  cookie_flags?:         string;
  cookie_expires?:       number;
  client_id?:            string;
  session_id?:           string;
  user_id?:              string;
  user_properties?:      Record<string, string | number | boolean | null>;
  anonymize_ip?:         boolean;
  allow_google_signals?: boolean;
  allow_ad_personalization_signals?: boolean;
  enhanced_measurement_settings?: EnhancedMeasurementSettings;
  /** GA continues to add fields — accept arbitrary keys. */
  [key: string]: unknown;
}

/**
 * Forwarding rule applied to every event in the tracker pipeline. Returning
 * `null` from `mapName` (or `mapParams`) skips the event entirely.
 */
export interface ForwardRule {
  /** Allowlist of event `message`s to forward. Mutually exclusive with `filter`. */
  events?:    string[];
  /** Predicate alternative — return `true` to forward this event. */
  filter?:    (event: TrackerEvent) => boolean;
  /** Map tracker event `message` → GA event name. Default: identity. */
  mapName?:   (msg: string, event: TrackerEvent) => string | null;
  /** Map tracker `payload` → GA event params. Default: passthrough. */
  mapParams?: (event: TrackerEvent) => Record<string, unknown> | null;
}

/** Batching strategy for the forward queue. */
export type BatchingStrategy =
  /** Send each event as it arrives. Lowest latency, highest call volume. */
  | 'immediate'
  /** Accumulate up to `batchSize` events OR `batchTimeoutMs` of wall time, whichever first. */
  | 'size-or-time'
  /** Accumulate up to `batchTimeoutMs` and emit on every interval. */
  | 'time';
