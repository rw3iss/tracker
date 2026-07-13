import { tracker as defaultTracker } from '../emitter';
import { ECOMMERCE_CATEGORY, EcommerceEvent } from './vocabulary';

/**
 * GA4-compatible item shape — the canonical descriptor for products in the
 * ecommerce vocabulary. Field names match GA4 so the same payload can be
 * forwarded verbatim by the GA plugin (Mode B/C).
 *
 * @see https://developers.google.com/analytics/devguides/collection/ga4/ecommerce
 */
export interface EcommerceItem {
  item_id:           string;
  item_name?:        string;
  affiliation?:      string;
  coupon?:           string;
  currency?:         string;
  discount?:         number;
  index?:            number;
  item_brand?:       string;
  item_category?:    string;
  item_category2?:   string;
  item_category3?:   string;
  item_category4?:   string;
  item_category5?:   string;
  item_list_id?:     string;
  item_list_name?:   string;
  item_variant?:     string;
  location_id?:      string;
  price?:            number;
  quantity?:         number;
  [key: string]: unknown;
}

interface ItemsParams { items: EcommerceItem[] }
interface ValueParams { value: number; currency: string; items: EcommerceItem[] }
interface PaymentParams extends ValueParams { payment_type?: string }
interface ShippingParams extends ValueParams { shipping_tier?: string }
interface PromotionParams { creative_name?: string; creative_slot?: string;
  promotion_id?: string; promotion_name?: string; items?: EcommerceItem[] }
interface PurchaseParams extends ValueParams {
  transaction_id: string;
  affiliation?:   string;
  coupon?:        string;
  shipping?:      number;
  tax?:           number;
}
interface RefundParams extends Partial<ValueParams> { transaction_id: string }
interface SelectItemParams extends ItemsParams { item_list_id?: string; item_list_name?: string }

/**
 * Tracker-bound emitter shape. Lets ecommerce helpers work with the default
 * singleton (most callers) or with a specific TrackerClient instance (tests,
 * multi-tracker setups). The `event` method matches `tracker.event(...)`.
 */
interface EmitterRef {
  event(name: string, payload?: Record<string, unknown>): void;
}

/**
 * Type-safe wrappers around `tracker.event(name, params)` that emit events
 * with the GA4-compatible vocabulary and payload shapes.
 *
 * Usage:
 *
 * ```typescript
 * import { ecommerce } from '@rw3iss/tracker/analytics';
 *
 * ecommerce.viewItem({ items: [{ item_id: 'sku-42', item_name: 'Watch', price: 1200, currency: 'USD' }] });
 * ecommerce.purchase({ transaction_id: 'ord-99', value: 1200, currency: 'USD', items: [...] });
 * ```
 *
 * Apps that don't use the default singleton can pass an explicit emitter via
 * `withEmitter(...)`.
 */
function makeEcommerce(emitter: EmitterRef): {
  viewItemList:    (p: ItemsParams & { item_list_id?: string; item_list_name?: string }) => void;
  selectItem:      (p: SelectItemParams) => void;
  viewItem:        (p: Partial<Pick<ValueParams, 'value' | 'currency'>> & ItemsParams) => void;
  addToCart:       (p: ValueParams) => void;
  removeFromCart:  (p: ValueParams) => void;
  viewCart:        (p: ValueParams) => void;
  addToWishlist:   (p: ValueParams) => void;
  beginCheckout:   (p: ValueParams) => void;
  addPaymentInfo:  (p: PaymentParams) => void;
  addShippingInfo: (p: ShippingParams) => void;
  purchase:        (p: PurchaseParams) => void;
  refund:          (p: RefundParams) => void;
  viewPromotion:   (p: PromotionParams) => void;
  selectPromotion: (p: PromotionParams) => void;
} {
  const send = (name: string, params: object): void => {
    emitter.event(name, { ...params } as Record<string, unknown>);
  };
  return {
    viewItemList:    (p) => send(EcommerceEvent.ViewItemList,    p),
    selectItem:      (p) => send(EcommerceEvent.SelectItem,      p),
    viewItem:        (p) => send(EcommerceEvent.ViewItem,        p),
    addToCart:       (p) => send(EcommerceEvent.AddToCart,       p),
    removeFromCart:  (p) => send(EcommerceEvent.RemoveFromCart,  p),
    viewCart:        (p) => send(EcommerceEvent.ViewCart,        p),
    addToWishlist:   (p) => send(EcommerceEvent.AddToWishlist,   p),
    beginCheckout:   (p) => send(EcommerceEvent.BeginCheckout,   p),
    addPaymentInfo:  (p) => send(EcommerceEvent.AddPaymentInfo,  p),
    addShippingInfo: (p) => send(EcommerceEvent.AddShippingInfo, p),
    purchase:        (p) => send(EcommerceEvent.Purchase,        p),
    refund:          (p) => send(EcommerceEvent.Refund,          p),
    viewPromotion:   (p) => send(EcommerceEvent.ViewPromotion,   p),
    selectPromotion: (p) => send(EcommerceEvent.SelectPromotion, p),
  };
}

/**
 * Default ecommerce helpers bound to the singleton `tracker`. Use
 * `withEmitter(...)` to bind to a different `TrackerClient` instance.
 *
 * Note on category: `tracker.event(name, payload)` natively emits with
 * `category` derived from the message prefix (e.g. `auction:foo` → `auction`).
 * Ecommerce events use plain names like `purchase`, so we use
 * `tracker.track(name, payload, 'event')` with an explicit `'ecommerce:'`
 * prefix internally — this keeps the same wire format every other emitter
 * uses.
 */
export const ecommerce = makeEcommerceForDefaultTracker();

function makeEcommerceForDefaultTracker(): ReturnType<typeof makeEcommerce> {
  const emitter: EmitterRef = {
    event(name, payload) {
      // `tracker.track('ecommerce:purchase', { ... })` produces:
      //   message: 'ecommerce:purchase', category: 'ecommerce', payload: {...}
      // Cleaner than .event() for our case because category is auto-set.
      defaultTracker.track(`${ECOMMERCE_CATEGORY}:${name}`, payload as Record<string, unknown>);
    },
  };
  return makeEcommerce(emitter);
}

/**
 * Bind ecommerce helpers to a specific tracker. Useful in test environments
 * or when a host runs multiple TrackerClient instances.
 */
export function withEmitter(emitter: EmitterRef): ReturnType<typeof makeEcommerce> {
  return makeEcommerce(emitter);
}
