export { TrackerClient, defaultTracker as tracker } from './TrackerClient';
export type {
  TrackerConfig,
  ServiceWorkerTransportConfig,
  BeforeSendFn,
  ContextEnrichmentMode,
  ContextEnrichmentFields,
} from './TrackerClient';
export type { ErrorEnrichmentMode, ErrorEnrichmentFields } from './serialize-error';
export type { ITrackerClientPlugin, ITrackerClientRef } from './ITrackerClientPlugin';
export type { ITrackerTransport } from './ITrackerTransport';
export type { NetworkCaptureConfig } from './network-capture';
export type { QueuedItem } from './IDBEventQueue';
export { IDBEventQueue } from './IDBEventQueue';
export { TabCoordinator } from './TabCoordinator';
export type { TabCoordinatorOptions } from './TabCoordinator';
export { SessionManager } from './SessionManager';
export type { SessionManagerOptions, SessionLifecycleHooks } from './SessionManager';
export { RateLimiter } from './RateLimiter';
export type { RateLimitConfig, BucketConfig, RateLimitEventType, SummaryCallback } from './RateLimiter';
export type {
  EventType,
  TrackerEvent,
  TrackerContext,
  EnricherFn,
  Breadcrumb,
  BreadcrumbCategory,
  BreadcrumbLevel,
} from '../common/types';
export { TrackerEventStatus, EVENT_SEVERITY } from '../common/types';
export type { EventFilterFn, EventFilterConfig, EventFilter } from '../common/filters';
export { matchesEventFilter } from '../common/filters';
export { Events } from '../common/events';
export type { EventName } from '../common/events';
