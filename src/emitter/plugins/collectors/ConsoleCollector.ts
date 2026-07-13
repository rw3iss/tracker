import type { Breadcrumb, BreadcrumbLevel } from '../../../common/types';

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

const LEVEL_MAP: Record<ConsoleLevel, BreadcrumbLevel> = {
  log:   'info',
  info:  'info',
  debug: 'debug',
  warn:  'warning',
  error: 'error',
};

export interface ConsoleCrumbConfig {
  /**
   * Console methods to intercept.
   * Default: ['warn', 'error']
   */
  levels?:    ConsoleLevel[];
  /** Return false to drop this breadcrumb. */
  filter?:    (crumb: Breadcrumb) => boolean;
  /** Mutate the breadcrumb before it is added to the buffer. */
  transform?: (crumb: Breadcrumb) => Breadcrumb;
}

/**
 * Records console output breadcrumbs by monkey-patching console methods.
 * The original method is always called — this is non-destructive.
 */
export class ConsoleCollector {
  private originals: Partial<Record<ConsoleLevel, (...args: unknown[]) => void>> = {};

  constructor(
    private readonly push:   (crumb: Breadcrumb) => void,
    private readonly config: ConsoleCrumbConfig,
  ) {}

  install(): void {
    const { levels = ['warn', 'error'], filter, transform } = this.config;
    const self = this;

    for (const level of levels) {
      // Store unbound reference so uninstall() restores the exact same function object
      const orig = (console as any)[level] as (...args: unknown[]) => void;
      this.originals[level] = orig;

      // eslint-disable-next-line no-loop-func
      (console as any)[level] = function (...args: unknown[]) {
        orig.call(console, ...args);
        const message = args
          .map(a => (typeof a === 'string' ? a : safeStringify(a)))
          .join(' ')
          .slice(0, 200);
        const crumb: Breadcrumb = {
          timestamp: Date.now(),
          category:  'console',
          message,
          level:     LEVEL_MAP[level],
        };
        if (filter && !filter(crumb)) return;
        self.push(transform ? transform(crumb) : crumb);
      };
    }
  }

  uninstall(): void {
    for (const [level, orig] of Object.entries(this.originals) as [ConsoleLevel, (...args: unknown[]) => void][]) {
      (console as any)[level] = orig;
    }
    this.originals = {};
  }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}
