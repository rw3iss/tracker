export { DirectTransport } from './DirectTransport';
export { TrackerModule } from './TrackerModule';
export type { TrackerModuleOptions, TrackerModuleAsyncOptions, TrackerDeduplicationOptions } from './TrackerModule';
export { TrackerService } from './TrackerService';
export { TrackerController } from './TrackerController';
export { TrackerAdminController } from './TrackerAdminController';
export {
    TrackerDeduplicator,
    DEDUP_PRESETS,
    DEFAULT_FINGERPRINT,
    buildFingerprintFromFields,
} from './TrackerDeduplicator';
export type { DedupBypassFn, DedupField, DedupFingerprintFn, DedupScope } from './TrackerDeduplicator';
export type { ITrackerPlugin, ITrackerServiceRef, IngestContext } from './ITrackerPlugin';
export type { ITrackerDeduplicationCache } from './cache/ITrackerDeduplicationCache';
export { InMemoryDeduplicationCache } from './cache/InMemoryDeduplicationCache';
export { RedisDeduplicationCache } from './cache/RedisDeduplicationCache';
export { TRACKER_DEDUPLICATOR } from './constants';

export type { ServerEnricherFn } from './enrichers/index';
export { createGeoIpEnricher } from './enrichers/GeoIpEnricher';
export type { GeoIpEnricherOptions } from './enrichers/GeoIpEnricher';
export { createUserAgentEnricher } from './enrichers/UserAgentEnricher';
export { createSourceMapEnricher } from './enrichers/SourceMapEnricher';
export type { SourceMapEnricherOptions } from './enrichers/SourceMapEnricher';

export { RateLimitPlugin } from './plugins/RateLimitPlugin';
export type { RateLimitPluginConfig } from './plugins/RateLimitPlugin';
export { AggregationPlugin } from './plugins/AggregationPlugin';
export type { AggregationPluginConfig } from './plugins/AggregationPlugin';
export { RetentionPlugin } from './plugins/RetentionPlugin';
export type { RetentionPluginConfig } from './plugins/RetentionPlugin';
export { ForwardingPlugin } from './plugins/ForwardingPlugin';
export type { ForwardingPluginConfig } from './plugins/ForwardingPlugin';
export { PrometheusPlugin } from './plugins/PrometheusPlugin';
export type { PrometheusPluginConfig } from './plugins/PrometheusPlugin';
export { SamplingPlugin } from './plugins/SamplingPlugin';
export { SessionRollupPlugin } from './plugins/SessionRollupPlugin';
export type { ISessionRollupSink, SessionRollupState } from './plugins/SessionRollupPlugin';

export { WsIngestGateway } from './WsIngestGateway';
export type { WsIngestGatewayOptions } from './WsIngestGateway';
// TrackerSocketIoGateway is loaded lazily by TrackerModule when socketGateway: true.
// Importing it eagerly here would crash apps that don't have @nestjs/websockets installed.
// Import directly from './TrackerSocketIoGateway' if you need the class.
