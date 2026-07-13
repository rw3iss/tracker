/**
 * Snapshot of the tracker's identity state — passed to GA so the same
 * visitor / session / user resolves across both analytics systems.
 */
export interface IdentitySnapshot {
  clientId?:  string;
  sessionId?: string;
  userId?:    string;
}

/**
 * Source of identity values. Implemented by `AnalyticsPlugin` (returns
 * `{ clientId, sessionId, userId }` from VisitorManager + SessionLifecycle)
 * and by a no-op fallback when AnalyticsPlugin isn't running.
 */
export interface IIdentitySource {
  snapshot(): IdentitySnapshot;
}

/**
 * Identity bridge. Wraps any `IIdentitySource` and provides a stable surface
 * for the GA plugin's adapters to query the latest identity values when
 * sending events.
 *
 * If no source is provided (Mode A — `'ga-only'`), the bridge returns an
 * empty snapshot and GA generates its own `client_id` as usual.
 */
export class IdentityManager {
  constructor(private source: IIdentitySource | null = null) {}

  /**
   * Set or replace the source — typically called after AnalyticsPlugin
   * registers itself (Mode B/C).
   */
  setSource(source: IIdentitySource | null): void {
    this.source = source;
  }

  /** Get the latest identity. Always returns a snapshot — empty if no source. */
  get(): IdentitySnapshot {
    return this.source?.snapshot() ?? {};
  }
}
