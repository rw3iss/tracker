import type { Breadcrumb } from '../../../common/types';

export interface NavigationCrumbConfig {
  /** Skip breadcrumbs for URLs matching these patterns. */
  ignoreUrls?: (string | RegExp)[];
  /** Return false to drop this breadcrumb. */
  filter?:     (crumb: Breadcrumb) => boolean;
  /** Mutate the breadcrumb before it is added to the buffer. */
  transform?:  (crumb: Breadcrumb) => Breadcrumb;
}

/**
 * Records navigation breadcrumbs on pushState, replaceState, popstate, and hashchange.
 */
export class NavigationCollector {
  private origPush:    typeof history.pushState    | null = null;
  private origReplace: typeof history.replaceState | null = null;
  private popHandler:  (() => void) | null = null;
  private hashHandler: (() => void) | null = null;
  private prevUrl:     string;

  constructor(
    private readonly push:   (crumb: Breadcrumb) => void,
    private readonly config: NavigationCrumbConfig,
  ) {
    this.prevUrl = typeof location !== 'undefined' ? location.href : '';
  }

  install(): void {
    if (typeof window === 'undefined') return;

    const self = this;
    const handleNav = () => {
      const to = location.href;
      if (to === self.prevUrl) return;
      const from = self.prevUrl;
      self.prevUrl = to;
      self.emit({ category: 'navigation', message: `Navigate to ${to}`, data: { from, to } });
    };

    this.popHandler  = handleNav;
    this.hashHandler = handleNav;
    window.addEventListener('popstate',   this.popHandler);
    window.addEventListener('hashchange', this.hashHandler);

    // Monkey-patch pushState / replaceState — these don't fire popstate
    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    this.origPush    = origPush;
    this.origReplace = origReplace;

    history.pushState = function(this: History, data, unused, url) {
      origPush(data, unused, url);
      handleNav();
    };
    history.replaceState = function(this: History, data, unused, url) {
      origReplace(data, unused, url);
      handleNav();
    };
  }

  uninstall(): void {
    if (typeof window === 'undefined') return;
    if (this.popHandler)  window.removeEventListener('popstate',   this.popHandler);
    if (this.hashHandler) window.removeEventListener('hashchange', this.hashHandler);
    if (this.origPush)    history.pushState    = this.origPush;
    if (this.origReplace) history.replaceState = this.origReplace;
    this.origPush    = null;
    this.origReplace = null;
  }

  private emit(partial: Omit<Breadcrumb, 'timestamp' | 'level'>): void {
    const crumb: Breadcrumb = { ...partial, timestamp: Date.now() };
    const { ignoreUrls, filter, transform } = this.config;
    const to = (crumb.data?.to as string) ?? '';
    if (ignoreUrls?.some(p => typeof p === 'string' ? to.includes(p) : p.test(to))) return;
    if (filter && !filter(crumb)) return;
    this.push(transform ? transform(crumb) : crumb);
  }
}
