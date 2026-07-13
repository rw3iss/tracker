/**
 * @jest-environment jsdom
 */
import { AnalyticsPlugin } from '../../../src/analytics/AnalyticsPlugin';
import type { TrackerContext } from '../../../src/common/types';

/**
 * Minimal `ITrackerClientRef` stub for plugin lifecycle tests.
 */
function makeStubClient(getCtx: () => TrackerContext = () => ({})) {
  const captured: unknown[] = [];
  return {
    captured,
    ref: {
      capture: (e: unknown) => captured.push(e),
      getContext: getCtx,
    },
  };
}

describe('AnalyticsPlugin — IIdentitySource conformance (GA bridge)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('exposes a snapshot() returning current clientId + sessionId', () => {
    const plugin = new AnalyticsPlugin({ pageViews: false, engagement: false });
    const stub   = makeStubClient();
    plugin.onInit(stub.ref);

    const snap = plugin.snapshot();
    expect(snap.clientId).toMatch(/^v_/);
    expect(snap.sessionId).toMatch(/^s_/);
    expect(snap.userId).toBeUndefined();      // anonymous

    plugin.onDestroy();
  });

  it('snapshot() picks up userId once setContext sets one', () => {
    let ctx: TrackerContext = {};
    const plugin = new AnalyticsPlugin({ pageViews: false, engagement: false });
    const stub   = makeStubClient(() => ctx);
    plugin.onInit(stub.ref);

    expect(plugin.snapshot().userId).toBeUndefined();

    // Simulate the host calling tracker.setContext({ userId: 'u_123' })
    ctx = { userId: 'u_123' };

    // Identity check polls every 1s — manually trigger via the public methods.
    // The simplest path: call snapshot() AFTER the polling tick happens.
    // Since the polling interval runs jest's fake timers if used, we go the
    // other way: trigger the change via re-calling onInit's polling logic.
    // Public API alternative: just call snapshot() — it reads getContext()
    // through the internal lastSeenUserId, which is updated by the polling
    // tick. We can verify the surface contract by waiting for one tick.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const snap = plugin.snapshot();
        expect(snap.userId).toBe('u_123');
        plugin.onDestroy();
        resolve();
      }, 1100);
    });
  }, 5_000);

  it('returns the same identity across calls (stable)', () => {
    const plugin = new AnalyticsPlugin({ pageViews: false, engagement: false });
    const stub   = makeStubClient();
    plugin.onInit(stub.ref);

    const a = plugin.snapshot();
    const b = plugin.snapshot();
    expect(a.clientId).toBe(b.clientId);
    expect(a.sessionId).toBe(b.sessionId);

    plugin.onDestroy();
  });
});
