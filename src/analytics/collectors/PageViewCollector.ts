import { ANALYTICS_CATEGORY, AnalyticsEvent } from '../vocabulary';
import type { ICollector, CollectorEmit } from './ICollector';

interface PageViewCollectorOptions {
  /** Debounce window for synchronous double-pushes. Default: 100ms. */
  debounceMs?: number;
  /** Skip emission for paths matching these patterns. */
  ignorePaths?: (string | RegExp)[];
  /** Called whenever a page view is emitted — used by EngagementTracker to flush before the boundary. */
  onPageChange?: (toUrl: string, fromUrl: string) => void;
}

/**
 * Auto-emits `page_view` on every navigation:
 * - Initial load (microtask after install)
 * - `history.pushState` / `history.replaceState` (patched)
 * - `popstate` (back/forward)
 * - `hashchange`
 *
 * Captures `page_location`, `page_path`, `page_title`, `page_referrer`.
 * Title is read from `document.title` after a microtask so SPA frameworks
 * that update `<title>` on route change land on the correct page view.
 *
 * The `debounceMs` window collapses synchronous double-pushes (a common
 * pattern in React Router under StrictMode, Next.js shallow routing, etc.)
 * into a single `page_view`.
 */
export class PageViewCollector implements ICollector {
  private readonly debounceMs: number;
  private readonly ignorePaths: (string | RegExp)[];
  private readonly onPageChange: ((toUrl: string, fromUrl: string) => void) | undefined;

  private origPush:    typeof history.pushState    | null = null;
  private origReplace: typeof history.replaceState | null = null;
  private popHandler:  ((e: PopStateEvent) => void) | null = null;
  private hashHandler: ((e: HashChangeEvent) => void) | null = null;
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;
  private prevUrl = '';
  private installed = false;

  constructor(private readonly emit: CollectorEmit, opts: PageViewCollectorOptions = {}) {
    this.debounceMs   = opts.debounceMs   ?? 100;
    this.ignorePaths  = opts.ignorePaths  ?? [];
    this.onPageChange = opts.onPageChange;
  }

  install(): void {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    this.prevUrl = location.href;

    const handle = (): void => this.scheduleEmit();
    this.popHandler  = handle;
    this.hashHandler = handle;
    window.addEventListener('popstate',   this.popHandler);
    window.addEventListener('hashchange', this.hashHandler);

    // Patch pushState / replaceState — these don't fire popstate
    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    this.origPush    = origPush;
    this.origReplace = origReplace;

    history.pushState = function(this: History, data, unused, url) {
      origPush(data, unused, url);
      handle();
    };
    history.replaceState = function(this: History, data, unused, url) {
      origReplace(data, unused, url);
      handle();
    };

    // Initial page view — microtask deferred so SPA `<title>` updates land first
    queueMicrotask(() => this.emitNow());
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    if (typeof window !== 'undefined') {
      if (this.popHandler)  window.removeEventListener('popstate',   this.popHandler);
      if (this.hashHandler) window.removeEventListener('hashchange', this.hashHandler);
    }
    if (this.origPush)    history.pushState    = this.origPush;
    if (this.origReplace) history.replaceState = this.origReplace;
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.origPush = null;
    this.origReplace = null;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private scheduleEmit(): void {
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = null;
      this.emitNow();
    }, this.debounceMs);
  }

  private emitNow(): void {
    const to = location.href;
    if (to === this.prevUrl) return;
    const from = this.prevUrl;
    this.prevUrl = to;

    if (this.shouldIgnore()) return;
    this.onPageChange?.(to, from);

    this.emit({
      message:  AnalyticsEvent.PageView,
      category: ANALYTICS_CATEGORY,
      payload: {
        page_location: to,
        page_path:     location.pathname + location.search + location.hash,
        page_title:    typeof document !== 'undefined' ? document.title : '',
        page_referrer: from || (typeof document !== 'undefined' ? document.referrer : ''),
      },
    });
  }

  private shouldIgnore(): boolean {
    if (typeof location === 'undefined') return false;
    const path = location.pathname;
    return this.ignorePaths.some(p => typeof p === 'string' ? path.includes(p) : p.test(path));
  }
}
