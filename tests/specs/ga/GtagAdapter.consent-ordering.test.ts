/**
 * @jest-environment jsdom
 *
 * Regression test for the consent-ordering bug found during the dev-alt
 * Astro integration: `GoogleAnalyticsPlugin` calls
 * `gtag('consent', 'default', ...)` synchronously when `GaCore` constructs
 * (via `ConsentManager.subscribe` → default replay). Before the fix, the
 * adapter's `gtag` wrapper called `window.gtag?.(...)`, which short-circuited
 * because `window.gtag` wasn't installed until `adapter.init()` ran later
 * — so the consent default never made it into `dataLayer`.
 *
 * The fix: `GtagAdapter`'s constructor now sets up `window.dataLayer` and
 * the `gtag` stub eagerly, mirroring the canonical Google install snippet.
 */

import { GtagAdapter } from '../../../src/ga/adapters/GtagAdapter';

describe('GtagAdapter consent ordering', () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).dataLayer;
    delete (window as unknown as Record<string, unknown>).gtag;
  });

  it('sets up window.dataLayer + gtag stub at construction time', () => {
    const w = window as unknown as { dataLayer?: unknown[]; gtag?: unknown };
    expect(w.dataLayer).toBeUndefined();
    expect(w.gtag).toBeUndefined();

    new GtagAdapter();
    expect(Array.isArray(w.dataLayer)).toBe(true);
    expect(typeof w.gtag).toBe('function');
    expect(w.dataLayer).toHaveLength(0);
  });

  it('captures consent calls made before init() in dataLayer', async () => {
    const adapter = new GtagAdapter({ skipInject: true });
    // Caller (GaCore) issues consent default before init runs:
    adapter.consent('default', { analytics_storage: 'granted', ad_storage: 'denied' });

    const w = window as unknown as { dataLayer: unknown[][] };
    expect(w.dataLayer).toHaveLength(1);
    const [cmd, op, state] = w.dataLayer[0];
    expect(cmd).toBe('consent');
    expect(op).toBe('default');
    expect(state).toEqual({ analytics_storage: 'granted', ad_storage: 'denied' });
  });

  it('preserves the canonical order: consent default → js → config', async () => {
    const adapter = new GtagAdapter({ skipInject: true });
    adapter.consent('default', { analytics_storage: 'granted' });
    await adapter.init(['G-TESTID'], { debug_mode: true });

    const w = window as unknown as { dataLayer: unknown[][] };
    const cmds = w.dataLayer.map(entry => entry[0]);
    expect(cmds).toEqual(['consent', 'js', 'config']);
  });

  it("doesn't clobber an existing host dataLayer / gtag", () => {
    const w = window as unknown as { dataLayer: unknown[]; gtag: (...args: unknown[]) => void };
    w.dataLayer = [['existing-entry']];
    let captured: unknown[] | null = null;
    w.gtag = (...args: unknown[]) => { captured = args; };

    new GtagAdapter();

    expect(w.dataLayer).toEqual([['existing-entry']]);
    w.gtag('test', 1);
    expect(captured).toEqual(['test', 1]);
  });
});
