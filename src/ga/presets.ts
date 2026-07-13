import type { GaConsentState, EnhancedMeasurementSettings, ForwardMode } from './core/types';

/**
 * Pre-baked option packages that capture the most common GA configurations.
 * Spread one into a `GoogleAnalyticsPlugin` config to skip looking up the
 * right combination of toggles.
 *
 * @example
 * ```typescript
 * import { GoogleAnalyticsPlugin, gaPresets } from '@rw3iss/tracker/ga';
 *
 * new GoogleAnalyticsPlugin({
 *   measurementIds: ['G-XXX'],
 *   ...gaPresets.privacyFirst,  // GDPR-safe defaults + DNT respect + IP anon + denied consent
 *   ...gaPresets.spaApp,        // disable GA's auto page view; tracker drives it
 * });
 * ```
 */
export interface GaPreset {
  /** Mode override — useful for `spaApp` which disables auto page views and forwards. */
  mode?: ForwardMode;
  config?: {
    debug_mode?:     boolean;
    send_page_view?: boolean;
    anonymize_ip?:   boolean;
    [key: string]:   unknown;
  };
  consent?: {
    defaults?: GaConsentState;
    respectDoNotTrack?: boolean;
  };
  enhancedMeasurement?: EnhancedMeasurementSettings;
  respectDoNotTrack?: boolean;
}

/**
 * Privacy-first defaults aligned with GDPR best practices: deny everything by
 * default, anonymize IPs, respect DNT. Pair with a cookie banner that flips
 * `analytics_storage`/`ad_storage` to `'granted'` on consent grant.
 */
export const privacyFirst: GaPreset = {
  config: {
    anonymize_ip: true,
  },
  consent: {
    defaults: {
      analytics_storage:    'denied',
      ad_storage:           'denied',
      ad_user_data:         'denied',
      ad_personalization:   'denied',
      personalization_storage: 'denied',
      functionality_storage:   'granted',
      security_storage:        'granted',
    },
    respectDoNotTrack: true,
  },
  respectDoNotTrack: true,
};

/**
 * SPA-friendly defaults: disable GA's auto page view (which only fires on
 * initial load and misses route changes), enable our forward-mode page-view
 * forwarding from `AnalyticsPlugin`'s `PageViewCollector`. Use with
 * `mode: 'forward'` and `AnalyticsPlugin` in the same TrackerClient init.
 */
export const spaApp: GaPreset = {
  mode: 'forward',
  config: {
    send_page_view: false,
  },
  enhancedMeasurement: {
    pageViews:        false,
    scrolls:          false,
    outboundClicks:   false,
    siteSearch:       false,
    fileDownloads:    false,
    formInteractions: false,
  },
};

/**
 * Brochure-site defaults: GA's standard enhanced-measurement enabled, no
 * special handling needed. Equivalent to "GA out of the box". Pair with
 * `mode: 'ga-only'`.
 */
export const brochureSite: GaPreset = {
  mode: 'ga-only',
  enhancedMeasurement: {
    pageViews:        true,
    scrolls:          true,
    outboundClicks:   true,
    siteSearch:       true,
    fileDownloads:    true,
    formInteractions: true,
  },
};

/**
 * Convenience export — apps can spread `gaPresets.X` into config:
 * `new GoogleAnalyticsPlugin({ measurementIds: ['G-XXX'], ...gaPresets.spaApp })`.
 */
export const gaPresets = {
  privacyFirst,
  spaApp,
  brochureSite,
};
