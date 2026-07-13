import type { EngagementConfig } from './types';

const DEFAULT_SIGNALS: string[] = ['mousemove', 'keydown', 'scroll', 'touchstart', 'click'];

/**
 * Reproduces GA4's `engagement_time_msec` — accumulated active time per page.
 *
 * "Active" means: the document is foreground (`visibilityState === 'visible'`)
 * AND the user has produced at least one signal event (mouse / key / scroll
 * / touch / click) within the last `idleTimeoutMs` window.
 *
 * Implementation: a single 1-second tick increments the accumulator when
 * both conditions hold. Signal events update a shared "lastActivityAt"
 * timestamp. The Visibility API toggles a flag rather than starting/stopping
 * the tick, keeping CPU overhead constant. All signal listeners are passive
 * and capture-phase to minimize host impact.
 *
 * Periodic flushes (default every 30s) emit the accumulator via the
 * configured `onEmit` callback and reset it to zero. The host should also
 * call `flush()` on page change and `pagehide`.
 */
export class EngagementTracker {
  private readonly idleTimeoutMs:  number;
  private readonly flushIntervalMs: number;
  private readonly signals:        string[];

  /** Cumulative active time (ms) since the last flush. */
  private accumulatorMs = 0;
  /** Timestamp of the last user signal — used to determine idle vs active. */
  private lastActivityAt = 0;
  private foreground     = true;
  private installed      = false;

  private tickHandle:   ReturnType<typeof setInterval> | null = null;
  private flushHandle:  ReturnType<typeof setInterval> | null = null;
  private signalListener: ((event: Event) => void) | null = null;
  private visibilityListener: (() => void) | null = null;

  /** Called on each periodic flush AND on `flush()`. Receives accumulated ms since last emit. */
  onEmit: (engagementTimeMs: number) => void = () => {};

  constructor(config?: EngagementConfig) {
    this.idleTimeoutMs   = config?.idleTimeoutMs   ?? 30_000;
    this.flushIntervalMs = config?.flushIntervalMs ?? 30_000;
    this.signals         = config?.signals         ?? DEFAULT_SIGNALS;
  }

  /**
   * Install signal listeners + start tick + start periodic flush. Idempotent.
   */
  install(): void {
    if (this.installed || typeof document === 'undefined') return;
    this.installed = true;
    this.foreground = document.visibilityState === 'visible';
    this.lastActivityAt = Date.now();

    const onSignal = (): void => { this.lastActivityAt = Date.now(); };
    this.signalListener = onSignal;
    for (const sig of this.signals) {
      window.addEventListener(sig, onSignal, { capture: true, passive: true });
    }

    const onVis = (): void => { this.foreground = document.visibilityState === 'visible'; };
    this.visibilityListener = onVis;
    document.addEventListener('visibilitychange', onVis);

    // 1Hz tick — increments accumulator if foreground AND not idle
    this.tickHandle = setInterval(() => {
      if (!this.foreground) return;
      if ((Date.now() - this.lastActivityAt) > this.idleTimeoutMs) return;
      this.accumulatorMs += 1000;
    }, 1000);

    // Periodic flush
    this.flushHandle = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  /**
   * Emit accumulated engagement time and reset the accumulator. Safe to
   * call when accumulator is zero (no-op).
   */
  flush(): void {
    if (this.accumulatorMs === 0) return;
    const ms = this.accumulatorMs;
    this.accumulatorMs = 0;
    try { this.onEmit(ms); }
    catch { /* one bad emit shouldn't break tracking */ }
  }

  /** Reset the accumulator without emitting. Used between page-view boundaries. */
  reset(): void {
    this.accumulatorMs = 0;
  }

  /** Detach listeners + stop timers. */
  destroy(): void {
    if (!this.installed) return;
    this.installed = false;
    if (this.tickHandle  !== null) clearInterval(this.tickHandle);
    if (this.flushHandle !== null) clearInterval(this.flushHandle);
    this.tickHandle = null;
    this.flushHandle = null;
    if (this.signalListener) {
      for (const sig of this.signals) {
        window.removeEventListener(sig, this.signalListener, { capture: true } as EventListenerOptions);
      }
    }
    if (this.visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
    }
    this.signalListener = null;
    this.visibilityListener = null;
  }
}
