import { ANALYTICS_CATEGORY, AnalyticsEvent } from '../vocabulary';
import type { ICollector, CollectorEmit } from './ICollector';

/**
 * Emits `scroll` once per configured depth milestone (default 25/50/75/90%)
 * per page view. Reset between page views via `resetForPageView()`.
 *
 * Uses scroll listener with `requestAnimationFrame` throttling — the
 * IntersectionObserver-on-sentinel approach was considered but breaks on
 * pages with `overflow: auto` containers (the body isn't actually scrolled).
 * Direct scroll measurement on `document.scrollingElement` is the most
 * portable across SPA layouts.
 */
export class ScrollDepthCollector implements ICollector {
  private readonly milestones: number[];
  private fired: Set<number> = new Set();
  private scrollListener: (() => void) | null = null;
  private rafScheduled = false;
  private installed = false;

  constructor(private readonly emit: CollectorEmit, milestones: number[] = [25, 50, 75, 90]) {
    // Defensive — make sure ascending and unique, drop out-of-range
    this.milestones = [...new Set(milestones)]
      .filter(p => p > 0 && p <= 100)
      .sort((a, b) => a - b);
  }

  install(): void {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    const handle = (): void => {
      if (this.rafScheduled) return;
      this.rafScheduled = true;
      requestAnimationFrame(() => {
        this.rafScheduled = false;
        this.check();
      });
    };
    this.scrollListener = handle;
    window.addEventListener('scroll', handle, { capture: true, passive: true });
    // Run once at install in case the page opens deep-linked / pre-scrolled
    handle();
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    if (this.scrollListener && typeof window !== 'undefined') {
      window.removeEventListener('scroll', this.scrollListener, { capture: true } as EventListenerOptions);
    }
    this.scrollListener = null;
  }

  /** Reset milestone tracking between page views. */
  resetForPageView(): void {
    this.fired.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private check(): void {
    if (typeof document === 'undefined') return;
    const scrollEl = document.scrollingElement ?? document.documentElement;
    if (!scrollEl) return;

    const viewport = scrollEl.clientHeight ?? window.innerHeight ?? 0;
    const total    = scrollEl.scrollHeight ?? 0;
    const scrolled = (scrollEl.scrollTop ?? window.scrollY ?? 0) + viewport;

    if (total === 0 || total <= viewport) return; // no scrollable content
    const depthPct = Math.round((scrolled / total) * 100);

    for (const m of this.milestones) {
      if (depthPct >= m && !this.fired.has(m)) {
        this.fired.add(m);
        this.emit({
          message:  AnalyticsEvent.Scroll,
          category: ANALYTICS_CATEGORY,
          payload: { percent_scrolled: m },
        });
      }
    }
  }
}
