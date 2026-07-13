import type { EventType, TrackerEvent } from './types';

/**
 * Function-based event filter predicate.
 *
 * Return `true` to allow the event through, `false` to reject it.
 * Used as one variant of the {@link EventFilter} union type.
 *
 * @param event - The tracker event to evaluate.
 * @returns `true` if the event passes the filter.
 *
 * @example
 * ```typescript
 * const errorsOnly: EventFilterFn = (e) => e.type === 'error';
 * ```
 *
 * @see {@link EventFilter}
 * @see {@link matchesEventFilter}
 */
export type EventFilterFn = (event: TrackerEvent) => boolean;

/**
 * JSON-serialisable config-based filter.
 *
 * All provided fields must match (AND semantics); unset fields are ignored.
 * This variant of {@link EventFilter} is useful for declarative configuration
 * (e.g. in JSON config files or module options) where functions cannot be used.
 *
 * @example
 * ```typescript
 * const filter: EventFilterConfig = {
 *   type: ['error', 'warning'],
 *   appId: 'buyer-portal',
 *   tags: ['payment'],
 * };
 * ```
 *
 * @see {@link EventFilter}
 * @see {@link matchesEventFilter}
 */
export interface EventFilterConfig {
  /** Allow only events whose `type` is in this list. */
  type?:     EventType[];
  /** Allow only events whose `appId` equals this value. */
  appId?:    string;
  /** Allow only events whose `category` equals this value. */
  category?: string;
  /** Allow only events that include ALL of these tags. */
  tags?:     string[];
}

/**
 * An event filter -- either a predicate function or a declarative config object.
 *
 * Evaluate with {@link matchesEventFilter}.
 *
 * @see {@link EventFilterFn} for the function variant.
 * @see {@link EventFilterConfig} for the config object variant.
 */
export type EventFilter = EventFilterFn | EventFilterConfig;

/**
 * Evaluate whether a {@link TrackerEvent} passes a given {@link EventFilter}.
 *
 * - {@link EventFilterFn} -- delegates directly to the predicate function.
 * - {@link EventFilterConfig} -- applies AND semantics across all specified fields;
 *   unset fields are skipped (i.e. they match everything).
 *
 * @param event - The event to test.
 * @param filter - The filter to apply (function or config object).
 * @returns `true` if the event passes the filter.
 *
 * @example
 * ```typescript
 * const filter: EventFilter = { type: ['error'], appId: 'api-server' };
 * const event: TrackerEvent = { type: 'error', message: 'fail', timestamp: Date.now() };
 * matchesEventFilter(event, filter); // true
 * ```
 *
 * @see {@link EventFilter}
 */
export function matchesEventFilter(event: TrackerEvent, filter: EventFilter): boolean {
  if (typeof filter === 'function') return filter(event);

  const { type, appId, category, tags } = filter;
  if (type     && !type.includes(event.type as EventType))          return false;
  if (appId    && event.appId    !== appId)                         return false;
  if (category && event.category !== category)                      return false;
  if (tags     && !tags.every(t  => event.tags?.includes(t)))       return false;
  return true;
}
