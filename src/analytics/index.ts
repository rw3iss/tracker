export { AnalyticsPlugin }       from './AnalyticsPlugin';
export type { AnalyticsIdentitySnapshot } from './AnalyticsPlugin';
export { VisitorManager }        from './VisitorManager';
export { SessionLifecycle }      from './SessionLifecycle';
export { AttributionStore }      from './AttributionStore';
export { ConsentGate }           from './ConsentGate';
export { EngagementTracker }     from './EngagementTracker';
export { BrowserStorage }        from './storage/BrowserStorage';

export {
  PageViewCollector,
  ScrollDepthCollector,
  OutboundLinkCollector,
  DownloadCollector,
  FormCollector,
  SearchCollector,
  type ICollector,
  type CollectorEmit,
} from './collectors';

export {
  ANALYTICS_CATEGORY,
  ECOMMERCE_CATEGORY,
  AnalyticsEvent,
  EcommerceEvent,
  DEFAULT_STORAGE_PREFIX,
  type AnalyticsEventName,
  type EcommerceEventName,
} from './vocabulary';

export type {
  AnalyticsConfig,
  VisitorConfig,
  SessionConfig,
  EngagementConfig,
  FormConfig,
  DownloadConfig,
  UtmConfig,
  ConsentConfig,
  VisitorStorageKind,
  AttributionPersistence,
  MultiTabSessionMode,
} from './types';
export { ANALYTICS_DEFAULTS } from './types';

export type { AttributionPayload } from './AttributionStore';

export { ecommerce, withEmitter, type EcommerceItem } from './ecommerce';
