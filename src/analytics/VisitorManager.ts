import { BrowserStorage } from './storage/BrowserStorage';
import { DEFAULT_STORAGE_PREFIX } from './vocabulary';
import type { VisitorConfig } from './types';

/**
 * Long-lived anonymous visitor identity.
 *
 * On first call, generates a random `client_id` (`v_<hex>`) and persists it
 * to the configured storage. Subsequent runs read it back. The same visitor
 * across sessions, tabs, and (for cookie-mode) subdomains resolves to the
 * same `client_id`.
 *
 * Emits `first_visit` exactly once — the first time a visitor is observed
 * with no stored ID. Recoveries from cleared storage emit `first_visit`
 * again, which is correct: from our perspective, that visitor truly is new.
 *
 * Has no DOM dependencies beyond what `BrowserStorage` exposes — works the
 * same in any environment where the configured storage backend is reachable.
 */
export class VisitorManager {
  private readonly storage: BrowserStorage;
  private readonly key:     string;
  private cachedId:         string | null = null;
  private justCreated       = false;

  constructor(config: VisitorConfig | undefined, storagePrefix = DEFAULT_STORAGE_PREFIX) {
    const kind = config?.storage ?? 'localStorage';
    this.storage = new BrowserStorage(kind, {
      cookieDomain:  config?.cookieDomain,
      cookieMaxAge:  config?.cookieMaxAge,
      cookiePath:    config?.cookiePath,
      cookieSameSite: config?.cookieSameSite,
      cookieSecure:  config?.cookieSecure,
    });
    this.key = `${storagePrefix}cid`;
  }

  /**
   * Get the visitor's `client_id`, generating + persisting one on first call.
   *
   * @returns The persisted `client_id`. Always defined.
   */
  getId(): string {
    if (this.cachedId !== null) return this.cachedId;
    const stored = this.storage.get(this.key);
    if (stored && stored.length > 0) {
      this.cachedId = stored;
      return stored;
    }
    const fresh = generateClientId();
    this.cachedId   = fresh;
    this.justCreated = true;
    this.storage.set(this.key, fresh);
    return fresh;
  }

  /**
   * `true` only on the run that created the ID. Used by `AnalyticsPlugin` to
   * emit `first_visit` exactly once — the next call to `getId()` will return
   * the persisted ID and `isFirstVisit()` returns `false`.
   *
   * Calling this method clears the flag so subsequent calls return `false`,
   * which is the desired behavior — the plugin wants to ask once.
   */
  isFirstVisit(): boolean {
    if (!this.justCreated) return false;
    this.justCreated = false;
    return true;
  }

  /**
   * Clear the persisted `client_id`. The next `getId()` will generate a new
   * one and `isFirstVisit()` will return `true` again.
   *
   * Use this when consent is revoked, when the host explicitly requests a
   * reset, or in tests.
   */
  reset(): void {
    this.cachedId    = null;
    this.justCreated = false;
    this.storage.remove(this.key);
  }
}

/**
 * Random visitor ID generator. Uses `crypto.randomUUID()` when available,
 * otherwise falls back to a Math.random + timestamp combination.
 *
 * Output format: `v_<hex/uuid>` — the `v_` prefix makes the ID
 * self-describing in raw event payloads.
 */
function generateClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `v_${crypto.randomUUID().replace(/-/g, '')}`;
    }
  } catch { /* fall through */ }
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 14);
  return `v_${ts}${rand}`;
}
