/**
 * The v1 analytics event vocabulary emitted by `AnalyticsPlugin`.
 *
 * These names are stable — apps depend on them in queries and dashboards, so
 * renaming is a breaking change gated behind a major version bump.
 *
 * All analytics events are emitted with `type: 'event'` (so they always pass
 * `minLevel`) and `category: 'analytics'` (or `'ecommerce'` for commerce
 * events). Use the `message` to discriminate the specific event.
 *
 * @see {@link AnalyticsPlugin}
 */
export const ANALYTICS_CATEGORY = 'analytics' as const;
export const ECOMMERCE_CATEGORY = 'ecommerce' as const;

/**
 * Names emitted by AnalyticsPlugin's collectors and lifecycle pieces.
 *
 * Every entry here corresponds to a `tracker.event(name, payload)` call with
 * `category: 'analytics'`. Consumers query by `category + message`.
 */
export const AnalyticsEvent = {
  // ── Lifecycle ──────────────────────────────────────────────────────────
  /** First time we've ever seen this visitor (no prior `clientId` in storage). */
  FirstVisit:        'first_visit',
  /** A new session started — emitted with attribution payload (UTM, referrer). */
  SessionStart:      'session_start',
  /** A session ended — emitted on `pagehide` or after the inactivity timeout. */
  SessionEnd:        'session_end',
  /** Anonymous visitor signed in. Carries the new `userId` so consumers can backfill. */
  UserIdentified:    'user_identified',
  /** Identified user signed out. */
  UserAnonymized:    'user_anonymized',

  // ── Page + engagement ──────────────────────────────────────────────────
  PageView:          'page_view',
  ViewSearchResults: 'view_search_results',
  /** Periodic active-time accumulator emit. Payload includes `engagement_time_msec`. */
  UserEngagement:    'user_engagement',

  // ── Interactions ───────────────────────────────────────────────────────
  Scroll:            'scroll',
  ClickOutbound:     'click_outbound',
  FileDownload:      'file_download',
  FormStart:         'form_start',
  FormSubmit:        'form_submit',
} as const;

export type AnalyticsEventName = typeof AnalyticsEvent[keyof typeof AnalyticsEvent];

/**
 * The set of GA4-compatible recommended ecommerce event names. Apps emit these
 * via the typed helpers in `./ecommerce.ts`; the wire format is
 * `category: 'ecommerce'`, `message: <one of these>`, and `payload` follows
 * the GA4 ecommerce parameter shape.
 *
 * @see https://developers.google.com/analytics/devguides/collection/ga4/ecommerce
 */
export const EcommerceEvent = {
  ViewItemList:      'view_item_list',
  SelectItem:        'select_item',
  ViewItem:          'view_item',
  AddToCart:         'add_to_cart',
  RemoveFromCart:    'remove_from_cart',
  ViewCart:          'view_cart',
  AddToWishlist:     'add_to_wishlist',
  BeginCheckout:     'begin_checkout',
  AddPaymentInfo:    'add_payment_info',
  AddShippingInfo:   'add_shipping_info',
  Purchase:          'purchase',
  Refund:            'refund',
  ViewPromotion:     'view_promotion',
  SelectPromotion:   'select_promotion',
} as const;

export type EcommerceEventName = typeof EcommerceEvent[keyof typeof EcommerceEvent];

/**
 * Default storage key prefix for visitor / session / attribution state.
 * Override via `AnalyticsConfig.storagePrefix` if you need to coexist with
 * legacy storage keys.
 */
export const DEFAULT_STORAGE_PREFIX = '__vt_a_';
