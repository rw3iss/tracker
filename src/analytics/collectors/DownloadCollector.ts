import { ANALYTICS_CATEGORY, AnalyticsEvent } from '../vocabulary';
import type { ICollector, CollectorEmit } from './ICollector';
import type { DownloadConfig } from '../types';

const DEFAULT_EXTENSIONS = [
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'rtf',
  // Archives
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz',
  // Media
  'mp3', 'wav', 'mp4', 'mov', 'avi', 'webm', 'mkv',
  // Images
  'svg',
];

/**
 * Emits `file_download` when the user clicks a link that:
 * - Has the HTML5 `download` attribute (when `respectDownloadAttr: true`), OR
 * - Resolves to a URL whose pathname ends in one of the configured extensions
 *
 * Captures `file_url`, `file_name`, `file_extension`, `link_text`.
 *
 * Shares the click-listener pattern with `OutboundLinkCollector` — both are
 * delegated at document root with capture-phase listeners. They run
 * independently though, so the same click on a `<a download href="...">` to
 * an external host emits both `file_download` and `click_outbound`.
 */
export class DownloadCollector implements ICollector {
  private readonly extensions: Set<string>;
  private readonly respectDownloadAttr: boolean;
  private clickListener: ((e: MouseEvent) => void) | null = null;
  private installed = false;

  constructor(private readonly emit: CollectorEmit, config: DownloadConfig | true | undefined) {
    if (config === true || config === undefined) {
      this.extensions = new Set(DEFAULT_EXTENSIONS);
      this.respectDownloadAttr = true;
    } else {
      this.extensions = new Set((config.extensions ?? DEFAULT_EXTENSIONS).map(e => e.toLowerCase().replace(/^\./, '')));
      this.respectDownloadAttr = config.respectDownloadAttr ?? true;
    }
  }

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

    const hasDownloadAttr = this.respectDownloadAttr && anchor.hasAttribute('download');
    let url: URL;
    try { url = new URL(anchor.href, location.href); }
    catch { return; }

    const ext = extractExtension(url.pathname);
    const matchesExtension = ext !== null && this.extensions.has(ext);

    if (!hasDownloadAttr && !matchesExtension) return;

    const fileName = url.pathname.split('/').pop() ?? '';

    this.emit({
      message:  AnalyticsEvent.FileDownload,
      category: ANALYTICS_CATEGORY,
      payload: {
        file_url:       url.href,
        file_name:      fileName || undefined,
        file_extension: ext ?? undefined,
        link_text:      truncate((anchor.textContent ?? '').trim(), 256),
        link_id:        anchor.id || undefined,
      },
    });
  }
}

function extractExtension(pathname: string): string | null {
  const last = pathname.split('/').pop() ?? '';
  const idx = last.lastIndexOf('.');
  if (idx <= 0) return null;
  return last.slice(idx + 1).toLowerCase();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
