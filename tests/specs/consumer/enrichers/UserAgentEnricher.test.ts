import 'reflect-metadata';
import { createUserAgentEnricher } from '../../../../src/consumer/enrichers/UserAgentEnricher';
import type { TrackerEvent } from '../../../../src/common/types';

function makeEvent(userAgent?: string): TrackerEvent {
  return {
    type:      'info',
    message:   'page_view',
    timestamp: 1,
    context:   userAgent ? { userAgent } : {},
  };
}

describe('createUserAgentEnricher', () => {
  it('returns the event unchanged when no userAgent in context', () => {
    const enricher = createUserAgentEnricher();
    const event    = makeEvent();
    expect(enricher(event)).toStrictEqual(event);
  });

  it('detects Chrome browser', () => {
    const enricher = createUserAgentEnricher();
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const result = enricher(makeEvent(ua)) as any;
    expect(result.context.browser).toBe('Chrome');
  });

  it('detects Firefox browser', () => {
    const enricher = createUserAgentEnricher();
    const ua = 'Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/115.0';
    const result = enricher(makeEvent(ua)) as any;
    expect(result.context.browser).toBe('Firefox');
  });

  it('detects Safari browser', () => {
    const enricher = createUserAgentEnricher();
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    const result = enricher(makeEvent(ua)) as any;
    expect(result.context.browser).toBe('Safari');
  });

  it('detects Edge browser', () => {
    const enricher = createUserAgentEnricher();
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0';
    const result = enricher(makeEvent(ua)) as any;
    expect(result.context.browser).toBe('Edge');
  });

  it('detects Windows OS', () => {
    const enricher = createUserAgentEnricher();
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0';
    const result = enricher(makeEvent(ua)) as any;
    expect(result.context.os).toBe('Windows');
  });

  it('detects macOS', () => {
    const enricher = createUserAgentEnricher();
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15';
    const result = enricher(makeEvent(ua)) as any;
    expect(result.context.os).toBe('macOS');
  });

  it('detects Android OS', () => {
    const enricher = createUserAgentEnricher();
    const ua = 'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
    const result = enricher(makeEvent(ua)) as any;
    expect(result.context.os).toBe('Android');
  });

  it('detects mobile device', () => {
    const enricher = createUserAgentEnricher();
    const ua = 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36';
    const result = enricher(makeEvent(ua)) as any;
    expect(result.context.device).toBe('mobile');
  });

  it('detects desktop device for generic desktop UA', () => {
    const enricher = createUserAgentEnricher();
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0';
    const result = enricher(makeEvent(ua)) as any;
    expect(result.context.device).toBe('desktop');
  });

  it('detects tablet for iPad UA', () => {
    const enricher = createUserAgentEnricher();
    const ua = 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605 Mobile/15E148';
    const result = enricher(makeEvent(ua)) as any;
    expect(result.context.device).toBe('tablet');
  });

  it('preserves existing context fields', () => {
    const enricher = createUserAgentEnricher();
    const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0';
    const event = { ...makeEvent(ua), context: { userAgent: ua, userId: 'u1' } as any };
    const result = enricher(event) as any;
    expect(result.context.userId).toBe('u1');
    expect(result.context.browser).toBeDefined();
  });
});
