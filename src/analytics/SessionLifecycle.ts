import { BrowserStorage } from './storage/BrowserStorage';
import { DEFAULT_STORAGE_PREFIX } from './vocabulary';
import type { SessionConfig, MultiTabSessionMode } from './types';

/** Persisted session state — one per visitor in `'shared'` mode, one per tab in `'per-tab'` mode. */
interface SessionState {
  id:           string;
  number:       number;
  startTs:      number;
  lastActivity: number;
}

const ACTIVITY_BROADCAST_CHANNEL = '__vt_a_session__';

/**
 * Inactivity-bounded session lifecycle modeled on GA4 semantics.
 *
 * - **Default mode (`'shared'`):** sessions live in `localStorage` keyed by
 *   visitor — every tab in the same visitor reads/writes the same session
 *   state. Activity in any tab keeps the session alive in all tabs.
 *   `BroadcastChannel` propagates activity events between tabs in real time
 *   so idle counters don't drift between tabs.
 *
 * - **Per-tab mode (`'per-tab'`):** sessions live in `sessionStorage` so each
 *   tab has its own. Better matches the legacy "session per tab" semantics
 *   if that's what the host needs.
 *
 * Inactivity timeout (default 30 min) bounds sessions. After that gap, the
 * next `markActive()` rotates to a new session. `endOnPageHide: true`
 * additionally fires `onSessionEnd` synchronously on `pagehide`.
 *
 * The host must call `markActive()` on every captured event so the lifecycle
 * tracks real activity rather than wall-clock time.
 */
export class SessionLifecycle {
  private readonly storage:        BrowserStorage;
  private readonly key:            string;
  private readonly inactivityMs:   number;
  private readonly endOnPageHide:  boolean;
  private readonly multiTab:       MultiTabSessionMode;
  private readonly channel:        BroadcastChannel | null;
  private readonly pageHideHandler: (() => void) | null;

  /** Called when a brand-new session is created or rotated into. */
  onSessionStart: (state: SessionState) => void = () => {};
  /** Called when a session ends (either via inactivity rotation or page hide). */
  onSessionEnd:   (state: SessionState) => void = () => {};

  constructor(config: SessionConfig | undefined, storagePrefix = DEFAULT_STORAGE_PREFIX) {
    this.inactivityMs  = config?.inactivityMs  ?? 30 * 60_000;
    this.endOnPageHide = config?.endOnPageHide ?? true;
    this.multiTab      = config?.multiTab      ?? 'shared';

    // 'shared' uses localStorage (cross-tab); 'per-tab' uses sessionStorage (tab-local).
    this.storage = new BrowserStorage(this.multiTab === 'shared' ? 'localStorage' : 'sessionStorage');
    this.key     = `${storagePrefix}sess`;

    this.channel = this.multiTab === 'shared' && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(ACTIVITY_BROADCAST_CHANNEL)
      : null;

    if (this.channel) {
      this.channel.onmessage = (e: MessageEvent<{ ts: number }>) => {
        // Another tab reported activity — bump local lastActivity to match
        // so this tab doesn't fire a stale-session rotation.
        const state = this.read();
        if (!state) return;
        if (e.data?.ts && e.data.ts > state.lastActivity) {
          state.lastActivity = e.data.ts;
          this.write(state);
        }
      };
    }

    this.pageHideHandler = this.endOnPageHide && typeof window !== 'undefined'
      ? () => {
          const state = this.read();
          if (state) this.onSessionEnd(state);
        }
      : null;
    if (this.pageHideHandler) {
      window.addEventListener('pagehide', this.pageHideHandler);
    }
  }

  /**
   * Get the current session ID, starting one if none exists or rotating if
   * the prior one has timed out. Idempotent within a single session.
   */
  getSessionId(): string {
    return this.ensureCurrentSession().id;
  }

  /**
   * Get the full current session state. Useful when emitting `session_start`
   * which needs `number` and `startTs` in addition to the ID.
   */
  getState(): SessionState {
    return this.ensureCurrentSession();
  }

  /**
   * Bump the activity timestamp. Called by the host on every captured event.
   * Cheap (one storage write); throttled by the natural cadence of events.
   */
  markActive(): void {
    const state = this.ensureCurrentSession();
    state.lastActivity = Date.now();
    this.write(state);
    // Notify other tabs in shared mode so their idle clocks stay in sync.
    if (this.channel) {
      try { this.channel.postMessage({ ts: state.lastActivity }); } catch { /* swallow */ }
    }
  }

  /**
   * Force a session rotation — emits `session_end` for the current session
   * and starts a new one. Used by tests and by hosts that want explicit
   * session boundaries (e.g. after re-authentication).
   */
  rotate(): SessionState {
    const old = this.read();
    if (old) this.onSessionEnd(old);
    const fresh = this.startFresh((old?.number ?? 0) + 1);
    this.onSessionStart(fresh);
    return fresh;
  }

  /** Detach event listeners. Called when the plugin is destroyed. */
  destroy(): void {
    if (this.channel) try { this.channel.close(); } catch { /* swallow */ }
    if (this.pageHideHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.pageHideHandler);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private ensureCurrentSession(): SessionState {
    const state = this.read();
    const now = Date.now();
    if (state && (now - state.lastActivity) < this.inactivityMs) {
      return state;
    }
    // Either no prior session, or it timed out.
    if (state) this.onSessionEnd(state);
    const fresh = this.startFresh((state?.number ?? 0) + 1);
    this.onSessionStart(fresh);
    return fresh;
  }

  private startFresh(number: number): SessionState {
    const now = Date.now();
    const state: SessionState = {
      id:           generateSessionId(),
      number,
      startTs:      now,
      lastActivity: now,
    };
    this.write(state);
    return state;
  }

  private read(): SessionState | null {
    const raw = this.storage.get(this.key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<SessionState>;
      if (typeof parsed.id !== 'string' || typeof parsed.lastActivity !== 'number') return null;
      return {
        id:           parsed.id,
        number:       typeof parsed.number       === 'number' ? parsed.number       : 1,
        startTs:      typeof parsed.startTs      === 'number' ? parsed.startTs      : parsed.lastActivity,
        lastActivity: parsed.lastActivity,
      };
    } catch { return null; }
  }

  private write(state: SessionState): void {
    this.storage.set(this.key, JSON.stringify(state));
  }
}

function generateSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `s_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    }
  } catch { /* fall through */ }
  return `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
