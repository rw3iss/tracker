import { EventMapper } from '../../../src/ga/core/EventMapper';
import type { TrackerEvent } from '../../../src/common/types';

const baseEvent = (over: Partial<TrackerEvent> = {}): TrackerEvent => ({
  type:      'event',
  message:   'page_view',
  timestamp: 1_000_000,
  ...over,
});

describe('EventMapper', () => {
  it('returns identity envelope by default', () => {
    const m = new EventMapper();
    const env = m.map(baseEvent({ payload: { foo: 'bar' } }));
    expect(env).toEqual({ name: 'page_view', params: { foo: 'bar' } });
  });

  it('filters via events allowlist', () => {
    const m = new EventMapper({ events: ['purchase', 'add_to_cart'] });
    expect(m.map(baseEvent({ message: 'page_view' }))).toBeNull();
    expect(m.map(baseEvent({ message: 'purchase', payload: { value: 1200 } }))?.name).toBe('purchase');
  });

  it('filters via predicate', () => {
    const m = new EventMapper({
      filter: (e) => e.category === 'ecommerce',
    });
    expect(m.map(baseEvent({ category: 'analytics' }))).toBeNull();
    expect(m.map(baseEvent({ category: 'ecommerce' }))?.name).toBe('page_view');
  });

  it('maps name and params', () => {
    const m = new EventMapper({
      mapName:   (msg) => msg === 'page_view' ? 'screen_view' : msg,
      mapParams: (e)   => ({ screen_class: 'Web', screen_name: e.payload?.page_path }),
    });
    const env = m.map(baseEvent({ payload: { page_path: '/home' } }));
    expect(env).toEqual({ name: 'screen_view', params: { screen_class: 'Web', screen_name: '/home' } });
  });

  it('returns null when mapName returns null', () => {
    const m = new EventMapper({ mapName: () => null });
    expect(m.map(baseEvent())).toBeNull();
  });

  it('stamps client_id / session_id / user_id from payload + context', () => {
    const m = new EventMapper();
    const env = m.map(baseEvent({
      payload: { client_id: 'v_1', session_id: 's_1' },
      context: { userId: 'u_1' },
    }));
    expect(env?.params).toEqual({
      client_id:  'v_1',
      session_id: 's_1',
      user_id:    'u_1',
    });
  });

  it("doesn't overwrite explicit identity already in params", () => {
    const m = new EventMapper({
      mapParams: (e) => ({
        client_id: 'override',
        ...e.payload,
      }),
    });
    const env = m.map(baseEvent({
      payload: { client_id: 'v_real' },
    }));
    // mapParams ran first; mapper preserves whatever's there.
    expect(env?.params.client_id).toBe('v_real');
  });
});
