/**
 * @jest-environment jsdom
 */
import {
  registerNetworkCapture,
  unregisterNetworkCapture,
} from '../../../src/emitter/network-capture';
import type { TrackerClient } from '../../../src/emitter/TrackerClient';

function makeClient(): jest.Mocked<Pick<TrackerClient, 'capture'>> {
  return { capture: jest.fn() };
}

describe('network-capture (fetch)', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock    = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    unregisterNetworkCapture();
    delete (global as any).fetch;
  });

  it('does not capture successful requests when errorsOnly is true (default)', async () => {
    const client = makeClient();
    registerNetworkCapture(client as any);
    await fetch('https://api.example.com/data');
    expect(client.capture).not.toHaveBeenCalled();
  });

  it('captures 4xx responses as error events', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const client = makeClient();
    registerNetworkCapture(client as any);
    await fetch('https://api.example.com/missing');
    expect(client.capture).toHaveBeenCalledTimes(1);
    const call = client.capture.mock.calls[0][0];
    expect(call.type).toBe('error');
    expect(call.category).toBe('network');
    expect(call.payload?.status).toBe(404);
    expect(call.tags).toContain('auto-capture');
  });

  it('captures network failures (thrown) as error events', async () => {
    fetchMock.mockRejectedValue(new Error('network error'));
    const client = makeClient();
    registerNetworkCapture(client as any);
    try { await fetch('https://api.example.com/fail'); } catch {}
    expect(client.capture).toHaveBeenCalledTimes(1);
    const call = client.capture.mock.calls[0][0];
    expect(call.type).toBe('error');
    expect(call.payload?.status).toBe(0);
  });

  it('captures all requests when errorsOnly is false', async () => {
    const client = makeClient();
    registerNetworkCapture(client as any, { errorsOnly: false });
    await fetch('https://api.example.com/ok');
    expect(client.capture).toHaveBeenCalledTimes(1);
    expect(client.capture.mock.calls[0][0].type).toBe('info');
  });

  it('respects ignoreUrls', async () => {
    const client = makeClient();
    registerNetworkCapture(client as any, { errorsOnly: false, ignoreUrls: [/\/tracker\//] });
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await fetch('https://api.example.com/tracker/events');
    expect(client.capture).not.toHaveBeenCalled();
  });

  it('unregisterNetworkCapture restores original fetch', () => {
    const client  = makeClient();
    const origFetch = fetchMock;
    registerNetworkCapture(client as any);
    const patched = window.fetch;
    expect(patched).not.toBe(origFetch);
    unregisterNetworkCapture();
    expect(window.fetch).toBe(origFetch);
  });

  it('is a no-op when called a second time (idempotent)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const client = makeClient();
    registerNetworkCapture(client as any, { errorsOnly: true });
    registerNetworkCapture(client as any, { errorsOnly: false }); // second call ignored
    await fetch('https://api.example.com/fail');
    // If second call had taken effect (errorsOnly: false), a 500 would still be captured,
    // but so would 200s. Primarily we're testing it doesn't double-wrap.
    expect(client.capture).toHaveBeenCalledTimes(1);
  });
});
