/**
 * @jest-environment jsdom
 */
import { SessionManager } from '../../../src/emitter/SessionManager';

beforeEach(() => {
  sessionStorage.clear();
});

describe('SessionManager', () => {
  it('generates a new session ID on first access', () => {
    const mgr = new SessionManager();
    const id  = mgr.sessionId;
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns the same session ID on subsequent access', () => {
    const mgr = new SessionManager();
    expect(mgr.sessionId).toBe(mgr.sessionId);
  });

  it('persists session ID to sessionStorage', () => {
    const mgr = new SessionManager();
    const id  = mgr.sessionId;
    expect(sessionStorage.getItem('__vt_session__')).toBe(id);
  });

  it('reuses an existing session ID from sessionStorage', () => {
    sessionStorage.setItem('__vt_session__', 'existing-id');
    const mgr = new SessionManager();
    expect(mgr.sessionId).toBe('existing-id');
  });

  it('fires onSessionStart when a new session is created', () => {
    const onSessionStart = jest.fn();
    const mgr = new SessionManager({ hooks: { onSessionStart } });
    const id  = mgr.sessionId;
    expect(onSessionStart).toHaveBeenCalledWith(id);
  });

  it('does not fire onSessionStart when reusing an existing session', () => {
    sessionStorage.setItem('__vt_session__', 'reused-id');
    const onSessionStart = jest.fn();
    const mgr = new SessionManager({ hooks: { onSessionStart } });
    mgr.sessionId; // access it
    expect(onSessionStart).not.toHaveBeenCalled();
  });

  it('setSessionId overrides the session without firing hooks', () => {
    const onSessionStart = jest.fn();
    const mgr = new SessionManager({ hooks: { onSessionStart } });
    mgr.setSessionId('manual-id');
    expect(mgr.sessionId).toBe('manual-id');
    expect(onSessionStart).not.toHaveBeenCalled();
  });

  it('setSessionId persists the new id to sessionStorage', () => {
    const mgr = new SessionManager();
    mgr.setSessionId('custom-123');
    expect(sessionStorage.getItem('__vt_session__')).toBe('custom-123');
  });

  it('rotate() creates a new session and fires both lifecycle hooks', () => {
    const onSessionStart = jest.fn();
    const onSessionEnd   = jest.fn();
    const mgr = new SessionManager({ hooks: { onSessionStart, onSessionEnd } });

    const originalId = mgr.sessionId;
    onSessionStart.mockClear(); // clear the initial creation call

    const newId = mgr.rotate();

    expect(onSessionEnd).toHaveBeenCalledWith(originalId);
    expect(onSessionStart).toHaveBeenCalledWith(newId);
    expect(mgr.sessionId).toBe(newId);
    expect(newId).not.toBe(originalId);
  });

  it('destroy() fires onSessionEnd and clears sessionStorage', () => {
    const onSessionEnd = jest.fn();
    const mgr = new SessionManager({ hooks: { onSessionEnd } });
    const id  = mgr.sessionId;

    mgr.destroy();

    expect(onSessionEnd).toHaveBeenCalledWith(id);
    expect(sessionStorage.getItem('__vt_session__')).toBeNull();
  });

  it('supports a custom generateId function', () => {
    const generateId = jest.fn().mockReturnValue('custom-uuid');
    const mgr = new SessionManager({ generateId });
    expect(mgr.sessionId).toBe('custom-uuid');
    expect(generateId).toHaveBeenCalledTimes(1);
  });
});
