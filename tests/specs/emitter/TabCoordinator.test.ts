/**
 * @jest-environment jsdom
 */
import { TabCoordinator } from '../../../src/emitter/TabCoordinator';

// BroadcastChannel is not available in jsdom — provide a simple in-process mock
// that routes messages synchronously between all open channels of the same name.
const channelRegistry = new Map<string, Set<MockBC>>();

class MockBC {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
    if (!channelRegistry.has(name)) channelRegistry.set(name, new Set());
    channelRegistry.get(name)!.add(this);
  }

  postMessage(data: unknown): void {
    for (const ch of channelRegistry.get(this.name) ?? []) {
      if (ch !== this) ch.onmessage?.({ data });
    }
  }

  close(): void {
    channelRegistry.get(this.name)?.delete(this);
  }
}

beforeAll(() => {
  (global as any).BroadcastChannel = MockBC;
});

afterAll(() => {
  delete (global as any).BroadcastChannel;
});

beforeEach(() => {
  channelRegistry.clear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('TabCoordinator', () => {
  it('single tab becomes leader after election window', () => {
    const changes: boolean[] = [];
    const tab = new TabCoordinator({ onLeaderChange: (l) => changes.push(l) });
    expect(tab.isLeader).toBe(false);
    jest.advanceTimersByTime(100);
    expect(tab.isLeader).toBe(true);
    expect(changes).toEqual([true]);
    tab.destroy();
  });

  it('second tab yields to the first when it receives a victory', () => {
    const tab1 = new TabCoordinator();
    jest.advanceTimersByTime(100); // tab1 wins election
    expect(tab1.isLeader).toBe(true);

    // tab2 opens: it sends query, tab1 responds with victory, tab2 should NOT claim
    const tab2 = new TabCoordinator();
    jest.advanceTimersByTime(100);
    expect(tab2.isLeader).toBe(false);
    expect(tab1.isLeader).toBe(true);

    tab1.destroy();
    tab2.destroy();
  });

  it('second tab becomes leader after first resigns', () => {
    const tab1 = new TabCoordinator();
    jest.advanceTimersByTime(100);
    expect(tab1.isLeader).toBe(true);

    const changes2: boolean[] = [];
    const tab2 = new TabCoordinator({ onLeaderChange: (l) => changes2.push(l) });
    jest.advanceTimersByTime(100);
    expect(tab2.isLeader).toBe(false);

    // tab1 resigns — tab2 should start a new election and win
    tab1.destroy();
    jest.advanceTimersByTime(100);
    expect(tab2.isLeader).toBe(true);
    expect(changes2).toContain(true);

    tab2.destroy();
  });

  it('non-leader re-elects after leader timeout expires', () => {
    const tab1 = new TabCoordinator();
    jest.advanceTimersByTime(100);

    const tab2 = new TabCoordinator();
    jest.advanceTimersByTime(100);
    expect(tab2.isLeader).toBe(false);

    // Simulate leader gone — stop heartbeats by closing tab1 channel without a resign message
    (tab1 as any).channel.close();
    (tab1 as any)._isLeader = false; // prevent resign broadcast in destroy
    tab1.destroy();

    // Advance past leader timeout (2500ms) + election window (100ms)
    jest.advanceTimersByTime(2_600);
    expect(tab2.isLeader).toBe(true);

    tab2.destroy();
  });

  it('destroy broadcasts resign and closes channel', () => {
    const tab = new TabCoordinator();
    jest.advanceTimersByTime(100);
    expect(tab.isLeader).toBe(true);

    const received: unknown[] = [];
    const observer = new MockBC('__vt_coordinator__');
    observer.onmessage = (e) => received.push(e.data);

    tab.destroy();
    expect((received as any[]).some((m: any) => m.type === 'resign')).toBe(true);
    expect(tab.isLeader).toBe(false);
    observer.close();
  });

  it('tabId is unique per instance', () => {
    const t1 = new TabCoordinator();
    const t2 = new TabCoordinator();
    expect(t1.tabId).not.toBe(t2.tabId);
    t1.destroy();
    t2.destroy();
  });
});
