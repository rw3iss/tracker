/**
 * @jest-environment jsdom
 */
import { ConsentGate } from '../../../src/analytics/ConsentGate';

describe('ConsentGate', () => {
  it('is open by default when not required', () => {
    const g = new ConsentGate(undefined, true);
    expect(g.isOpen()).toBe(true);
  });

  it('is closed until granted when required', () => {
    const g = new ConsentGate({ required: true }, true);
    expect(g.isOpen()).toBe(false);
    g.grant();
    expect(g.isOpen()).toBe(true);
  });

  it('honors granted predicate', () => {
    let granted = false;
    const g = new ConsentGate({ required: true, granted: () => granted }, true);
    expect(g.isOpen()).toBe(false);
    granted = true;
    expect(g.isOpen()).toBe(true);
  });

  it('replays deferred fns on grant — once, in order', () => {
    const g = new ConsentGate({ required: true }, true);
    const fired: string[] = [];
    g.defer(() => fired.push('a'));
    g.defer(() => fired.push('b'));
    expect(fired).toEqual([]);
    g.grant();
    expect(fired).toEqual(['a', 'b']);
    // Replays only once.
    g.grant();
    expect(fired).toEqual(['a', 'b']);
  });

  it('drops deferred fns on revoke', () => {
    const g = new ConsentGate({ required: true }, true);
    let fired = 0;
    g.defer(() => fired++);
    g.revoke();
    g.grant();              // does nothing — gate is permanently revoked
    expect(fired).toBe(0);
  });

  it('async waitFor grants when predicate resolves true', async () => {
    let resolveFn: (v: unknown) => void = () => undefined;
    let allowed = false;
    const wait = new Promise((res) => { resolveFn = res; });
    const g = new ConsentGate({ required: true, waitFor: wait, granted: () => allowed }, true);
    expect(g.isOpen()).toBe(false);
    allowed = true;       // simulate user clicking "accept" — predicate flips
    resolveFn(undefined);
    await wait;
    await Promise.resolve(); await Promise.resolve();
    expect(g.isOpen()).toBe(true);
  });

  it('respects DNT — closed even when consent grants', () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    const g = new ConsentGate({ required: true }, true);
    g.grant();
    expect(g.isOpen()).toBe(false);
    Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
  });
});
