import type { Breadcrumb } from '../../../common/types';

export interface ClickCrumbConfig {
  /**
   * Scope clicks to elements matching this CSS selector.
   * Default: all elements.
   */
  selector?:        string;
  /** Truncate element innerText to this many characters. Default: 80. */
  maxTextLength?:   number;
  /**
   * Skip clicks on elements that match any of these CSS selectors.
   * Useful to suppress breadcrumbs for password inputs, hidden elements, etc.
   */
  ignoreSelectors?: string[];
  /** Return false to drop this breadcrumb. */
  filter?:          (crumb: Breadcrumb) => boolean;
  /** Mutate the breadcrumb before it is added to the buffer. */
  transform?:       (crumb: Breadcrumb) => Breadcrumb;
}

/**
 * Records click breadcrumbs via event delegation on document.
 */
export class ClickCollector {
  private handler: ((e: MouseEvent) => void) | null = null;

  constructor(
    private readonly push:   (crumb: Breadcrumb) => void,
    private readonly config: ClickCrumbConfig,
  ) {}

  install(): void {
    if (typeof document === 'undefined') return;

    const { selector, maxTextLength = 80, ignoreSelectors, filter, transform } = this.config;

    this.handler = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (selector         && !target.closest(selector))                   return;
      if (ignoreSelectors?.some(s => target.closest(s)))                   return;

      const tag  = target.tagName.toLowerCase();
      const id   = target.id || undefined;
      const cls  = typeof target.className === 'string' ? target.className.trim() || undefined : undefined;
      const text = ((target as HTMLElement).innerText ?? '').trim().slice(0, maxTextLength) || undefined;

      const crumb: Breadcrumb = {
        timestamp: Date.now(),
        category:  'click',
        message:   `Click on <${tag}>${id ? `#${id}` : ''}`,
        data: {
          tag,
          ...(id   ? { id }          : {}),
          ...(cls  ? { classes: cls } : {}),
          ...(text ? { text }         : {}),
        },
      };

      if (filter && !filter(crumb)) return;
      this.push(transform ? transform(crumb) : crumb);
    };

    document.addEventListener('click', this.handler, { capture: true });
  }

  uninstall(): void {
    if (typeof document === 'undefined' || !this.handler) return;
    document.removeEventListener('click', this.handler, { capture: true });
    this.handler = null;
  }
}
