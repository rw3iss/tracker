import type { TrackerEvent, Breadcrumb, EventType } from '../../common/types';
import type { ITrackerClientPlugin, ITrackerClientRef } from '../ITrackerClientPlugin';
import { NavigationCollector } from './collectors/NavigationCollector';
import type { NavigationCrumbConfig } from './collectors/NavigationCollector';
import { ClickCollector } from './collectors/ClickCollector';
import type { ClickCrumbConfig } from './collectors/ClickCollector';
import { ConsoleCollector } from './collectors/ConsoleCollector';
import type { ConsoleCrumbConfig } from './collectors/ConsoleCollector';
import { NetworkCollector } from './collectors/NetworkCollector';
import type { NetworkCrumbConfig } from './collectors/NetworkCollector';

export type { NavigationCrumbConfig, ClickCrumbConfig, ConsoleCrumbConfig, NetworkCrumbConfig };

/**
 * Interface for custom breadcrumb collectors.
 * Implement this to add your own breadcrumb sources (e.g. WebSocket messages, touch events).
 */
export interface ICollector {
  install():   void;
  uninstall(): void;
}

export interface BreadcrumbsConfig {
  /**
   * Maximum number of breadcrumbs kept in the rolling buffer.
   * Oldest entries are evicted when the buffer is full. Default: 50.
   */
  maxItems?: number;

  /**
   * Attach breadcrumbs only to events whose type is in this list.
   * Default: all event types.
   */
  attachTo?: EventType[];

  /**
   * Clear the buffer after breadcrumbs are attached to a matching event.
   * Default: false — breadcrumbs accumulate continuously.
   */
  clearAfterAttach?: boolean;

  /**
   * Record navigation changes (pushState, replaceState, popstate, hashchange).
   * Pass `true` for defaults, a config object for fine-grained control, or `false` to disable.
   * Default: true.
   */
  navigation?: boolean | NavigationCrumbConfig;

  /**
   * Record click events via event delegation on document.
   * Default: true.
   */
  click?: boolean | ClickCrumbConfig;

  /**
   * Intercept console.warn / console.error output.
   * Default: true (captures warn and error levels).
   */
  console?: boolean | ConsoleCrumbConfig;

  /**
   * Intercept fetch and XMLHttpRequest network requests.
   * Default: true.
   */
  network?: boolean | NetworkCrumbConfig;

  /**
   * Additional custom collectors.
   * Each collector's install() and uninstall() are called with the plugin lifecycle.
   */
  extraCollectors?: ICollector[];
}

/**
 * Client-side plugin that maintains a rolling buffer of recent activity breadcrumbs
 * and attaches them to tracked events as `payload.breadcrumbs`.
 *
 * @example
 * import { BreadcrumbsPlugin } from '@rw3iss/tracker/breadcrumbs';
 *
 * TrackerClient.init({
 *   endpoint: '/tracker/events',
 *   plugins: [
 *     new BreadcrumbsPlugin({
 *       attachTo:          ['error'],
 *       clearAfterAttach:  true,
 *       network: { ignoreUrls: [/\/tracker\//] },
 *     }),
 *   ],
 * });
 */
export class BreadcrumbsPlugin implements ITrackerClientPlugin {
  private readonly buffer:           Breadcrumb[]  = [];
  private readonly maxItems:         number;
  private readonly attachTo?:        EventType[];
  private readonly clearAfterAttach: boolean;
  private readonly collectors:       ICollector[]  = [];

  constructor(private readonly config: BreadcrumbsConfig = {}) {
    this.maxItems         = config.maxItems ?? 50;
    this.attachTo         = config.attachTo;
    this.clearAfterAttach = config.clearAfterAttach ?? false;
  }

  onInit(_client: ITrackerClientRef): void {
    const push = this.push.bind(this);
    const { navigation = true, click = true, console: con = true, network = true, extraCollectors = [] } = this.config;

    if (navigation !== false) this.collectors.push(new NavigationCollector(push, navigation === true ? {} : navigation));
    if (click      !== false) this.collectors.push(new ClickCollector     (push, click      === true ? {} : click));
    if (con        !== false) this.collectors.push(new ConsoleCollector   (push, con        === true ? {} : con));
    if (network    !== false) this.collectors.push(new NetworkCollector   (push, network    === true ? {} : network));

    for (const c of extraCollectors) this.collectors.push(c);
    for (const c of this.collectors) c.install();
  }

  onCapture(event: TrackerEvent): TrackerEvent {
    if (this.buffer.length === 0) return event;
    if (this.attachTo && !this.attachTo.includes(event.type)) return event;

    const breadcrumbs = [...this.buffer];
    if (this.clearAfterAttach) this.buffer.length = 0;

    return {
      ...event,
      payload: { ...event.payload, breadcrumbs },
    };
  }

  onDestroy(): void {
    for (const c of this.collectors) c.uninstall();
    this.collectors.length = 0;
  }

  /**
   * Manually add a breadcrumb to the buffer.
   * Useful for application-level events not covered by the built-in collectors.
   */
  addBreadcrumb(crumb: Omit<Breadcrumb, 'timestamp'> & { timestamp?: number }): void {
    this.push({ ...crumb, timestamp: crumb.timestamp ?? Date.now() });
  }

  /** Snapshot of the current buffer (read-only copy). */
  getBreadcrumbs(): Breadcrumb[] {
    return [...this.buffer];
  }

  /** Clear the buffer. */
  clear(): void {
    this.buffer.length = 0;
  }

  private push(crumb: Breadcrumb): void {
    if (this.buffer.length >= this.maxItems) this.buffer.shift();
    this.buffer.push(crumb);
  }
}
