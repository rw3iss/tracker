import { TrackerQueryHelpers } from '../../../src/consumer/storage/TrackerQueryHelpers';
import { InMemoryStorageAdapter } from '../../../src/consumer/storage/adapters/InMemoryStorageAdapter';
import { TrackerEventStatus, type StoredTrackerEvent } from '../../../src/common/types';

const now = () => Date.now();
const ago = (ms: number) => Date.now() - ms;

let idSeq = 0;
const makeEvent = (overrides: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent => ({
    id: `id-${++idSeq}`,
    type: 'info',
    message: 'something happened',
    appId: 'app-a',
    timestamp: ago(1000),
    receivedAt: ago(1000),
    status: TrackerEventStatus.New,
    ...overrides,
});

async function seed(storage: InMemoryStorageAdapter, events: StoredTrackerEvent[]): Promise<void> {
    for (const e of events) await storage.save(e);
}

describe('TrackerQueryHelpers', () => {
    describe('retrieval shortcuts', () => {
        it('auto-scopes by appId when constructed with one', async () => {
            const storage = new InMemoryStorageAdapter();
            await seed(storage, [
                makeEvent({ appId: 'app-a' }),
                makeEvent({ appId: 'app-b' }),
                makeEvent({ appId: 'app-a' }),
            ]);
            const q = new TrackerQueryHelpers(storage, 'app-a');
            const events = await q.recent();
            expect(events).toHaveLength(2);
            expect(events.every((e) => e.appId === 'app-a')).toBe(true);
        });

        it('cross-app when no appId is passed', async () => {
            const storage = new InMemoryStorageAdapter();
            await seed(storage, [makeEvent({ appId: 'a' }), makeEvent({ appId: 'b' })]);
            const q = new TrackerQueryHelpers(storage);
            const events = await q.recent();
            expect(events).toHaveLength(2);
        });

        it('recentErrors filters to type=error', async () => {
            const storage = new InMemoryStorageAdapter();
            await seed(storage, [
                makeEvent({ type: 'error' }),
                makeEvent({ type: 'info' }),
                makeEvent({ type: 'error' }),
            ]);
            const q = new TrackerQueryHelpers(storage);
            const errors = await q.recentErrors();
            expect(errors).toHaveLength(2);
            expect(errors.every((e) => e.type === 'error')).toBe(true);
        });

        it('excludes events outside the window', async () => {
            const storage = new InMemoryStorageAdapter();
            await seed(storage, [
                makeEvent({ receivedAt: ago(30 * 60_000) }), // 30m ago
                makeEvent({ receivedAt: ago(2 * 3_600_000) }), // 2h ago
            ]);
            const q = new TrackerQueryHelpers(storage);
            const recent = await q.recent({ windowMs: 3_600_000 });
            expect(recent).toHaveLength(1);
        });

        it('forUser filters by context.userId', async () => {
            const storage = new InMemoryStorageAdapter();
            await seed(storage, [
                makeEvent({ context: { userId: 'u1' } }),
                makeEvent({ context: { userId: 'u2' } }),
                makeEvent({ context: { userId: 'u1' } }),
            ]);
            const q = new TrackerQueryHelpers(storage);
            const forU1 = await q.forUser('u1');
            expect(forU1).toHaveLength(2);
        });
    });

    describe('aggregations', () => {
        it('countsByType tallies event counts', async () => {
            const storage = new InMemoryStorageAdapter();
            await seed(storage, [
                makeEvent({ type: 'error' }),
                makeEvent({ type: 'error' }),
                makeEvent({ type: 'warning' }),
                makeEvent({ type: 'info' }),
            ]);
            const q = new TrackerQueryHelpers(storage);
            const counts = await q.countsByType();
            expect(counts.error).toBe(2);
            expect(counts.warning).toBe(1);
            expect(counts.info).toBe(1);
        });

        it('errorRate returns fraction of errors over sample', async () => {
            const storage = new InMemoryStorageAdapter();
            await seed(storage, [
                makeEvent({ type: 'error' }),
                makeEvent({ type: 'error' }),
                makeEvent({ type: 'info' }),
                makeEvent({ type: 'info' }),
            ]);
            const q = new TrackerQueryHelpers(storage);
            const rate = await q.errorRate();
            expect(rate).toBe(0.5);
        });

        it('errorRate returns 0 on empty window', async () => {
            const q = new TrackerQueryHelpers(new InMemoryStorageAdapter());
            expect(await q.errorRate()).toBe(0);
        });

        it('topErrorMessages ranks by frequency', async () => {
            const storage = new InMemoryStorageAdapter();
            await seed(storage, [
                makeEvent({ type: 'error', message: 'boom' }),
                makeEvent({ type: 'error', message: 'boom' }),
                makeEvent({ type: 'error', message: 'crash' }),
                makeEvent({ type: 'info', message: 'ok' }),
            ]);
            const q = new TrackerQueryHelpers(storage);
            const top = await q.topErrorMessages({ topN: 10 });
            expect(top[0]).toEqual({ value: 'boom', count: 2 });
            expect(top[1]).toEqual({ value: 'crash', count: 1 });
            expect(top).toHaveLength(2); // only errors counted
        });

        it('topApps aggregates across apps (cross-app helper)', async () => {
            const storage = new InMemoryStorageAdapter();
            await seed(storage, [
                makeEvent({ appId: 'a' }),
                makeEvent({ appId: 'a' }),
                makeEvent({ appId: 'a' }),
                makeEvent({ appId: 'b' }),
            ]);
            const q = new TrackerQueryHelpers(storage); // no appId
            const top = await q.topApps({ topN: 5 });
            expect(top).toEqual([
                { value: 'a', count: 3 },
                { value: 'b', count: 1 },
            ]);
        });

        it('topTags flattens per-event tag arrays', async () => {
            const storage = new InMemoryStorageAdapter();
            await seed(storage, [
                makeEvent({ tags: ['auto-capture', 'network'] }),
                makeEvent({ tags: ['auto-capture'] }),
                makeEvent({ tags: ['network'] }),
            ]);
            const q = new TrackerQueryHelpers(storage);
            const top = await q.topTags({ topN: 5 });
            expect(top[0]).toEqual({ value: 'auto-capture', count: 2 });
            expect(top[1]).toEqual({ value: 'network', count: 2 });
        });
    });

    describe('timeline', () => {
        it('buckets events into evenly-sized windows', async () => {
            const storage = new InMemoryStorageAdapter();
            // 4 events spaced every 15 min; window = 1h; buckets = 4
            const base = Date.now();
            await seed(storage, [
                makeEvent({ type: 'error', receivedAt: base - 50 * 60_000 }), // bucket 0
                makeEvent({ type: 'error', receivedAt: base - 35 * 60_000 }), // bucket 1
                makeEvent({ type: 'info', receivedAt: base - 20 * 60_000 }), // bucket 2
                makeEvent({ type: 'error', receivedAt: base - 5 * 60_000 }), // bucket 3
            ]);
            const q = new TrackerQueryHelpers(storage);
            const tl = await q.timeline({ windowMs: 3_600_000, buckets: 4 });
            expect(tl).toHaveLength(4);
            expect(tl.map((b) => b.total)).toEqual([1, 1, 1, 1]);
            expect(tl.map((b) => b.errors)).toEqual([1, 1, 0, 1]);
        });
    });

    describe('healthSnapshot', () => {
        it('produces a one-shot dashboard summary', async () => {
            const storage = new InMemoryStorageAdapter();
            await seed(storage, [
                makeEvent({ type: 'error', message: 'boom', category: 'payment' }),
                makeEvent({ type: 'error', message: 'boom', category: 'payment' }),
                makeEvent({ type: 'warning', category: 'auth' }),
                makeEvent({ type: 'info', category: 'auth' }),
            ]);
            const q = new TrackerQueryHelpers(storage);
            const snap = await q.healthSnapshot();
            expect(snap.sampled).toBe(4);
            expect(snap.errors).toBe(2);
            expect(snap.warnings).toBe(1);
            expect(snap.errorRate).toBe(0.5);
            expect(snap.topErrorMessages[0]).toEqual({ value: 'boom', count: 2 });
            expect(snap.topCategories.find((c) => c.value === 'auth')?.count).toBe(2);
            expect(snap.truncated).toBe(false);
        });

        it('marks truncated=true when sample hits the cap', async () => {
            const storage = new InMemoryStorageAdapter();
            const many: StoredTrackerEvent[] = Array.from({ length: 10 }, () =>
                makeEvent({ type: 'info' }),
            );
            await seed(storage, many);
            const q = new TrackerQueryHelpers(storage);
            const snap = await q.healthSnapshot({ sampleLimit: 5 });
            expect(snap.truncated).toBe(true);
            expect(snap.sampled).toBe(5);
        });
    });
});
