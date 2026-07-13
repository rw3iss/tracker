import type { TrackerEvent } from '../../common/types';
import type { ServerEnricherFn } from './index';

function parseBrowser(ua: string): string {
  if (/Edg\//.test(ua))        return 'Edge';
  if (/OPR\//.test(ua))        return 'Opera';
  if (/Chrome\//.test(ua))     return 'Chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
  if (/Firefox\//.test(ua))    return 'Firefox';
  if (/MSIE|Trident/.test(ua)) return 'IE';
  return 'unknown';
}

function parseOs(ua: string): string {
  if (/Windows NT/.test(ua))    return 'Windows';
  if (/Mac OS X/.test(ua))      return 'macOS';
  if (/Android/.test(ua))       return 'Android';
  if (/iPhone|iPad/.test(ua))   return 'iOS';
  if (/Linux/.test(ua))         return 'Linux';
  if (/CrOS/.test(ua))          return 'ChromeOS';
  return 'unknown';
}

function parseDevice(ua: string): string {
  if (/iPad/.test(ua))          return 'tablet';
  if (/iPhone|Android.*Mobile/.test(ua)) return 'mobile';
  if (/Android/.test(ua))       return 'tablet';
  return 'desktop';
}

export function createUserAgentEnricher(): ServerEnricherFn {
  return (event: TrackerEvent): TrackerEvent => {
    const ua = event.context?.userAgent;
    if (!ua) return event;

    return {
      ...event,
      context: {
        ...event.context,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- extending TrackerContext with parsed UA fields
        browser: parseBrowser(ua),
        os:      parseOs(ua),
        device:  parseDevice(ua),
      } as typeof event.context,
    };
  };
}
