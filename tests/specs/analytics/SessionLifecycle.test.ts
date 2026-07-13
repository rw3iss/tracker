/**
 * @jest-environment jsdom
 */
import { SessionLifecycle } from '../../../src/analytics/SessionLifecycle';

describe('SessionLifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a session with number=1 on first access', () => {
    const s = new SessionLifecycle({ inactivityMs: 60_000 });
    const state = s.getState();
    expect(state.number).toBe(1);
    expect(state.id).toMatch(/^s_/);
  });

  it('reuses the same session on activity', () => {
    const s = new SessionLifecycle({ inactivityMs: 60_000 });
    const a = s.getSessionId();
    s.markActive();
    const b = s.getSessionId();
    expect(a).toBe(b);
  });

  it('rotates after inactivity', () => {
    const s = new SessionLifecycle({ inactivityMs: 1_000 });
    const a = s.getSessionId();
    jest.setSystemTime(Date.now() + 2_000);
    const b = s.getSessionId();
    expect(b).not.toBe(a);
    expect(s.getState().number).toBe(2);
  });

  it('rotate() forces a new session and emits hooks', () => {
    const ended: string[] = [];
    const started: string[] = [];
    const s = new SessionLifecycle({ inactivityMs: 60_000 });
    s.onSessionEnd = (state) => ended.push(state.id);
    s.onSessionStart = (state) => started.push(state.id);
    const first = s.getSessionId();   // emits onSessionStart (#1)
    s.rotate();                        // emits onSessionEnd + onSessionStart (#2)
    expect(ended).toEqual([first]);
    expect(started).toHaveLength(2);
    expect(started[0]).toBe(first);
    expect(started[1]).not.toBe(first);
  });

  it("'shared' mode persists in localStorage so other tabs see the same session", () => {
    const a = new SessionLifecycle({ multiTab: 'shared', inactivityMs: 60_000 });
    const id = a.getSessionId();
    // A second instance simulates a different tab's lifecycle reading the
    // same localStorage.
    const b = new SessionLifecycle({ multiTab: 'shared', inactivityMs: 60_000 });
    expect(b.getSessionId()).toBe(id);
  });

  it("'per-tab' mode uses sessionStorage — each tab independent", () => {
    const a = new SessionLifecycle({ multiTab: 'per-tab', inactivityMs: 60_000 });
    a.getSessionId();
    const stored = sessionStorage.length;
    expect(stored).toBeGreaterThan(0);
    // localStorage should NOT have a session entry in per-tab mode.
    let foundInLocal = false;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.includes('sess')) foundInLocal = true;
    }
    expect(foundInLocal).toBe(false);
  });
});
