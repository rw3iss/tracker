// Browser entry — gtag.js / GTM transports. Server-side imports from `/ga/server`.

export { GoogleAnalyticsPlugin } from './GoogleAnalyticsPlugin';
export type { GoogleAnalyticsPluginOptions, LoaderKind } from './GoogleAnalyticsPlugin';

export { gaPresets, privacyFirst, spaApp, brochureSite } from './presets';
export type { GaPreset } from './presets';

// Core building blocks (exposed for advanced wiring + tests)
export { GaCore }            from './core/GaCore';
export type { GaCoreOptions } from './core/GaCore';
export { ConsentManager }    from './core/ConsentManager';
export { IdentityManager }   from './core/IdentityManager';
export type { IIdentitySource, IdentitySnapshot } from './core/IdentityManager';
export { EventMapper }       from './core/EventMapper';
export type { GaEventEnvelope } from './core/EventMapper';
export { BatchQueue }        from './core/BatchQueue';

export type {
  ForwardMode,
  ForwardRule,
  GaConsentState,
  GaConfigOptions,
  EnhancedMeasurementSettings,
  BatchingStrategy,
} from './core/types';

// Auto CTA tracking — global click delegator
export { AutoCtaTracker } from './AutoCtaTracker';
export type { AutoCtaTrackerOptions, CtaIdFallback } from './AutoCtaTracker';

// Adapters
export { GtagAdapter } from './adapters/GtagAdapter';
export type { GtagReadyStatus } from './adapters/GtagAdapter';
export { GtmAdapter }  from './adapters/GtmAdapter';
export type { ITransportAdapter } from './adapters/ITransportAdapter';
