// Server entry — Measurement Protocol transport. Browser side imports from `/ga`.
//
// The shared core, mapper, identity manager, batch queue, and Measurement
// Protocol adapter are re-exported here so server-side code can compose them
// without reaching into `/ga` (which exists primarily for the browser).

export { GoogleAnalyticsServerPlugin } from './GoogleAnalyticsServerPlugin';
export type { GoogleAnalyticsServerPluginOptions } from './GoogleAnalyticsServerPlugin';

// Core building blocks
export { GaCore }            from '../core/GaCore';
export type { GaCoreOptions } from '../core/GaCore';
export { ConsentManager }    from '../core/ConsentManager';
export { IdentityManager }   from '../core/IdentityManager';
export type { IIdentitySource, IdentitySnapshot } from '../core/IdentityManager';
export { EventMapper }       from '../core/EventMapper';
export type { GaEventEnvelope } from '../core/EventMapper';
export { BatchQueue }        from '../core/BatchQueue';

export type {
  ForwardMode,
  ForwardRule,
  GaConsentState,
  GaConfigOptions,
  EnhancedMeasurementSettings,
  BatchingStrategy,
} from '../core/types';

// Adapters
export { MeasurementProtocolAdapter } from '../adapters/MeasurementProtocolAdapter';
export type { ITransportAdapter }     from '../adapters/ITransportAdapter';
