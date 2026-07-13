/**
 * @jest-environment jsdom
 *
 * Tests for the post-load readiness watchdog. The watchdog is what surfaces
 * common silent-failure modes (DNT, tracking protection, ad blockers) that
 * gtag.js itself doesn't log or throw on.
 */

import { GtagAdapter } from '../../../src/ga/adapters/GtagAdapter';

describe('GtagAdapter readiness watchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    delete (window as unknown as Record<string, unknown>).dataLayer;
    delete (window as unknown as Record<string, unknown>).gtag;
    delete (window as unknown as Record<string, unknown>).google_tag_manager;
    // Insert a stub script element so the adapter doesn't actually try to
    // load gtag.js from googletagmanager.com in jsdom (which would error).
    const existing = document.querySelectorAll('script[src*="googletagmanager"]');
    existing.forEach(s => s.remove());
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("times out with 'init' reason when gtag.js never wires up", async () => {
    const adapter = new GtagAdapter({ skipInject: true, readinessTimeoutMs: 1_000 });
    // skipInject: true means the readiness check is skipped — for this test
    // we want it to actually run, so wire init manually:
    const adapter2 = new GtagAdapter({ readinessTimeoutMs: 1_000 });
    // Pretend the script is already in the DOM so injectScript() short-circuits
    const script = document.createElement('script');
    script.src = 'https://www.googletagmanager.com/gtag/js?id=G-X';
    document.head.appendChild(script);
    await adapter2.init(['G-X'], {});

    jest.advanceTimersByTime(1_500);
    await Promise.resolve();
    await Promise.resolve();
    const status = await adapter2.ready();
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/did not initialize/);
    expect(status.detail?.measurementId).toBe('G-X');
    expect(adapter).toBeDefined(); // silence the unused-var lint
  });

  it("times out with 'hit' reason when gtag.js initializes but no collect fires", async () => {
    const adapter = new GtagAdapter({ readinessTimeoutMs: 1_000 });
    const script = document.createElement('script');
    script.src = 'https://www.googletagmanager.com/gtag/js?id=G-Y';
    document.head.appendChild(script);
    await adapter.init(['G-Y'], {});

    // Simulate gtag.js wiring up — it sets google_tag_manager[id]
    (window as unknown as Window).google_tag_manager = { 'G-Y': {} };

    // No PerformanceObserver entries firing — hit signal stays false.
    jest.advanceTimersByTime(1_500);
    await Promise.resolve();
    await Promise.resolve();
    const status = await adapter.ready();
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/initialized but no \/g\/collect/);
    expect(status.detail?.initObserved).toBe(true);
    expect(status.detail?.hitObserved).toBe(false);
  });

  it('skipInject mode resolves immediately as ok', async () => {
    const adapter = new GtagAdapter({ skipInject: true });
    await adapter.init(['G-Z'], {});
    const status = await adapter.ready();
    expect(status.ok).toBe(true);
  });

  it('emits a console.warn when DNT is enabled at construction', () => {
    const original = (navigator as unknown as { doNotTrack?: string }).doNotTrack;
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    new GtagAdapter();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('navigator.doNotTrack is enabled'),
    );
    Object.defineProperty(navigator, 'doNotTrack', { value: original, configurable: true });
    warnSpy.mockRestore();
  });

  it('calls opts.onReady with the final status', async () => {
    const onReady = jest.fn();
    const adapter = new GtagAdapter({ readinessTimeoutMs: 500, onReady });
    const script = document.createElement('script');
    script.src = 'https://www.googletagmanager.com/gtag/js?id=G-Q';
    document.head.appendChild(script);
    await adapter.init(['G-Q'], {});

    jest.advanceTimersByTime(800);
    await Promise.resolve();
    await Promise.resolve();
    await adapter.ready();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0][0].ok).toBe(false);
  });
});
