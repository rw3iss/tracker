import { ANALYTICS_CATEGORY, AnalyticsEvent } from '../vocabulary';
import type { ICollector, CollectorEmit } from './ICollector';

interface OutboundLinkOptions {
  /**
   * Hosts to consider "internal" even though they don't match `location.host`.
   * Useful for multi-domain organizations (e.g. `'docs.example.com'` is
   * internal to `'example.com'`).
   */
  sameOriginHosts?: string[];
}

/**
 * Emits `click_outbound` when the user clicks a link to an external host.
 *
 * Single delegated `click` listener at the document root (capture, passive).
 * Resolves the closest `<a>` ancestor via `closest('a')`. Compares the
 * link's host to `location.host` plus any whitelisted `sameOriginHosts`.
 *
 * Captures `link_url`, `link_text`, `link_id`, `link_classes`. Doesn't
 * `preventDefault` — most outbound clicks navigate, so we rely on the host
 * `TrackerClient`'s `pagehide` flusher (or `sendBeacon`) to deliver before
 * the new page loads.
 */
export class OutboundLinkCollector implements ICollector {
  private clickListener: ((e: MouseEvent) => void) | null = null;
  private installed = false;

  constructor(
    private readonly emit: CollectorEmit,
    private readonly opts: OutboundLinkOptions = {},
  ) {}

  install(): void {
    if (this.installed || typeof document === 'undefined') return;
    this.installed = true;
    const handle = (e: MouseEvent): void => this.handleClick(e);
    this.clickListener = handle;
    document.addEventListener('click', handle, { capture: true, passive: true });
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    if (this.clickListener && typeof document !== 'undefined') {
      document.removeEventListener('click', this.clickListener, { capture: true } as EventListenerOptions);
    }
    this.clickListener = null;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a') as HTMLAnchorElement | null;
    if (!anchor || !anchor.href) return;

    let url: URL;
    try { url = new URL(anchor.href, location.href); }
    catch { return; }

    if (!this.isOutbound(url)) return;

    this.emit({
      message:  AnalyticsEvent.ClickOutbound,
      category: ANALYTICS_CATEGORY,
      payload: {
        link_url:     url.href,
        link_domain:  url.hostname,
        link_text:    truncate((anchor.textContent ?? '').trim(), 256),
        link_id:      anchor.id || undefined,
        link_classes: anchor.className || undefined,
        outbound:     true,
      },
    });
  }

  private isOutbound(url: URL): boolean {
    if (typeof location === 'undefined') return false;
    if (url.hostname === location.hostname) return false;
    if (this.opts.sameOriginHosts?.includes(url.hostname)) return false;
    // Skip non-http(s) — mailto:, tel:, javascript:, etc.
    if (!/^https?:$/.test(url.protocol)) return false;
    return true;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
