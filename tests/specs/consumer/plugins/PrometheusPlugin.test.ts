import 'reflect-metadata';
import { PrometheusPlugin } from '../../../../src/consumer/plugins/PrometheusPlugin';
import { TrackerEventStatus } from '../../../../src/common/types';
import type { StoredTrackerEvent } from '../../../../src/common/types';
import type { ITrackerServiceRef } from '../../../../src/consumer/ITrackerPlugin';

function makeServiceRef(): jest.Mocked<ITrackerServiceRef> {
  return {
    track:                   jest.fn().mockResolvedValue(undefined),
    setStorage:              jest.fn(),
    registerMetricsProvider: jest.fn(),
  };
}

function makeEvent(overrides: Partial<StoredTrackerEvent> = {}): StoredTrackerEvent {
  return {
    id:         'evt-1',
    type:       'error',
    message:    'boom',
    status:     TrackerEventStatus.New,
    timestamp:  Date.now(),
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe('PrometheusPlugin', () => {
  it('registers a metrics provider with the service on init', () => {
    const plugin  = PrometheusPlugin.create();
    const service = makeServiceRef();
    plugin.onInit(service);
    expect(service.registerMetricsProvider).toHaveBeenCalledTimes(1);
    expect(typeof service.registerMetricsProvider.mock.calls[0][0]).toBe('function');
  });

  it('does not register metrics provider when exposeEndpoint is false', () => {
    const plugin  = PrometheusPlugin.create({ exposeEndpoint: false });
    const service = makeServiceRef();
    plugin.onInit(service);
    expect(service.registerMetricsProvider).not.toHaveBeenCalled();
  });

  it('increments counter per event', () => {
    const plugin = PrometheusPlugin.create();
    plugin.onEvent(makeEvent({ type: 'error', status: TrackerEventStatus.New }));
    plugin.onEvent(makeEvent({ type: 'error', status: TrackerEventStatus.New }));
    plugin.onEvent(makeEvent({ type: 'info',  status: TrackerEventStatus.New }));

    const metrics = plugin.renderMetrics();
    expect(metrics).toContain('tracker_events_total{type="error"');
    expect(metrics).toContain('} 2');
    expect(metrics).toContain('tracker_events_total{type="info"');
    expect(metrics).toContain('} 1');
  });

  it('renderMetrics includes HELP and TYPE comment lines', () => {
    const plugin  = PrometheusPlugin.create();
    const metrics = plugin.renderMetrics();
    expect(metrics).toContain('# HELP tracker_events_total');
    expect(metrics).toContain('# TYPE tracker_events_total counter');
  });

  it('renderMetrics registered function returns the same output', () => {
    const plugin  = PrometheusPlugin.create();
    const service = makeServiceRef();
    plugin.onInit(service);

    plugin.onEvent(makeEvent());
    const registeredFn = service.registerMetricsProvider.mock.calls[0][0] as () => string;
    expect(registeredFn()).toBe(plugin.renderMetrics());
  });

  it('tracks appId in metric labels', () => {
    const plugin = PrometheusPlugin.create();
    plugin.onEvent(makeEvent({ appId: 'my-app' }));
    const metrics = plugin.renderMetrics();
    expect(metrics).toContain('appId="my-app"');
  });
});
