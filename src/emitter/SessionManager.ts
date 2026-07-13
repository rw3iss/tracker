const SESSION_STORAGE_KEY = '__vt_session__';

/**
 * Lifecycle hooks for session start and end events.
 *
 * @see {@link SessionManager}
 * @see {@link TrackerConfig.sessionTracking}
 */
export interface SessionLifecycleHooks {
  /**
   * Called when a new session is created (either automatically or via {@link SessionManager.rotate}).
   *
   * @param sessionId - The newly created session ID.
   */
  onSessionStart?: (sessionId: string) => void;

  /**
   * Called when a session ends (via {@link SessionManager.rotate} or {@link SessionManager.destroy}).
   *
   * @param sessionId - The session ID that is ending.
   */
  onSessionEnd?:   (sessionId: string) => void;
}

/**
 * Configuration options for {@link SessionManager}.
 *
 * @see {@link SessionManager}
 */
export interface SessionManagerOptions {
  /** Optional lifecycle hooks for session start/end events. */
  hooks?:      SessionLifecycleHooks;
  /**
   * Custom session ID generator function.
   * @defaultValue `crypto.randomUUID()` with a timestamp-based fallback.
   */
  generateId?: () => string;
}

const defaultGenerateId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
};

const ssGet = (): string | null => {
  if (typeof sessionStorage === 'undefined') return null;
  try { return sessionStorage.getItem(SESSION_STORAGE_KEY); } catch { return null; }
};

const ssSet = (id: string): void => {
  if (typeof sessionStorage === 'undefined') return;
  try { sessionStorage.setItem(SESSION_STORAGE_KEY, id); } catch { /* unavailable */ }
};

const ssDel = (): void => {
  if (typeof sessionStorage === 'undefined') return;
  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* unavailable */ }
};

/**
 * Manages browser session IDs for the tracker.
 *
 * Sessions are persisted in `sessionStorage` so they survive page reloads
 * but not tab/browser closes. A new session ID is generated lazily on first
 * access via the {@link sessionId} getter.
 *
 * Supports:
 * - **Automatic generation** using `crypto.randomUUID()` or a custom generator
 * - **Manual override** via {@link setSessionId} (e.g. from your auth system)
 * - **Rotation** via {@link rotate} for explicit session boundaries
 * - **Lifecycle hooks** for session start/end events
 *
 * @remarks
 * In Node.js environments where `sessionStorage` is unavailable, session IDs
 * are held in memory only (no persistence across process restarts).
 *
 * @see {@link TrackerConfig.sessionTracking}
 * @see {@link SessionLifecycleHooks}
 */
export class SessionManager {
  private readonly hooks:       SessionLifecycleHooks;
  private readonly generateId:  () => string;
  private _sessionId: string | null = null;

  /**
   * @param opts - Optional configuration for hooks and ID generation.
   */
  constructor(opts?: SessionManagerOptions) {
    this.hooks      = opts?.hooks      ?? {};
    this.generateId = opts?.generateId ?? defaultGenerateId;
  }

  /**
   * Get the current session ID, creating one if it does not exist yet.
   *
   * On first access, checks `sessionStorage` for a persisted ID from a
   * previous page load. If none is found, generates a new one and fires
   * the {@link SessionLifecycleHooks.onSessionStart} hook.
   *
   * @returns The current session ID string.
   */
  get sessionId(): string {
    if (this._sessionId !== null) return this._sessionId;

    const stored = ssGet();
    if (stored) {
      this._sessionId = stored;
      return this._sessionId;
    }

    const id = this.generateId();
    this._sessionId = id;
    ssSet(id);
    this.hooks.onSessionStart?.(id);
    return id;
  }

  /**
   * Manually set the session ID (e.g. from an existing auth session).
   *
   * Does not fire lifecycle hooks. Persists the ID to `sessionStorage`.
   *
   * @param id - The session ID to set.
   */
  setSessionId(id: string): void {
    this._sessionId = id;
    ssSet(id);
  }

  /**
   * Force-rotate to a new session.
   *
   * Fires {@link SessionLifecycleHooks.onSessionEnd} for the old session
   * and {@link SessionLifecycleHooks.onSessionStart} for the new one.
   *
   * @returns The newly generated session ID.
   */
  rotate(): string {
    const old = this._sessionId ?? ssGet();
    if (old) this.hooks.onSessionEnd?.(old);

    const id = this.generateId();
    this._sessionId = id;
    ssSet(id);
    this.hooks.onSessionStart?.(id);
    return id;
  }

  /**
   * Destroy the session manager, ending the current session.
   *
   * Fires {@link SessionLifecycleHooks.onSessionEnd} if a session was active,
   * then clears the session ID from memory and `sessionStorage`.
   */
  destroy(): void {
    const id = this._sessionId ?? ssGet();
    if (id) this.hooks.onSessionEnd?.(id);
    this._sessionId = null;
    ssDel();
  }
}
