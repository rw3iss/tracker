import { ANALYTICS_CATEGORY, AnalyticsEvent } from '../vocabulary';
import type { ICollector, CollectorEmit } from './ICollector';

/**
 * Companion to `PageViewCollector` — when a page view happens for a URL
 * containing a configured search-query parameter (default: `q`, `search`,
 * `query`), additionally emits `view_search_results` with `search_term`.
 *
 * Doesn't observe DOM directly — driven by the `notify()` method, which
 * `AnalyticsPlugin` calls from the `onPageChange` hook of the
 * `PageViewCollector`. Keeps both collectors decoupled from each other; the
 * orchestrator wires them.
 */
export class SearchCollector implements ICollector {
  private readonly searchParams: string[];

  constructor(
    private readonly emit: CollectorEmit,
    searchParams: string[] = ['q', 'search', 'query'],
  ) {
    this.searchParams = searchParams;
  }

  install(): void { /* no listeners — fed via notify() */ }
  uninstall(): void { /* no-op */ }

  /**
   * Called by the orchestrator on each page view. Inspects the URL for a
   * configured search parameter and, if present, emits `view_search_results`.
   */
  notify(url: string): void {
    if (typeof URL === 'undefined') return;
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { return; }

    let searchTerm: string | null = null;
    let paramName: string | null = null;
    for (const name of this.searchParams) {
      const value = parsed.searchParams.get(name);
      if (value && value.length > 0) {
        searchTerm = value;
        paramName  = name;
        break;
      }
    }
    if (!searchTerm) return;

    this.emit({
      message:  AnalyticsEvent.ViewSearchResults,
      category: ANALYTICS_CATEGORY,
      payload: {
        search_term:  searchTerm,
        search_param: paramName,
      },
    });
  }
}
