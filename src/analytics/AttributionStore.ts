import { BrowserStorage } from './storage/BrowserStorage';
import { DEFAULT_STORAGE_PREFIX } from './vocabulary';
import type { UtmConfig, AttributionPersistence } from './types';

/** Attribution payload — added to `payload` of every event in the session. */
export interface AttributionPayload {
  utm_source?:   string;
  utm_medium?:   string;
  utm_campaign?: string;
  utm_term?:     string;
  utm_content?:  string;
  gclid?:        string;
  gbraid?:       string;
  wbraid?:       string;
  dclid?:        string;
  fbclid?:       string;
  msclkid?:      string;
  ttclid?:       string;
  page_referrer?: string;
  // Forward-compatible: any additional configured params land here too.
  [key: string]: string | undefined;
}

const DEFAULT_PARAMS: string[] = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'ttclid',
];

/**
 * Captures UTM and click-tag parameters from the URL plus `document.referrer`
 * on the first event of each session, then stamps them into every subsequent
 * event in the session.
 *
 * Storage strategy follows {@link UtmConfig.persistFor}:
 * - `'session'` (default) — `sessionStorage`, expires when the tab closes
 * - `'visitor'` — `localStorage`, persists across sessions until overwritten
 * - `'never'` — in-memory only
 *
 * Captures only the params explicitly listed in {@link UtmConfig.params}
 * (default: standard UTM set + common ad-platform click IDs). Anything not
 * in the list is ignored — preventing accidental capture of session tokens
 * or other sensitive query strings.
 */
export class AttributionStore {
  private readonly storage:    BrowserStorage;
  private readonly key:        string;
  private readonly params:     string[];
  private cached:              AttributionPayload | null = null;
  private memoryFallback:      AttributionPayload | null = null;
  private readonly persistFor: AttributionPersistence;

  constructor(
    config: UtmConfig | undefined,
    private readonly captureReferrer: boolean,
    private readonly ignoreReferrers: string[] = [],
    storagePrefix = DEFAULT_STORAGE_PREFIX,
  ) {
    this.params     = config?.params     ?? DEFAULT_PARAMS;
    this.persistFor = config?.persistFor ?? 'session';
    this.storage    = new BrowserStorage(
      this.persistFor === 'visitor' ? 'localStorage'
      : this.persistFor === 'session' ? 'sessionStorage'
      : 'memory',
    );
    this.key = `${storagePrefix}attr`;
  }

  /**
   * Capture attribution for a brand-new session. Reads `location.search` and
   * `document.referrer`, persists the result, and returns it for stamping
   * onto the `session_start` event.
   *
   * Subsequent events should call `getStamp()` to retrieve the cached payload
   * without re-reading the URL.
   */
  captureForNewSession(): AttributionPayload {
    if (typeof location === 'undefined') return {};

    const payload: AttributionPayload = {};
    try {
      const search = new URLSearchParams(location.search);
      for (const name of this.params) {
        const value = search.get(name);
        if (value) payload[name] = value;
      }
    } catch { /* malformed URL — skip */ }

    if (this.captureReferrer && typeof document !== 'undefined' && document.referrer) {
      try {
        const referrerUrl = new URL(document.referrer);
        if (!this.ignoreReferrers.some(host => referrerUrl.hostname.includes(host))) {
          payload.page_referrer = document.referrer;
        }
      } catch { /* not a valid URL — skip */ }
    }

    this.persist(payload);
    this.cached = payload;
    return payload;
  }

  /**
   * Get the attribution payload to stamp onto subsequent events in the
   * current session. Reads from cache first, then storage — never touches
   * `location.search` again after the initial capture.
   */
  getStamp(): AttributionPayload {
    if (this.cached) return this.cached;
    if (this.persistFor === 'never') return this.memoryFallback ?? {};
    const raw = this.storage.get(this.key);
    if (!raw) return {};
    try { this.cached = JSON.parse(raw) as AttributionPayload; }
    catch { return {}; }
    return this.cached ?? {};
  }

  /** Forget all captured attribution. Used on consent revoke + tests. */
  reset(): void {
    this.cached = null;
    this.memoryFallback = null;
    this.storage.remove(this.key);
  }

  private persist(payload: AttributionPayload): void {
    if (this.persistFor === 'never') {
      this.memoryFallback = payload;
      return;
    }
    try { this.storage.set(this.key, JSON.stringify(payload)); }
    catch { /* swallow */ }
  }
}
