import type { ITransportAdapter } from './ITransportAdapter';
import type { GaConfigOptions, GaConsentState } from '../core/types';
import type { GaEventEnvelope } from '../core/EventMapper';

interface GtmAdapterOptions {
  /** Override the GTM script URL — useful when proxying GTM. */
  scriptSrc?: string;
  /** CSP nonce for the injected script. */
  nonce?:    string;
  /** Skip script injection if the host already loads GTM. */
  skipInject?: boolean;
  /** GTM dataLayer name. Default: `'dataLayer'`. */
  dataLayerName?: string;
}

const DEFAULT_GTM_SRC = 'https://www.googletagmanager.com/gtm.js';

/**
 * Browser adapter — pushes events into the GTM dataLayer.
 *
 * GTM is a tag aggregator that loads its own configuration; the host
 * installs/configures their tags inside the GTM admin UI. This adapter just
 * makes events available in the dataLayer with the conventional shape
 * `{ event: <name>, ...params }` so GTM workspace triggers can fire on
 * them.
 *
 * For straight GA4 deployment without GTM in the middle, prefer
 * `GtagAdapter` — fewer moving parts, no GTM container to maintain. Use
 * GTM when the host already has a GTM workspace and tags configured there.
 *
 * **Multi-ID note:** GTM containers manage their own measurement IDs
 * internally, so this adapter takes container IDs (`GTM-XXX`) rather than
 * measurement IDs (`G-XXX`). Sending to multiple containers means injecting
 * multiple scripts.
 */
export class GtmAdapter implements ITransportAdapter {
  readonly name = 'gtm';
  private installed = false;
  private dataLayerName: string;
  private containerIds: string[] = [];

  constructor(private readonly opts: GtmAdapterOptions = {}) {
    this.dataLayerName = opts.dataLayerName ?? 'dataLayer';
    // Eager dataLayer setup so consent / config calls made before init()
    // (e.g. via GaCore's ConsentManager subscription) land in the queue
    // instead of being dropped. See GtagAdapter constructor for rationale.
    if (typeof window !== 'undefined') {
      const w = window as unknown as Record<string, unknown[]>;
      if (!Array.isArray(w[this.dataLayerName])) w[this.dataLayerName] = [];
    }
  }

  async init(containerIds: string[], _config: GaConfigOptions): Promise<void> {
    if (typeof window === 'undefined') return;
    this.containerIds = [...containerIds];

    // Standard GTM bootstrap event — kicks the container.
    const w = window as unknown as Record<string, unknown[]>;
    w[this.dataLayerName].push({ 'gtm.start': Date.now(), event: 'gtm.js' });

    if (!this.opts.skipInject) {
      const promises = containerIds.map(id => {
        const src = `${this.opts.scriptSrc ?? DEFAULT_GTM_SRC}?id=${encodeURIComponent(id)}${
          this.dataLayerName === 'dataLayer' ? '' : `&l=${encodeURIComponent(this.dataLayerName)}`
        }`;
        return injectScript(src, this.opts.nonce);
      });
      await Promise.allSettled(promises);
    }
    this.installed = true;
  }

  config(_containerId: string, opts: GaConfigOptions): void {
    if (!this.installed) return;
    // GTM doesn't have a `gtag('config', ...)` — push as an event the
    // workspace can react to.
    this.push({ event: 'config_update', ...opts });
  }

  consent(op: 'default' | 'update', state: GaConsentState): void {
    // Mirror gtag's consent shape into the dataLayer; GTM templates can
    // read it via the Consent API.
    this.push({ event: `gtag.consent.${op}`, ...state });
  }

  send(events: GaEventEnvelope[]): void {
    if (!this.installed) return;
    for (const event of events) {
      this.push({ event: event.name, ...event.params });
    }
  }

  destroy(): void {
    this.installed = false;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private push(item: Record<string, unknown>): void {
    if (typeof window === 'undefined') return;
    try {
      const w = window as unknown as Record<string, unknown[]>;
      if (Array.isArray(w[this.dataLayerName])) w[this.dataLayerName].push(item);
    } catch { /* swallow */ }
  }
}

function injectScript(src: string, nonce: string | undefined): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src   = src;
    script.async = true;
    if (nonce) script.nonce = nonce;
    script.addEventListener('load',  () => resolve());
    script.addEventListener('error', (err) => reject(err));
    document.head.appendChild(script);
  });
}
