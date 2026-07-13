/**
 * Coverage for the configurable dedup fingerprint surface.
 *
 *   • DEDUP_PRESETS — verify the four built-in scopes behave as documented.
 *   • buildFingerprintFromFields — accept dotted paths, custom functions,
 *     a mix of both.
 *   • TrackerDeduplicator wired with a custom fingerprint — the full path
 *     a consumer of TrackerModule would exercise.
 *
 * The default fingerprint is already covered by `TrackerDeduplicator.test.ts`.
 */

import {
    DEDUP_PRESETS,
    DEFAULT_FINGERPRINT,
    buildFingerprintFromFields,
    TrackerDeduplicator,
} from '../../../src/consumer/TrackerDeduplicator';
import { InMemoryDeduplicationCache } from '../../../src/consumer/cache/InMemoryDeduplicationCache';
import type { TrackerEvent } from '../../../src/common/types';

const ev = (over: Partial<TrackerEvent> = {}): TrackerEvent => ({
    type: 'error',
    message: 'boom',
    appId: 'svc',
    error: { name: 'TypeError', message: 'oops' },
    context: { userId: 'u-1', sessionId: 's-1', environment: 'production' },
    timestamp: Date.now(),
    ...over,
});

describe('DEDUP_PRESETS — built-in scopes', () => {
    it("perUser: same error from two users does NOT dedupe", () => {
        const fp = buildFingerprintFromFields(DEDUP_PRESETS.perUser);
        const a = fp(ev({ context: { userId: 'u-1' } }));
        const b = fp(ev({ context: { userId: 'u-2' } }));
        expect(a).not.toEqual(b);
    });

    it("perUser: same user, different sessions DOES dedupe (sessionId not in scope)", () => {
        const fp = buildFingerprintFromFields(DEDUP_PRESETS.perUser);
        const a = fp(ev({ context: { userId: 'u-1', sessionId: 's-A' } }));
        const b = fp(ev({ context: { userId: 'u-1', sessionId: 's-B' } }));
        expect(a).toEqual(b);
    });

    it("perSession: same user, different sessions does NOT dedupe", () => {
        const fp = buildFingerprintFromFields(DEDUP_PRESETS.perSession);
        const a = fp(ev({ context: { userId: 'u-1', sessionId: 's-A' } }));
        const b = fp(ev({ context: { userId: 'u-1', sessionId: 's-B' } }));
        expect(a).not.toEqual(b);
    });

    it("perUserAndSession: alias of perSession", () => {
        const a = buildFingerprintFromFields(DEDUP_PRESETS.perUserAndSession)(ev());
        const b = buildFingerprintFromFields(DEDUP_PRESETS.perSession)(ev());
        expect(a).toEqual(b);
    });

    it("global: same error from two users DOES dedupe (userId not in scope)", () => {
        const fp = buildFingerprintFromFields(DEDUP_PRESETS.global);
        const a = fp(ev({ context: { userId: 'u-1', environment: 'production' } }));
        const b = fp(ev({ context: { userId: 'u-2', environment: 'production' } }));
        expect(a).toEqual(b);
    });

    it("DEFAULT_FINGERPRINT matches perUser preset", () => {
        const a = DEFAULT_FINGERPRINT(ev());
        const b = buildFingerprintFromFields(DEDUP_PRESETS.perUser)(ev());
        expect(a).toEqual(b);
    });
});

describe('buildFingerprintFromFields — custom field combinations', () => {
    it('reads dotted paths into nested objects', () => {
        const fp = buildFingerprintFromFields(['type', 'payload.orderId']);
        const a = fp(ev({ payload: { orderId: 1 } }));
        const b = fp(ev({ payload: { orderId: 1 } }));
        const c = fp(ev({ payload: { orderId: 2 } }));
        expect(a).toEqual(b);
        expect(a).not.toEqual(c);
    });

    it('treats missing fields as empty (no spurious mismatch)', () => {
        const fp = buildFingerprintFromFields(['appId', 'payload.missingFromBoth']);
        expect(fp(ev())).toEqual(fp(ev()));
    });

    it('accepts a function entry alongside string paths', () => {
        const fp = buildFingerprintFromFields([
            'type',
            (e) => `bucket:${(e.payload?.amount as number) > 100 ? 'big' : 'small'}`,
        ]);
        const a = fp(ev({ payload: { amount: 250 } }));
        const b = fp(ev({ payload: { amount: 200 } }));
        const c = fp(ev({ payload: { amount: 5 } }));
        expect(a).toEqual(b); // both 'big'
        expect(a).not.toEqual(c); // small vs big
    });

    it('NUL-joining prevents cross-boundary collisions', () => {
        // Without NUL join, `appId='ab'` + `type='c'` would collide with
        // `appId='a'` + `type='bc'`. With NUL join it does not.
        const fp = buildFingerprintFromFields(['appId', 'type']);
        const a = fp(ev({ appId: 'ab', type: 'info' as TrackerEvent['type'] }));
        const b = fp(ev({ appId: 'a',  type: 'binfo' as unknown as TrackerEvent['type'] }));
        expect(a).not.toEqual(b);
    });
});

describe('TrackerDeduplicator — wired with a custom fingerprint', () => {
    it('uses the custom fingerprint to decide duplicates', async () => {
        // Dedup by orderId only — same order, two unrelated events still
        // count as duplicate.
        const fp = buildFingerprintFromFields(['payload.orderId']);
        const d = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 60_000, fp);

        await d.isDuplicate(ev({ payload: { orderId: 7 } }));
        expect(await d.isDuplicate(ev({ payload: { orderId: 7 } }))).toBe(true);
        expect(await d.isDuplicate(ev({ payload: { orderId: 8 } }))).toBe(false);
    });

    it('falls back to the default fingerprint when none is provided (backwards compat)', async () => {
        const d = new TrackerDeduplicator(new InMemoryDeduplicationCache(), 60_000);
        await d.isDuplicate(ev());
        // Same event → duplicate (default = perUser, both have userId u-1).
        expect(await d.isDuplicate(ev())).toBe(true);
        // Different user → NOT duplicate.
        expect(await d.isDuplicate(ev({ context: { userId: 'u-other' } }))).toBe(false);
    });
});
