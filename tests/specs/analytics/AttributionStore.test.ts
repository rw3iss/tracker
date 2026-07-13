/**
 * @jest-environment jsdom
 */
import { AttributionStore } from '../../../src/analytics/AttributionStore';

const setLocation = (search: string): void => {
  // jsdom restricts replaceState to the current origin. Default origin is
  // http://localhost/ — keep that prefix and only vary the search string.
  const url = `${location.protocol}//${location.host}/page${search.startsWith('?') || search === '' ? search : `?${search}`}`;
  window.history.replaceState({}, '', url);
};

describe('AttributionStore', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    Object.defineProperty(document, 'referrer', { value: '', configurable: true });
  });

  it('captures configured UTM params from URL', () => {
    setLocation('?utm_source=newsletter&utm_medium=email&random=ignored');
    const a = new AttributionStore({ params: ['utm_source', 'utm_medium'] }, false);
    const captured = a.captureForNewSession();
    expect(captured).toEqual({
      utm_source: 'newsletter',
      utm_medium: 'email',
    });
  });

  it('captures referrer when enabled', () => {
    setLocation('');
    Object.defineProperty(document, 'referrer', { value: 'https://google.com/search?q=foo', configurable: true });
    const a = new AttributionStore(undefined, true);
    const captured = a.captureForNewSession();
    expect(captured.page_referrer).toBe('https://google.com/search?q=foo');
  });

  it('skips referrer when host is in ignoreReferrers', () => {
    Object.defineProperty(document, 'referrer', { value: 'https://staging.example.com/page', configurable: true });
    const a = new AttributionStore(undefined, true, ['staging.example.com']);
    const captured = a.captureForNewSession();
    expect(captured.page_referrer).toBeUndefined();
  });

  it('persists for session across instantiations', () => {
    setLocation('?utm_source=ads');
    const a = new AttributionStore({ persistFor: 'session' }, false);
    a.captureForNewSession();

    setLocation(''); // strip URL — second instance should still get UTM from session storage
    const b = new AttributionStore({ persistFor: 'session' }, false);
    expect(b.getStamp().utm_source).toBe('ads');
  });

  it('reset() clears everything', () => {
    setLocation('?utm_source=ads');
    const a = new AttributionStore({ persistFor: 'session' }, false);
    a.captureForNewSession();
    a.reset();
    expect(a.getStamp()).toEqual({});
  });
});
