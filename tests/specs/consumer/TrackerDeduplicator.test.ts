import { TrackerDeduplicator } from '../../../src/consumer/TrackerDeduplicator';
import { InMemoryDeduplicationCache } from '../../../src/consumer/cache/InMemoryDeduplicationCache';
import type { TrackerEvent } from '../../../src/common/types';

const makeEvent = (overrides: Partial<TrackerEvent> = {}): TrackerEvent => ({
  type: 'error',
  message: 'something broke',
  appId: 'my-app',
  error: { name: 'TypeError', message: 'cannot read prop' },
  context: { userId: 'u1', environment: 'production' },
  timestamp: Date.now(),
  ...overrides,
});

describe('TrackerDeduplicator', () => {
  it('returns false on first occurrence (cache miss)', async () => {
    const d = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 60_000);
    expect(await d.isDuplicate(makeEvent())).toBe(false);
  });

  it('returns true for identical event within window (cache hit)', async () => {
    const d = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 60_000);
    const e = makeEvent();
    await d.isDuplicate(e);
    expect(await d.isDuplicate(e)).toBe(true);
  });

  it('returns false for identical event after window expires', async () => {
    jest.useFakeTimers();
    const d = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 500);
    const e = makeEvent();
    await d.isDuplicate(e);
    jest.advanceTimersByTime(501);
    expect(await d.isDuplicate(e)).toBe(false);
    jest.useRealTimers();
  });

  it('treats different appId as different events', async () => {
    const d = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 60_000);
    await d.isDuplicate(makeEvent({ appId: 'app-a' }));
    expect(await d.isDuplicate(makeEvent({ appId: 'app-b' }))).toBe(false);
  });

  it('treats different userId as different events', async () => {
    const d = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 60_000);
    await d.isDuplicate(makeEvent({ context: { userId: 'u1' } }));
    expect(await d.isDuplicate(makeEvent({ context: { userId: 'u2' } }))).toBe(false);
  });

  it('treats different error message as different events', async () => {
    const d = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 60_000);
    await d.isDuplicate(makeEvent({ error: { name: 'TypeError', message: 'err A' } }));
    expect(await d.isDuplicate(makeEvent({ error: { name: 'TypeError', message: 'err B' } }))).toBe(false);
  });

  it('events without appId still deduplicate by other fields', async () => {
    const d = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 60_000);
    const e = makeEvent({ appId: undefined });
    await d.isDuplicate(e);
    expect(await d.isDuplicate(e)).toBe(true);
  });

  describe('bypass predicate', () => {
    it('returns false on every call when bypass returns true (no dedup)', async () => {
      const d = new TrackerDeduplicator(
        new InMemoryDeduplicationCache(),
        60_000,
        undefined,
        (e) => e.message.startsWith('bid.'),
      );
      const e = makeEvent({ message: 'bid.place_committed' });
      expect(await d.isDuplicate(e)).toBe(false);
      expect(await d.isDuplicate(e)).toBe(false);
      expect(await d.isDuplicate(e)).toBe(false);
    });

    it('does not write the cache when bypass returns true', async () => {
      // A subsequent dedupable event with the same fingerprint must still
      // get a clean first-occurrence pass — bypass must not poison the cache.
      const cache = new InMemoryDeduplicationCache();
      const d = new TrackerDeduplicator(
        cache, 60_000, undefined,
        (e) => e.message === 'bid.place_committed',
      );
      const bypassed  = makeEvent({ message: 'bid.place_committed' });
      const dedupable = makeEvent({ message: 'bid.place_committed' });
      // Fire the bypassed event many times
      for (let i = 0; i < 5; i++) await d.isDuplicate(bypassed);
      // Now switch off the bypass and confirm dedup starts cleanly.
      // (Easier: build a second deduplicator over the same cache without bypass.)
      const d2 = new TrackerDeduplicator(cache, 60_000);
      expect(await d2.isDuplicate(dedupable)).toBe(false); // cache was untouched
      expect(await d2.isDuplicate(dedupable)).toBe(true);  // now it's there
    });

    it('still dedupes events for which bypass returns false', async () => {
      const d = new TrackerDeduplicator(
        new InMemoryDeduplicationCache(),
        60_000,
        undefined,
        (e) => e.message.startsWith('bid.'),
      );
      const bypassed = makeEvent({ message: 'bid.place_committed' });
      const normal   = makeEvent({ message: 'something broke' });
      // Bypassed never dedupes
      expect(await d.isDuplicate(bypassed)).toBe(false);
      expect(await d.isDuplicate(bypassed)).toBe(false);
      // Normal still dedupes as before
      expect(await d.isDuplicate(normal)).toBe(false);
      expect(await d.isDuplicate(normal)).toBe(true);
    });

    it('event.dedup === false short-circuits before bypass and fingerprint', async () => {
      // Per-event wire flag is the highest-priority opt-out — neither the
      // server-side bypass predicate nor the fingerprint should be called.
      const bypass = jest.fn(() => false);
      const fingerprint = jest.fn(() => 'fp');
      const d = new TrackerDeduplicator(
        new InMemoryDeduplicationCache(),
        60_000,
        fingerprint,
        bypass,
      );
      const e = makeEvent({ dedup: false });
      expect(await d.isDuplicate(e)).toBe(false);
      expect(await d.isDuplicate(e)).toBe(false);
      expect(fingerprint).not.toHaveBeenCalled();
      expect(bypass).not.toHaveBeenCalled();
    });

    it('event.dedup !== false (true / undefined) does not short-circuit', async () => {
      // Only literal `false` opts out. `true` and `undefined` mean "let
      // the dedup pipeline decide" — they should NOT skip dedup.
      const d = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 60_000);
      const eTrue = makeEvent({ dedup: true });
      expect(await d.isDuplicate(eTrue)).toBe(false);
      expect(await d.isDuplicate(eTrue)).toBe(true);  // dedup ran
    });

    it('bypass is checked before fingerprint is computed', async () => {
      // If bypass returns true, fingerprint must NOT be called — it could be
      // expensive and there's no reason to compute a key we'll never use.
      const fingerprint = jest.fn(() => 'fp');
      const d = new TrackerDeduplicator(
        new InMemoryDeduplicationCache(),
        60_000,
        fingerprint,
        () => true,
      );
      await d.isDuplicate(makeEvent());
      expect(fingerprint).not.toHaveBeenCalled();
    });
  });
});
