import type { TrackerEvent } from '../../common/types';

/**
 * Common interface every analytics collector implements.
 *
 * Collectors observe one piece of browser behavior (page views, scroll,
 * clicks, …), translate it into one or more `TrackerEvent` shapes via
 * `emit`, and clean up after themselves on `uninstall()`.
 *
 * Collectors are deliberately ignorant of the broader plugin machinery —
 * they receive an `emit` callback at construction time and don't see the
 * `TrackerClient`, the consent gate, or the session manager. The
 * `AnalyticsPlugin` orchestrator gates and stamps before forwarding.
 */
export interface ICollector {
  /** Attach DOM listeners, patch globals, etc. Idempotent. */
  install(): void;
  /** Detach everything attached in `install()`. Idempotent. */
  uninstall(): void;
}

/** The signature `AnalyticsPlugin` provides to every collector. */
export type CollectorEmit = (event: Pick<TrackerEvent, 'message' | 'category' | 'payload' | 'tags'>) => void;
