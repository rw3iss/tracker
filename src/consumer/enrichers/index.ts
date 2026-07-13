import type { TrackerEvent } from '../../common/types';
import type { IngestContext } from '../ITrackerPlugin';

export type ServerEnricherFn = (event: TrackerEvent, ctx?: IngestContext) => TrackerEvent | Promise<TrackerEvent>;

export { createGeoIpEnricher } from './GeoIpEnricher';
export type { GeoIpEnricherOptions } from './GeoIpEnricher';
export { createUserAgentEnricher } from './UserAgentEnricher';
export { createSourceMapEnricher } from './SourceMapEnricher';
export type { SourceMapEnricherOptions } from './SourceMapEnricher';
