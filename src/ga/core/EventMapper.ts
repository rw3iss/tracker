import type { TrackerEvent } from '../../common/types';
import type { ForwardRule } from './types';

/** A GA event in the wire-format adapters consume. */
export interface GaEventEnvelope {
  /** GA event name — e.g. `'page_view'`, `'purchase'`, custom string. */
  name:   string;
  /** Event params forwarded to GA. */
  params: Record<string, unknown>;
}

/**
 * Transforms `TrackerEvent` → `GaEventEnvelope` according to the host's
 * `ForwardRule`. Returns `null` when the event should be skipped.
 *
 * Default behavior:
 * - Filter via `events` allowlist OR `filter` predicate (one or the other).
 * - `mapName(message, event)`: identity by default; tracker `message` becomes
 *   the GA event name verbatim. The vocabulary in
 *   `@rw3iss/tracker/analytics` (page_view, session_start, scroll, etc.)
 *   was deliberately chosen to overlap with GA4's recommended event names,
 *   so identity mapping works out of the box for AnalyticsPlugin events.
 * - `mapParams(event)`: returns `event.payload ?? {}` by default.
 *
 * Stamps a few cross-system identity fields onto every params object so GA
 * sees the same `client_id` / `session_id` / `user_id` the tracker does:
 * - `client_id`  ← `event.payload.client_id`
 * - `session_id` ← `event.payload.session_id`
 * - `user_id`    ← `event.context.userId`
 *
 * These are dropped (unset to `undefined`) if the source value is missing,
 * letting GA fall back to its own client ID generation.
 */
export class EventMapper {
  constructor(private readonly rule: ForwardRule = {}) {}

  /**
   * Convert a tracker event to a GA envelope, or return `null` if the rule
   * says to skip.
   */
  map(event: TrackerEvent): GaEventEnvelope | null {
    // Filter step
    if (this.rule.filter) {
      if (!this.rule.filter(event)) return null;
    } else if (this.rule.events) {
      if (!this.rule.events.includes(event.message)) return null;
    }
    // No filter and no allowlist — forward everything (default for tandem mode).

    // Name
    const name = this.rule.mapName ? this.rule.mapName(event.message, event) : event.message;
    if (name === null || name === undefined || name === '') return null;

    // Params
    const baseParams = this.rule.mapParams ? this.rule.mapParams(event) : (event.payload ?? {});
    if (baseParams === null) return null;

    // Stamp identity if present.
    const params: Record<string, unknown> = { ...baseParams };
    const cid = event.payload?.client_id;
    const sid = event.payload?.session_id;
    const uid = event.context?.userId;
    if (typeof cid === 'string' && params.client_id  === undefined) params.client_id  = cid;
    if (typeof sid === 'string' && params.session_id === undefined) params.session_id = sid;
    if (typeof uid === 'string' && params.user_id    === undefined) params.user_id    = uid;

    return { name, params };
  }
}
