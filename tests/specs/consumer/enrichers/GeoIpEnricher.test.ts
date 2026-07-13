import 'reflect-metadata';
import { createGeoIpEnricher } from '../../../../src/consumer/enrichers/GeoIpEnricher';
import type { TrackerEvent } from '../../../../src/common/types';

const baseEvent: TrackerEvent = {
  type:      'error',
  message:   'boom',
  timestamp: 1,
  context:   {},
};

describe('createGeoIpEnricher', () => {
  it('returns the event unchanged when no ip is present in ctx', async () => {
    const enricher = createGeoIpEnricher();
    const result   = await enricher(baseEvent, undefined);
    expect(result).toStrictEqual(baseEvent);
  });

  it('uses the stub resolver when no custom resolver is provided', async () => {
    const enricher = createGeoIpEnricher();
    const result   = await enricher(baseEvent, { ip: '1.2.3.4' });
    expect((result.context as any).country).toBe('unknown');
    expect((result.context as any).city).toBe('unknown');
    expect((result.context as any).region).toBe('unknown');
  });

  it('calls the custom resolver with the ip', async () => {
    const resolve = jest.fn().mockResolvedValue({ country: 'US', city: 'Chicago', region: 'IL' });
    const enricher = createGeoIpEnricher({ resolve });
    await enricher(baseEvent, { ip: '8.8.8.8' });
    expect(resolve).toHaveBeenCalledWith('8.8.8.8');
  });

  it('merges geo fields into event.context', async () => {
    const resolve  = jest.fn().mockResolvedValue({ country: 'DE', city: 'Berlin', region: 'BE' });
    const enricher = createGeoIpEnricher({ resolve });
    const result   = await enricher(baseEvent, { ip: '2.3.4.5' });
    expect((result.context as any).country).toBe('DE');
    expect((result.context as any).city).toBe('Berlin');
    expect((result.context as any).region).toBe('BE');
  });

  it('preserves existing context fields', async () => {
    const enricher = createGeoIpEnricher({
      resolve: async () => ({ country: 'FR' }),
    });
    const event = { ...baseEvent, context: { userId: 'u1' } as any };
    const result = await enricher(event, { ip: '5.6.7.8' });
    expect((result.context as any).userId).toBe('u1');
    expect((result.context as any).country).toBe('FR');
  });

  it('omits undefined geo fields', async () => {
    const enricher = createGeoIpEnricher({
      resolve: async () => ({ country: 'GB' }),
    });
    const result = await enricher(baseEvent, { ip: '1.1.1.1' });
    expect((result.context as any).city).toBeUndefined();
    expect((result.context as any).region).toBeUndefined();
    expect((result.context as any).country).toBe('GB');
  });
});
