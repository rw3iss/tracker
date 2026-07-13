import type { TrackerEvent } from '../../common/types';
import type { IngestContext } from '../ITrackerPlugin';
import type { ServerEnricherFn } from './index';

export interface GeoIpEnricherOptions {
  /**
   * Provide a custom resolver — defaults to a no-op stub.
   * Swap in a real geo-IP library (e.g. `maxmind`, `geoip-lite`) by passing
   * a function that reads from your local database or a remote API.
   */
  resolve?: (ip: string) => Promise<{ country?: string; city?: string; region?: string }>;
}

const stubResolver = async (_ip: string) => ({ country: 'unknown', city: 'unknown', region: 'unknown' });

export function createGeoIpEnricher(opts?: GeoIpEnricherOptions): ServerEnricherFn {
  const resolve = opts?.resolve ?? stubResolver;

  return async (event: TrackerEvent, ctx?: IngestContext): Promise<TrackerEvent> => {
    const ip = ctx?.ip;
    if (!ip) return event;

    const geo = await resolve(ip);

    return {
      ...event,
      context: {
        ...event.context,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- extending TrackerContext with geo fields
        ...(geo.country !== undefined ? { country: geo.country } : {}),
        ...(geo.city    !== undefined ? { city:    geo.city    } : {}),
        ...(geo.region  !== undefined ? { region:  geo.region  } : {}),
      } as typeof event.context,
    };
  };
}
