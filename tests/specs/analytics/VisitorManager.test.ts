/**
 * @jest-environment jsdom
 */
import { VisitorManager } from '../../../src/analytics/VisitorManager';

describe('VisitorManager', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('generates a v_-prefixed id on first call', () => {
    const v = new VisitorManager({ storage: 'localStorage' });
    const id = v.getId();
    expect(id).toMatch(/^v_[a-z0-9-]+$/i);
  });

  it('persists across instantiations', () => {
    const a = new VisitorManager({ storage: 'localStorage' });
    const id = a.getId();
    const b = new VisitorManager({ storage: 'localStorage' });
    expect(b.getId()).toBe(id);
  });

  it('reports first-visit exactly once', () => {
    const v = new VisitorManager({ storage: 'localStorage' });
    expect(v.isFirstVisit()).toBe(false);
    v.getId();
    expect(v.isFirstVisit()).toBe(true);
    expect(v.isFirstVisit()).toBe(false);
  });

  it('reset() clears storage and creates a new id', () => {
    const v = new VisitorManager({ storage: 'localStorage' });
    const oldId = v.getId();
    v.reset();
    const newId = v.getId();
    expect(newId).not.toBe(oldId);
    expect(v.isFirstVisit()).toBe(true);
  });

  it('memory mode does not persist', () => {
    const a = new VisitorManager({ storage: 'memory' });
    const idA = a.getId();
    const b = new VisitorManager({ storage: 'memory' });
    expect(b.getId()).not.toBe(idA);
  });

  it('sessionStorage mode persists across instantiations within the tab', () => {
    const a = new VisitorManager({ storage: 'sessionStorage' });
    const idA = a.getId();
    const b = new VisitorManager({ storage: 'sessionStorage' });
    expect(b.getId()).toBe(idA);
  });
});
