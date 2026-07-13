import type { GaConsentState } from './types';

interface ConsentManagerConfig {
  /**
   * Initial consent state (`gtag('consent', 'default', ...)`). The GDPR-safe
   * pattern is to default everything to `'denied'` and update on grant.
   */
  defaults?: GaConsentState;
  /**
   * Promise that resolves to the granted state. When it settles, the manager
   * calls `update` on its listener with the resolved object.
   */
  waitFor?: Promise<GaConsentState | undefined>;
  /**
   * Whether DNT denies analytics + ad storage. Default: `true`. Override to
   * `false` if your audience explicitly opts in past DNT.
   */
  respectDoNotTrack?: boolean;
}

type ConsentListener = (op: 'default' | 'update', state: GaConsentState) => void;

/**
 * Reproduces GA Consent Mode v2's two-step consent dance: a `default` call
 * before the script loads, and an `update` call when consent settles. Owns
 * the state machine; the adapter bound via `subscribe()` actually emits the
 * `gtag('consent', ...)` calls.
 *
 * DNT integration: when `respectDoNotTrack: true`, the *defaults* override
 * to deny analytics + ad storage and `update` is a no-op until explicitly
 * called via `setConsent()`. Consent Mode v2 distinguishes "default deny"
 * (load gtag, don't store) from "no consent at all" (don't load); we still
 * load gtag in DNT but let it run in storageless mode.
 */
export class ConsentManager {
  private readonly defaults: GaConsentState;
  private readonly listeners: ConsentListener[] = [];
  private currentState: GaConsentState;
  private resolved = false;

  constructor(private readonly config: ConsentManagerConfig = {}) {
    const respectDnt = config.respectDoNotTrack ?? true;
    const dntDenied = respectDnt && hasDoNotTrack();

    this.defaults = dntDenied
      ? { ...config.defaults, analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied' }
      : (config.defaults ?? {});
    this.currentState = { ...this.defaults };

    if (config.waitFor) {
      void config.waitFor.then(
        (state) => { if (state) this.setConsent(state); else this.markResolved(); },
        ()      => this.markResolved(),
      );
    }
  }

  /**
   * Register a listener to receive `default` (immediately) and `update`
   * (when consent state changes) calls. The adapter wires these to
   * `gtag('consent', ...)`.
   */
  subscribe(listener: ConsentListener): () => void {
    this.listeners.push(listener);
    // Replay defaults — every subscriber needs them before the script loads.
    try { listener('default', this.defaults); }
    catch { /* swallow */ }
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Imperatively update consent (e.g. from a cookie-banner click). */
  setConsent(partial: GaConsentState): void {
    this.currentState = { ...this.currentState, ...partial };
    this.resolved = true;
    for (const listener of this.listeners) {
      try { listener('update', partial); }
      catch { /* swallow */ }
    }
  }

  /** Current accumulated state. */
  get state(): GaConsentState {
    return { ...this.currentState };
  }

  /** True if consent has settled (`update` fired at least once). */
  get isResolved(): boolean {
    return this.resolved;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private markResolved(): void {
    this.resolved = true;
  }
}

function hasDoNotTrack(): boolean {
  if (typeof navigator === 'undefined') return false;
  const sources: (string | undefined | null)[] = [
    (navigator as Navigator & { doNotTrack?: string | null }).doNotTrack,
    (navigator as Navigator & { msDoNotTrack?: string | null }).msDoNotTrack,
    (typeof window !== 'undefined' ? (window as Window & { doNotTrack?: string | null }).doNotTrack : null),
  ];
  return sources.some(v => v === '1' || v === 'yes');
}
