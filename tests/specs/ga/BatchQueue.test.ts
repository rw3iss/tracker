import { BatchQueue } from '../../../src/ga/core/BatchQueue';

describe('BatchQueue', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(()  => { jest.useRealTimers(); });

  describe("strategy: 'immediate'", () => {
    it('flushes each item synchronously', () => {
      const flushed: number[][] = [];
      const q = new BatchQueue<number>({
        strategy: 'immediate',
        onFlush:  (batch) => { flushed.push([...batch]); },
      });
      q.push(1);
      q.push(2);
      expect(flushed).toEqual([[1], [2]]);
    });
  });

  describe("strategy: 'size-or-time'", () => {
    it('flushes when batchSize is reached', async () => {
      const flushed: number[][] = [];
      const q = new BatchQueue<number>({
        strategy: 'size-or-time',
        batchSize: 3,
        batchTimeoutMs: 60_000,
        onFlush: (batch) => { flushed.push([...batch]); },
      });
      q.push(1); q.push(2); q.push(3);
      // flush() is async — await its resolution
      await q.flush();
      expect(flushed).toEqual([[1, 2, 3]]);
    });

    it('flushes when batchTimeoutMs elapses', async () => {
      const flushed: number[][] = [];
      const q = new BatchQueue<number>({
        strategy: 'size-or-time',
        batchSize: 100,
        batchTimeoutMs: 1_000,
        onFlush: (batch) => { flushed.push([...batch]); },
      });
      q.push(1); q.push(2);
      jest.advanceTimersByTime(999);
      expect(flushed).toEqual([]);
      jest.advanceTimersByTime(1);
      // flush() is async — let it resolve.
      await Promise.resolve(); await Promise.resolve();
      expect(flushed).toEqual([[1, 2]]);
    });

    it('preserves order across multiple batches', async () => {
      const flushed: number[][] = [];
      const q = new BatchQueue<number>({
        strategy: 'size-or-time',
        batchSize: 2,
        batchTimeoutMs: 60_000,
        onFlush: (batch) => { flushed.push([...batch]); },
      });
      q.push(1); q.push(2);
      await q.flush();
      q.push(3); q.push(4);
      await q.flush();
      expect(flushed).toEqual([[1, 2], [3, 4]]);
    });
  });

  describe("strategy: 'time'", () => {
    it('flushes only on timer, regardless of size', async () => {
      const flushed: number[][] = [];
      const q = new BatchQueue<number>({
        strategy: 'time',
        batchSize: 5, // ignored in 'time' mode
        batchTimeoutMs: 500,
        onFlush: (batch) => { flushed.push([...batch]); },
      });
      for (let i = 0; i < 10; i++) q.push(i);
      expect(flushed).toEqual([]);
      jest.advanceTimersByTime(500);
      await Promise.resolve(); await Promise.resolve();
      expect(flushed).toEqual([[0,1,2,3,4,5,6,7,8,9]]);
    });
  });

  describe('maxSize cap', () => {
    it('drops oldest items when exceeded', async () => {
      const flushed: number[][] = [];
      const q = new BatchQueue<number>({
        strategy: 'time',
        batchTimeoutMs: 60_000,
        maxSize: 3,
        onFlush: (batch) => { flushed.push([...batch]); },
      });
      q.push(1); q.push(2); q.push(3); q.push(4); q.push(5);
      await q.flush();
      expect(flushed).toEqual([[3, 4, 5]]);
    });
  });

  describe('flushNow()', () => {
    it('returns the drained batch synchronously', () => {
      const flushed: number[][] = [];
      const q = new BatchQueue<number>({
        strategy: 'time',
        batchTimeoutMs: 60_000,
        onFlush: (batch) => { flushed.push([...batch]); },
      });
      q.push(1); q.push(2);
      const drained = q.flushNow();
      expect(drained).toEqual([1, 2]);
      // onFlush still fires — caller may also use sendBeacon directly.
      expect(flushed).toEqual([[1, 2]]);
      expect(q.length).toBe(0);
    });
  });

  describe('error handling', () => {
    it('routes async failures to onError', async () => {
      const errors: unknown[] = [];
      const q = new BatchQueue<number>({
        strategy: 'immediate',
        onFlush:  () => Promise.reject(new Error('boom')),
        onError:  (e) => errors.push(e),
      });
      q.push(1);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(errors).toHaveLength(1);
    });
  });
});
