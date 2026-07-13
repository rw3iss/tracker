/**
 * @jest-environment jsdom
 */
import { BreadcrumbsPlugin } from '../../../../src/emitter/plugins/BreadcrumbsPlugin';
import { NavigationCollector } from '../../../../src/emitter/plugins/collectors/NavigationCollector';
import { ClickCollector } from '../../../../src/emitter/plugins/collectors/ClickCollector';
import { ConsoleCollector } from '../../../../src/emitter/plugins/collectors/ConsoleCollector';
import { NetworkCollector } from '../../../../src/emitter/plugins/collectors/NetworkCollector';
import type { Breadcrumb } from '../../../../src/common/types';
import type { TrackerEvent } from '../../../../src/common/types';
import type { ITrackerClientRef } from '../../../../src/emitter/ITrackerClientPlugin';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRef(): ITrackerClientRef {
  return { capture: jest.fn(), getContext: jest.fn(() => ({})) };
}

function makeEvent(overrides: Partial<TrackerEvent> = {}): TrackerEvent {
  return {
    type: 'error', message: 'test error', timestamp: Date.now(),
    appId: 'test', context: {}, ...overrides,
  };
}

function makeCrumb(overrides: Partial<Breadcrumb> = {}): Breadcrumb {
  return { timestamp: Date.now(), category: 'custom', message: 'crumb', ...overrides };
}

// ─── BreadcrumbsPlugin core ──────────────────────────────────────────────────

describe('BreadcrumbsPlugin', () => {
  let plugin: BreadcrumbsPlugin;
  const ref = makeRef();

  beforeEach(() => {
    plugin = new BreadcrumbsPlugin({ navigation: false, click: false, console: false, network: false });
    plugin.onInit(ref);
  });

  afterEach(() => {
    plugin.onDestroy();
  });

  it('returns event unchanged when buffer is empty', () => {
    const event = makeEvent();
    expect(plugin.onCapture(event)).toBe(event);
  });

  it('attaches breadcrumbs to payload', () => {
    plugin.addBreadcrumb({ category: 'navigation', message: 'Navigate to /page' });
    const result = plugin.onCapture(makeEvent());
    expect(result.payload?.breadcrumbs).toHaveLength(1);
    expect((result.payload?.breadcrumbs as Breadcrumb[])[0].category).toBe('navigation');
  });

  it('does not mutate the original event payload', () => {
    plugin.addBreadcrumb({ category: 'custom', message: 'x' });
    const orig = makeEvent({ payload: { foo: 'bar' } });
    const result = plugin.onCapture(orig);
    expect(result.payload?.foo).toBe('bar');
    expect(orig.payload?.breadcrumbs).toBeUndefined();
  });

  it('respects attachTo — skips non-matching event types', () => {
    plugin = new BreadcrumbsPlugin({
      navigation: false, click: false, console: false, network: false,
      attachTo: ['error'],
    });
    plugin.onInit(ref);
    plugin.addBreadcrumb({ category: 'custom', message: 'x' });

    const infoEvent = makeEvent({ type: 'info' });
    expect(plugin.onCapture(infoEvent)).toBe(infoEvent);

    const errorEvent = makeEvent({ type: 'error' });
    expect(plugin.onCapture(errorEvent).payload?.breadcrumbs).toHaveLength(1);
  });

  it('clearAfterAttach empties buffer after attaching', () => {
    plugin = new BreadcrumbsPlugin({
      navigation: false, click: false, console: false, network: false,
      clearAfterAttach: true,
    });
    plugin.onInit(ref);
    plugin.addBreadcrumb({ category: 'custom', message: 'x' });
    plugin.onCapture(makeEvent());
    expect(plugin.getBreadcrumbs()).toHaveLength(0);
  });

  it('without clearAfterAttach, buffer persists across events', () => {
    plugin.addBreadcrumb({ category: 'custom', message: 'x' });
    plugin.onCapture(makeEvent());
    expect(plugin.getBreadcrumbs()).toHaveLength(1);
  });

  it('respects maxItems — evicts oldest entry', () => {
    plugin = new BreadcrumbsPlugin({
      navigation: false, click: false, console: false, network: false,
      maxItems: 3,
    });
    plugin.onInit(ref);
    ['a', 'b', 'c', 'd'].forEach(m => plugin.addBreadcrumb({ category: 'custom', message: m }));
    const crumbs = plugin.getBreadcrumbs();
    expect(crumbs).toHaveLength(3);
    expect(crumbs[0].message).toBe('b');
    expect(crumbs[2].message).toBe('d');
  });

  it('getBreadcrumbs returns a copy, not a reference', () => {
    plugin.addBreadcrumb({ category: 'custom', message: 'x' });
    const a = plugin.getBreadcrumbs();
    const b = plugin.getBreadcrumbs();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('clear() empties the buffer', () => {
    plugin.addBreadcrumb({ category: 'custom', message: 'x' });
    plugin.clear();
    expect(plugin.getBreadcrumbs()).toHaveLength(0);
  });

  it('addBreadcrumb auto-stamps timestamp when omitted', () => {
    const before = Date.now();
    plugin.addBreadcrumb({ category: 'custom', message: 'x' });
    const after = Date.now();
    const [crumb] = plugin.getBreadcrumbs();
    expect(crumb.timestamp).toBeGreaterThanOrEqual(before);
    expect(crumb.timestamp).toBeLessThanOrEqual(after);
  });

  it('addBreadcrumb uses provided timestamp', () => {
    plugin.addBreadcrumb({ category: 'custom', message: 'x', timestamp: 12345 });
    expect(plugin.getBreadcrumbs()[0].timestamp).toBe(12345);
  });

  it('extraCollectors are installed and uninstalled', () => {
    const extra = { install: jest.fn(), uninstall: jest.fn() };
    const p = new BreadcrumbsPlugin({
      navigation: false, click: false, console: false, network: false,
      extraCollectors: [extra],
    });
    p.onInit(ref);
    expect(extra.install).toHaveBeenCalledTimes(1);
    p.onDestroy();
    expect(extra.uninstall).toHaveBeenCalledTimes(1);
  });
});

// ─── NavigationCollector ─────────────────────────────────────────────────────

describe('NavigationCollector', () => {
  let push: jest.Mock;
  let collector: NavigationCollector;

  beforeEach(() => {
    push      = jest.fn();
    collector = new NavigationCollector(push, {});
    collector.install();
  });

  afterEach(() => {
    collector.uninstall();
  });

  it('fires on history.pushState', () => {
    const before = location.href;
    history.pushState({}, '', '/test-nav');
    expect(push).toHaveBeenCalledTimes(1);
    const crumb: Breadcrumb = push.mock.calls[0][0];
    expect(crumb.category).toBe('navigation');
    expect(crumb.data?.from).toBe(before);
    expect(crumb.data?.to).toContain('/test-nav');
  });

  it('does not fire when URL is unchanged', () => {
    history.pushState({}, '', location.href);
    expect(push).not.toHaveBeenCalled();
  });

  it('respects ignoreUrls string pattern', () => {
    collector.uninstall();
    collector = new NavigationCollector(push, { ignoreUrls: ['/ignored'] });
    collector.install();
    history.pushState({}, '', '/ignored-page');
    expect(push).not.toHaveBeenCalled();
  });

  it('respects ignoreUrls regex pattern', () => {
    collector.uninstall();
    collector = new NavigationCollector(push, { ignoreUrls: [/^http:\/\/localhost\/admin/] });
    collector.install();
    history.pushState({}, '', '/admin/settings');
    expect(push).not.toHaveBeenCalled();
  });

  it('filter function drops matching crumbs', () => {
    collector.uninstall();
    collector = new NavigationCollector(push, { filter: () => false });
    collector.install();
    history.pushState({}, '', '/some-page');
    expect(push).not.toHaveBeenCalled();
  });

  it('transform function mutates crumb', () => {
    collector.uninstall();
    collector = new NavigationCollector(push, { transform: (c) => ({ ...c, message: 'overridden' }) });
    collector.install();
    history.pushState({}, '', '/transformed');
    expect(push.mock.calls[0][0].message).toBe('overridden');
  });

  it('uninstall restores original pushState', () => {
    const patched = history.pushState;
    collector.uninstall();
    expect(history.pushState).not.toBe(patched);
  });
});

// ─── ClickCollector ──────────────────────────────────────────────────────────

describe('ClickCollector', () => {
  let push: jest.Mock;
  let collector: ClickCollector;

  beforeEach(() => {
    push      = jest.fn();
    collector = new ClickCollector(push, {});
    collector.install();
  });

  afterEach(() => {
    collector.uninstall();
  });

  it('fires on document click', () => {
    document.body.click();
    expect(push).toHaveBeenCalledTimes(1);
    const crumb: Breadcrumb = push.mock.calls[0][0];
    expect(crumb.category).toBe('click');
    expect(crumb.data?.tag).toBe('body');
  });

  it('captures element id and classes', () => {
    const btn = document.createElement('button');
    btn.id        = 'submit-btn';
    btn.className = 'btn primary';
    document.body.appendChild(btn);
    btn.click();
    const crumb: Breadcrumb = push.mock.calls[0][0];
    expect(crumb.data?.id).toBe('submit-btn');
    expect(crumb.data?.classes).toBe('btn primary');
    document.body.removeChild(btn);
  });

  it('respects ignoreSelectors', () => {
    collector.uninstall();
    collector = new ClickCollector(push, { ignoreSelectors: ['input'] });
    collector.install();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.click();
    expect(push).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it('filter function drops matching crumbs', () => {
    collector.uninstall();
    collector = new ClickCollector(push, { filter: () => false });
    collector.install();
    document.body.click();
    expect(push).not.toHaveBeenCalled();
  });
});

// ─── ConsoleCollector ────────────────────────────────────────────────────────

describe('ConsoleCollector', () => {
  let push: jest.Mock;
  let collector: ConsoleCollector;
  const origWarn  = console.warn;
  const origError = console.error;

  beforeEach(() => {
    push      = jest.fn();
    collector = new ConsoleCollector(push, {});
    collector.install();
  });

  afterEach(() => {
    collector.uninstall();
    // Safety: restore in case uninstall missed
    console.warn  = origWarn;
    console.error = origError;
  });

  it('fires on console.warn', () => {
    console.warn('something bad');
    expect(push).toHaveBeenCalledTimes(1);
    const crumb: Breadcrumb = push.mock.calls[0][0];
    expect(crumb.category).toBe('console');
    expect(crumb.level).toBe('warning');
    expect(crumb.message).toContain('something bad');
  });

  it('fires on console.error', () => {
    console.error('critical failure');
    expect(push).toHaveBeenCalledTimes(1);
    const crumb: Breadcrumb = push.mock.calls[0][0];
    expect(crumb.level).toBe('error');
  });

  it('does not fire on console.log (not in default levels)', () => {
    console.log('just info');
    expect(push).not.toHaveBeenCalled();
  });

  it('respects custom levels config', () => {
    collector.uninstall();
    collector = new ConsoleCollector(push, { levels: ['log', 'info'] });
    collector.install();
    console.log('log line');
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('calls the original console method', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    collector.uninstall();
    const orig = jest.fn();
    (console as any).warn = orig;
    collector = new ConsoleCollector(push, {});
    collector.install();
    console.warn('test');
    expect(orig).toHaveBeenCalledWith('test');
    spy.mockRestore();
  });

  it('uninstall restores original console methods', () => {
    const patched = console.warn;
    collector.uninstall();
    expect(console.warn).toBe(origWarn);
    expect(console.warn).not.toBe(patched);
  });
});

// ─── NetworkCollector ────────────────────────────────────────────────────────

describe('NetworkCollector', () => {
  let push: jest.Mock;
  let fetchMock: jest.Mock;
  let collector: NetworkCollector;

  beforeEach(() => {
    push      = jest.fn();
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    // Install the mock BEFORE the collector wraps it
    global.fetch = fetchMock;
    collector = new NetworkCollector(push, { captureXhr: false });
    collector.install();
  });

  afterEach(() => {
    collector.uninstall();
    delete (global as any).fetch;
  });

  it('fires after a successful fetch', async () => {
    await fetch('https://api.example.com/data');
    expect(push).toHaveBeenCalledTimes(1);
    const crumb: Breadcrumb = push.mock.calls[0][0];
    expect(crumb.category).toBe('network');
    expect(crumb.data?.method).toBe('GET');
    expect(crumb.data?.url).toBe('https://api.example.com/data');
    expect(crumb.data?.status).toBe(200);
    expect(crumb.level).toBe('info');
  });

  it('marks 4xx responses as error level', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await fetch('https://api.example.com/missing');
    const crumb: Breadcrumb = push.mock.calls[0][0];
    expect(crumb.level).toBe('error');
    expect(crumb.data?.status).toBe(404);
  });

  it('marks network failures (status 0) as error level', async () => {
    fetchMock.mockRejectedValue(new Error('network error'));
    try { await fetch('https://api.example.com/fail'); } catch {}
    const crumb: Breadcrumb = push.mock.calls[0][0];
    expect(crumb.level).toBe('error');
    expect(crumb.data?.status).toBe(0);
  });

  it('respects ignoreUrls', async () => {
    collector.uninstall();
    const ignoreMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = ignoreMock;
    collector = new NetworkCollector(push, {
      captureXhr: false,
      ignoreUrls: [/\/tracker\//],
    });
    collector.install();
    await fetch('https://api.example.com/tracker/events');
    expect(push).not.toHaveBeenCalled();
  });

  it('uninstall restores original fetch', () => {
    const patched = window.fetch;
    collector.uninstall();
    expect(window.fetch).not.toBe(patched);
    // Patched version points back to fetchMock after uninstall
    expect(window.fetch).toBe(fetchMock);
  });
});

// ─── Integration: BreadcrumbsPlugin + TrackerClient ─────────────────────────

describe('BreadcrumbsPlugin integration with TrackerClient', () => {
  // Import inline to avoid top-level side effects from defaultTracker singleton
  const { TrackerClient } = require('../../../../src/emitter/TrackerClient');
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
    localStorage.clear();
  });

  afterEach(() => {
    (TrackerClient as any).defaultTracker?.destroy?.();
  });

  it('breadcrumbs are attached to flushed events', async () => {
    const plugin = new BreadcrumbsPlugin({
      navigation: false, click: false, console: false, network: false,
    });
    const client = TrackerClient.init({
      endpoint: 'http://localhost/tracker/events',
      queue:    { flushInterval: 999999 },
      retry:    { maxAttempts: 1, baseDelay: 0, backoffFactor: 1 },
      _delay:   () => Promise.resolve(),
      plugins:  [plugin],
    } as any);

    plugin.addBreadcrumb({ category: 'navigation', message: 'Navigate to /checkout' });
    plugin.addBreadcrumb({ category: 'click',      message: 'Click on <button>#pay' });

    client.error(new Error('payment failed'));
    await client.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const crumbs: Breadcrumb[] = body[0].payload?.breadcrumbs;
    expect(crumbs).toHaveLength(2);
    expect(crumbs[0].category).toBe('navigation');
    expect(crumbs[1].category).toBe('click');

    client.destroy();
  });
});
