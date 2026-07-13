/**
 * @jest-environment jsdom
 */
import { TrackerClient, tracker } from '../../../src/emitter/index';
import type { TrackerEvent } from '../../../src/common/types';

const ENDPOINT = 'http://localhost/tracker/events';

function setup(overrides: Partial<Parameters<typeof TrackerClient.init>[0]> = {}) {
  return TrackerClient.init({
    endpoint: ENDPOINT,
    appId: 'test-app',
    queue: { flushInterval: 999999 }, // disable auto-flush; use manual flush
    retry: { maxAttempts: 1, baseDelay: 0, backoffFactor: 1 },
    _delay: () => Promise.resolve(),
    ...overrides,
  } as any);
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn().mockResolvedValue({ ok: true });
  global.fetch = fetchMock;
  localStorage.clear();
});

afterEach(() => {
  tracker.destroy();
});

describe('TrackerClient', () => {
  it('init() configures and returns the singleton', () => {
    const client = setup();
    expect(client).toBe(tracker);
  });

  it('init() with no endpoint falls back to the public tracker ingest URL', async () => {
    // Previously threw; now defaults so a fresh `init({ appId })`
    // still ships events somewhere useful.
    TrackerClient.init({
      appId: 'test-app',
      queue: { flushInterval: 999999 },
      retry: { maxAttempts: 1, baseDelay: 0, backoffFactor: 1 },
      _delay: () => Promise.resolve(),
    } as any);
    tracker.capture({ type: 'info', message: 'hello' });
    await tracker.flush();
    const calledUrl = fetchMock.mock.calls[0]?.[0];
    expect(calledUrl).toBe('https://tracker.ryanweiss.net/ingest/events');
  });

  it('init() with empty-string endpoint also falls back to the default', async () => {
    TrackerClient.init({
      endpoint: '',
      appId:    'test-app',
      queue:    { flushInterval: 999999 },
      retry:    { maxAttempts: 1, baseDelay: 0, backoffFactor: 1 },
      _delay:   () => Promise.resolve(),
    } as any);
    tracker.capture({ type: 'info', message: 'hello' });
    await tracker.flush();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://tracker.ryanweiss.net/ingest/events');
  });

  it('capture() auto-stamps timestamp and appId', async () => {
    setup();
    tracker.capture({ type: 'info', message: 'hello' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].timestamp).toBeGreaterThan(0);
    expect(body[0].appId).toBe('test-app');
    expect(body[0].message).toBe('hello');
  });

  it('setContext() merges into every event', async () => {
    setup();
    tracker.setContext({ userId: 'u42', sessionId: 'sess1' });
    tracker.capture({ type: 'event', message: 'click' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].context?.userId).toBe('u42');
    expect(body[0].context?.sessionId).toBe('sess1');
  });

  it('clearContext() stops context from being merged', async () => {
    setup();
    tracker.setContext({ userId: 'u42' });
    tracker.clearContext();
    tracker.capture({ type: 'info', message: 'no context' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].context?.userId).toBeUndefined();
  });

  it('error() serialises Error into event.error', async () => {
    setup();
    tracker.error(new TypeError('bad type'));
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].type).toBe('error');
    expect(body[0].error?.name).toBe('TypeError');
    expect(body[0].error?.message).toBe('bad type');
    expect(body[0].error?.stack).toBeDefined();
  });

  it('error() carries the wrapped-cause chain to the wire', async () => {
    setup();
    const root  = new Error('root');
    const outer = Object.assign(new Error('outer'), { cause: root });
    tracker.error(outer);
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].error?.previous).toHaveLength(1);
    expect(body[0].error?.previous?.[0].message).toBe('root');
  });

  it("errorEnrichment: 'minimal' (and false) strip file/line/code/previous", async () => {
    for (const mode of ['minimal' as const, false as const]) {
      setup({ errorEnrichment: mode });
      const root  = new Error('root');
      const outer = Object.assign(new Error('outer'), { cause: root, code: 'XYZ' });
      tracker.error(outer);
      await tracker.flush();
      const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
      expect(body[0].error?.name).toBe('Error');
      expect(body[0].error?.message).toBe('outer');
      expect(body[0].error?.stack).toBeDefined();
      expect(body[0].error?.file).toBeUndefined();
      expect(body[0].error?.code).toBeUndefined();
      expect(body[0].error?.previous).toBeUndefined();
    }
  });

  it('errorEnrichment object: can drop previous-chain only and keep file/line/code', async () => {
    setup({ errorEnrichment: { previous: false } });
    const root  = new Error('root');
    const outer = Object.assign(new Error('outer'), { cause: root, code: 'XYZ' });
    outer.stack = 'Error: outer\n    at fn (/app/src/x.ts:10:5)';
    tracker.error(outer);
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].error?.previous).toBeUndefined();
    expect(body[0].error?.file).toBe('/app/src/x.ts');
    expect(body[0].error?.line).toBe(10);
    expect(body[0].error?.code).toBe('XYZ');
  });

  it('warn() creates a warning event', async () => {
    setup();
    tracker.warn('deprecated call', { fn: 'foo' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].type).toBe('warning');
    expect(body[0].payload).toEqual({ fn: 'foo' });
  });

  it('info() creates an info event', async () => {
    setup();
    tracker.info('user signed in');
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].type).toBe('info');
  });

  it('event() creates an event with name as message', async () => {
    setup();
    tracker.event('order.completed', { orderId: '99' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].type).toBe('event');
    expect(body[0].message).toBe('order.completed');
    expect(body[0].payload).toEqual({ orderId: '99' });
  });

  it('enrichers run in order before enqueue', async () => {
    setup({
      enrichers: [
        (e) => ({ ...e, tags: [...(e.tags ?? []), 'enriched'] }),
        (e) => ({ ...e, tags: [...(e.tags ?? []), 'second'] }),
      ],
    });
    tracker.capture({ type: 'info', message: 'test' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].tags).toEqual(['enriched', 'second']);
  });

  it('flush() sends nothing when queue is empty', async () => {
    setup();
    await tracker.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('destroy() stops the flush interval — no calls after destroy', async () => {
    jest.useFakeTimers();
    setup({ queue: { flushInterval: 1000 } });
    tracker.destroy();
    jest.advanceTimersByTime(5000);
    expect(fetchMock).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('drains localStorage queue on init', async () => {
    const stored = [{ type: 'error', message: 'persisted', timestamp: 1, appId: 'test-app' }];
    localStorage.setItem('__vt_queue__', JSON.stringify(stored));
    setup();
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.some((e) => e.message === 'persisted')).toBe(true);
    expect(localStorage.getItem('__vt_queue__')).toBeNull();
  });
});

describe('TrackerClient — session tracking', () => {
  beforeEach(() => {
    // Prevent context from leaking between tests since configure() does not reset it
    tracker.clearContext();
    sessionStorage.clear();
  });

  afterEach(() => {
    tracker.destroy();
    sessionStorage.clear();
  });

  it('injects a sessionId into every event context when sessionTracking is enabled', async () => {
    setup();
    tracker.capture({ type: 'info', message: 'hello' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(typeof body[0].context?.sessionId).toBe('string');
    expect((body[0].context?.sessionId as string).length).toBeGreaterThan(0);
  });

  it('does not inject sessionId when sessionTracking is false', async () => {
    setup({ sessionTracking: false });
    tracker.capture({ type: 'info', message: 'hello' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    // sessionId may be undefined or absent
    expect(body[0].context?.sessionId).toBeUndefined();
  });

  it('setContext({ sessionId }) overrides the auto-generated session ID', async () => {
    setup();
    tracker.setContext({ sessionId: 'custom-session' });
    tracker.capture({ type: 'event', message: 'click' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].context?.sessionId).toBe('custom-session');
  });

  it('setSessionId() updates the session ID used in subsequent events', async () => {
    setup();
    tracker.setSessionId('auth-session-xyz');
    tracker.capture({ type: 'event', message: 'login' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].context?.sessionId).toBe('auth-session-xyz');
  });

  it('uses a custom sessionId provided in config', async () => {
    setup({ sessionTracking: { sessionId: 'cfg-session' } });
    tracker.capture({ type: 'info', message: 'test' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].context?.sessionId).toBe('cfg-session');
  });
});

describe('TrackerClient — enabled flag', () => {
  afterEach(() => { tracker.destroy(); });

  it('enabled: false makes all capture methods no-ops', async () => {
    setup({ enabled: false });
    tracker.capture({ type: 'error', message: 'should not send' });
    tracker.error(new Error('nope'));
    tracker.warn('nope');
    tracker.info('nope');
    tracker.debug('nope');
    tracker.event('nope');
    tracker.track('nope');
    await tracker.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isEnabled reflects the enabled state', () => {
    setup({ enabled: false });
    expect(tracker.isEnabled).toBe(false);
  });

  it('isEnabled is true by default', () => {
    setup();
    expect(tracker.isEnabled).toBe(true);
  });
});

describe('TrackerClient — minLevel filtering', () => {
  afterEach(() => { tracker.destroy(); });

  it('drops events below minLevel', async () => {
    setup({ minLevel: 'warning' });
    tracker.capture({ type: 'info', message: 'below threshold' });
    tracker.capture({ type: 'debug', message: 'way below' });
    tracker.capture({ type: 'warning', message: 'at threshold' });
    tracker.capture({ type: 'error', message: 'above threshold' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toHaveLength(2);
    expect(body[0].type).toBe('warning');
    expect(body[1].type).toBe('error');
  });

  it('always allows type "event" regardless of minLevel', async () => {
    setup({ minLevel: 'error' });
    tracker.event('page_view');
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toHaveLength(1);
    expect(body[0].type).toBe('event');
  });
});

describe('TrackerClient — beforeSend', () => {
  afterEach(() => { tracker.destroy(); });

  it('drops event when beforeSend returns null', async () => {
    setup({ beforeSend: () => null });
    tracker.capture({ type: 'info', message: 'dropped' });
    await tracker.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows modifying the event in beforeSend', async () => {
    setup({ beforeSend: (e) => ({ ...e, tags: ['filtered'] }) });
    tracker.capture({ type: 'info', message: 'test' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].tags).toEqual(['filtered']);
  });
});

describe('TrackerClient — debug() and track() methods', () => {
  afterEach(() => { tracker.destroy(); });

  it('debug() creates a debug-level event', async () => {
    setup();
    tracker.debug('state mismatch', { expected: 5, got: 3 });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].type).toBe('debug');
    expect(body[0].payload).toEqual({ expected: 5, got: 3 });
  });

  it('track() auto-extracts category from colon-delimited name', async () => {
    setup();
    tracker.track('auction:stale-state', { auctionId: 123 });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].type).toBe('event');
    expect(body[0].message).toBe('auction:stale-state');
    expect(body[0].category).toBe('auction');
    expect(body[0].payload).toEqual({ auctionId: 123 });
  });

  it('track() with no colon does not set category', async () => {
    setup();
    tracker.track('simple-event');
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].category).toBeUndefined();
  });

  it('track() accepts a custom type override', async () => {
    setup();
    tracker.track('order:failed', { orderId: 1 }, 'error');
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].type).toBe('error');
  });
});

describe('TrackerClient — globalName', () => {
  afterEach(() => { tracker.destroy(); });

  it('exposes the tracker on the global namespace', () => {
    setup({ globalName: '__test_tracker__' });
    expect((globalThis as any).__test_tracker__).toBe(tracker);
  });

  it('removes the global on destroy', async () => {
    setup({ globalName: '__test_tracker__' });
    await tracker.destroy();
    expect((globalThis as any).__test_tracker__).toBeUndefined();
  });
});

describe('TrackerClient — destroy() flushes', () => {
  afterEach(() => { tracker.destroy(); });

  it('flushes pending events on destroy', async () => {
    setup();
    tracker.capture({ type: 'info', message: 'pending' });
    await tracker.destroy();
    expect(fetchMock).toHaveBeenCalled();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].message).toBe('pending');
  });
});

describe('TrackerClient — getConfig()', () => {
  afterEach(() => { tracker.destroy(); });

  it('returns the current config', () => {
    setup({ appId: 'my-app' });
    const config = tracker.getConfig();
    expect(config?.appId).toBe('my-app');
    expect(config?.endpoint).toBe(ENDPOINT);
  });
});

describe('TrackerClient — custom transport', () => {
  afterEach(() => { tracker.destroy(); });

  it('routes events through transport.send() instead of HTTP', async () => {
    const sent: TrackerEvent[][] = [];
    const transport = { send: jest.fn(async (events: TrackerEvent[]) => { sent.push(events); }) };
    setup({ transport, endpoint: undefined } as any);
    tracker.capture({ type: 'info', message: 'via transport' });
    // Transport is called synchronously (no queue), but send is async
    await new Promise(r => setTimeout(r, 0));
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(sent[0][0].message).toBe('via transport');
    expect(sent[0][0].appId).toBe('test-app');
    // HTTP fetch should NOT have been called
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still applies enrichers before transport', async () => {
    const sent: TrackerEvent[][] = [];
    const transport = { send: jest.fn(async (events: TrackerEvent[]) => { sent.push(events); }) };
    setup({
      transport,
      endpoint: undefined,
      enrichers: [(e: TrackerEvent) => ({ ...e, tags: ['enriched'] })],
    } as any);
    tracker.capture({ type: 'info', message: 'test' });
    await new Promise(r => setTimeout(r, 0));
    expect(sent[0][0].tags).toEqual(['enriched']);
  });

  it('still applies beforeSend before transport', async () => {
    const transport = { send: jest.fn(async () => {}) };
    setup({
      transport,
      endpoint: undefined,
      beforeSend: () => null, // drop everything
    } as any);
    tracker.capture({ type: 'info', message: 'dropped' });
    await new Promise(r => setTimeout(r, 0));
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('calls transport.start() on init and transport.stop() on destroy', async () => {
    const transport = {
      send: jest.fn(async () => {}),
      start: jest.fn(),
      stop: jest.fn(),
    };
    setup({ transport, endpoint: undefined } as any);
    expect(transport.start).toHaveBeenCalledTimes(1);
    await tracker.destroy();
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });

  it('calls transport.flush() on flush()', async () => {
    const transport = {
      send: jest.fn(async () => {}),
      flush: jest.fn(async () => {}),
    };
    setup({ transport, endpoint: undefined } as any);
    await tracker.flush();
    expect(transport.flush).toHaveBeenCalledTimes(1);
  });

  // (Previous "throws if neither endpoint nor transport is provided"
  // test removed: an empty endpoint now falls back to the public
  // tracker ingest URL — see the two endpoint-fallback tests near the
  // top of this describe block.)
});

describe('TrackerClient — client-side rate limiting', () => {
  beforeEach(() => {
    tracker.clearContext();
    sessionStorage.clear();
  });

  afterEach(() => {
    tracker.destroy();
    sessionStorage.clear();
  });

  it('drops events that exceed the per-type rate limit', async () => {
    setup({
      rateLimit: {
        error: { capacity: 2, refillPerSec: 0 },
        summaryIntervalMs: 0,
      },
    });

    tracker.capture({ type: 'error', message: 'err1' });
    tracker.capture({ type: 'error', message: 'err2' });
    tracker.capture({ type: 'error', message: 'err3' }); // dropped

    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    const errors = body.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(2);
  });

  it('does not affect event types without a rate limit configured', async () => {
    setup({
      rateLimit: {
        error: { capacity: 1, refillPerSec: 0 },
        summaryIntervalMs: 0,
      },
    });

    tracker.capture({ type: 'info', message: 'info1' });
    tracker.capture({ type: 'info', message: 'info2' });
    tracker.capture({ type: 'info', message: 'info3' });

    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    const infos = body.filter((e) => e.type === 'info');
    expect(infos).toHaveLength(3);
  });

  it('emits a summary event on destroy when events were dropped', async () => {
    setup({
      rateLimit: {
        error: { capacity: 1, refillPerSec: 0 },
        summaryIntervalMs: 0,
      },
    });

    tracker.capture({ type: 'error', message: 'err1' }); // ok
    tracker.capture({ type: 'error', message: 'err2' }); // dropped

    // destroy() calls rateLimiter.stop() which emits the summary, then flushes
    await tracker.destroy();

    // collect all events sent across all fetch calls
    const allEvents = fetchMock.mock.calls.flatMap(([, opts]: [string, RequestInit]) =>
      JSON.parse(opts.body as string) as TrackerEvent[],
    );
    const summaryEvent = allEvents.find((e) => e.category === 'tracker:rate-limit');
    expect(summaryEvent).toBeDefined();
    expect(summaryEvent?.payload?.dropped).toMatchObject({ error: 1 });
  });
});

describe('TrackerClient contextEnrichment', () => {
  beforeEach(() => {
    // jsdom defaults: window.location.href = 'http://localhost/', innerWidth = 1024
    Object.defineProperty(window, 'innerWidth',  { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720  });
    Object.defineProperty(screen, 'width',       { configurable: true, value: 1920 });
    Object.defineProperty(screen, 'height',      { configurable: true, value: 1080 });
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
    Object.defineProperty(document, 'referrer',  { configurable: true, value: 'http://example.com/prev' });
  });

  it('default (true): stamps the standard set — no referrer/screen/connection', async () => {
    setup();
    tracker.capture({ type: 'info', message: 'enriched' });
    await tracker.flush();
    const ctx = JSON.parse(fetchMock.mock.calls[0][1].body)[0].context!;
    // standard set
    expect(ctx.url).toBeDefined();
    expect(ctx.path).toBeDefined();
    expect(ctx.userAgent).toBeDefined();
    expect(ctx.language).toBe('en-US');
    expect(ctx.timezone).toBeDefined();
    expect(ctx.viewport).toEqual({ width: 1280, height: 720 });
    // not-in-standard
    expect(ctx.screen).toBeUndefined();
    expect(ctx.referrer).toBeUndefined();
  });

  it("'full': adds referrer + screen + connection on top of standard", async () => {
    setup({ contextEnrichment: 'full' });
    tracker.capture({ type: 'info', message: 'enriched' });
    await tracker.flush();
    const ctx = JSON.parse(fetchMock.mock.calls[0][1].body)[0].context!;
    expect(ctx.screen).toEqual({ width: 1920, height: 1080 });
    expect(ctx.referrer).toBe('http://example.com/prev');
  });

  it("'minimal': only url + path", async () => {
    setup({ contextEnrichment: 'minimal' });
    tracker.capture({ type: 'info', message: 'bare-ish' });
    await tracker.flush();
    const ctx = JSON.parse(fetchMock.mock.calls[0][1].body)[0].context!;
    expect(ctx.url).toBeDefined();
    expect(ctx.path).toBeDefined();
    expect(ctx.userAgent).toBeUndefined();
    expect(ctx.language).toBeUndefined();
    expect(ctx.timezone).toBeUndefined();
    expect(ctx.viewport).toBeUndefined();
  });

  it('false drops every browser field', async () => {
    setup({ contextEnrichment: false });
    tracker.capture({ type: 'info', message: 'bare' });
    await tracker.flush();
    const ctx = JSON.parse(fetchMock.mock.calls[0][1].body)[0].context!;
    expect(ctx.url).toBeUndefined();
    expect(ctx.path).toBeUndefined();
    expect(ctx.userAgent).toBeUndefined();
    expect(ctx.language).toBeUndefined();
    expect(ctx.timezone).toBeUndefined();
    expect(ctx.viewport).toBeUndefined();
    expect(ctx.screen).toBeUndefined();
    expect(ctx.referrer).toBeUndefined();
  });

  it('object: per-field overrides layered on the standard set', async () => {
    setup({ contextEnrichment: { userAgent: false, viewport: false } });
    tracker.capture({ type: 'info', message: 'partial' });
    await tracker.flush();
    const ctx = JSON.parse(fetchMock.mock.calls[0][1].body)[0].context!;
    // dropped from standard
    expect(ctx.userAgent).toBeUndefined();
    expect(ctx.viewport).toBeUndefined();
    // still on (standard)
    expect(ctx.url).toBeDefined();
    expect(ctx.path).toBeDefined();
    expect(ctx.language).toBe('en-US');
    // not-in-standard, still off
    expect(ctx.screen).toBeUndefined();
  });

  it('object: can opt INTO non-standard fields like referrer/screen', async () => {
    setup({ contextEnrichment: { referrer: true, screen: true } });
    tracker.capture({ type: 'info', message: 'extras' });
    await tracker.flush();
    const ctx = JSON.parse(fetchMock.mock.calls[0][1].body)[0].context!;
    expect(ctx.referrer).toBe('http://example.com/prev');
    expect(ctx.screen).toEqual({ width: 1920, height: 1080 });
    // standard still on
    expect(ctx.userAgent).toBeDefined();
  });

  it('setContext() values override auto-enriched values', async () => {
    setup();
    tracker.setContext({ userAgent: 'custom-ua/1.0', language: 'fr-FR' });
    tracker.capture({ type: 'info', message: 'override' });
    await tracker.flush();
    const ctx = JSON.parse(fetchMock.mock.calls[0][1].body)[0].context!;
    expect(ctx.userAgent).toBe('custom-ua/1.0');
    expect(ctx.language).toBe('fr-FR');
    // Non-overridden auto fields still present
    expect(ctx.url).toBeDefined();
  });

  it('omits referrer when document.referrer is empty', async () => {
    Object.defineProperty(document, 'referrer', { configurable: true, value: '' });
    setup();
    tracker.capture({ type: 'info', message: 'no-ref' });
    await tracker.flush();
    const ctx = JSON.parse(fetchMock.mock.calls[0][1].body)[0].context!;
    expect(ctx.referrer).toBeUndefined();
  });
});

describe('TrackerClient — dedup bypass policy', () => {
  it('stamps dedup=false on events whose message starts with bypassMessages prefix', async () => {
    setup({ dedup: { bypassMessages: ['bid.'] } });
    tracker.capture({ type: 'event', message: 'bid.place_committed' });
    tracker.capture({ type: 'info',  message: 'unrelated' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].dedup).toBe(false);
    expect(body[1].dedup).toBeUndefined();
  });

  it('exact match in bypassMessages also stamps dedup=false', async () => {
    setup({ dedup: { bypassMessages: ['heartbeat'] } });
    tracker.capture({ type: 'info', message: 'heartbeat' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].dedup).toBe(false);
  });

  it('bypassPredicate stamps dedup=false when it returns true', async () => {
    setup({ dedup: { bypassPredicate: (e) => e.type === 'event' } });
    tracker.capture({ type: 'event', message: 'page_view' });
    tracker.capture({ type: 'error', message: 'oops' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].dedup).toBe(false);
    expect(body[1].dedup).toBeUndefined();
  });

  it('bypassPredicate that throws does not block capture', async () => {
    setup({ dedup: { bypassPredicate: () => { throw new Error('boom'); } } });
    tracker.capture({ type: 'info', message: 'still works' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].message).toBe('still works');
    expect(body[0].dedup).toBeUndefined();
  });

  it('explicit per-call event.dedup wins over the policy', async () => {
    setup({ dedup: { bypassMessages: ['bid.'] } });
    // Even though 'bid.' would normally trigger bypass, an explicit
    // dedup: true at the call site means "I want dedup to run on this one"
    tracker.capture({ type: 'event', message: 'bid.place_committed', dedup: true });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].dedup).toBe(true);
  });

  it('no dedup config = no stamping', async () => {
    setup();
    tracker.capture({ type: 'event', message: 'bid.place_committed' });
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].dedup).toBeUndefined();
  });

  it('bypassMessages and bypassPredicate compose with OR', async () => {
    setup({
      dedup: {
        bypassMessages:  ['bid.'],
        bypassPredicate: (e) => e.type === 'event',
      },
    });
    tracker.capture({ type: 'info',  message: 'bid.place_committed' }); // matches messages
    tracker.capture({ type: 'event', message: 'page_view' });          // matches predicate
    tracker.capture({ type: 'info',  message: 'random' });             // matches neither
    await tracker.flush();
    const body: TrackerEvent[] = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].dedup).toBe(false);
    expect(body[1].dedup).toBe(false);
    expect(body[2].dedup).toBeUndefined();
  });
});
