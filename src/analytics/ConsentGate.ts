import type { ConsentConfig } from './types';

type ConsentState = 'unknown' | 'granted' | 'denied';

/**
 * Gates analytics emission on user consent.
 *
 * When `required: false` (default) the gate is always open — `isOpen()` is
 * `true`, no buffering happens, the host doesn't need to think about consent.
 *
 * When `required: true`:
 * - `granted` predicate is checked first on every event — if it returns
 *   `true`, the gate is open
 * - Otherwise the gate buffers calls to `defer(fn)` and waits for `waitFor`
 *   to resolve, at which point `granted` is re-checked and any deferred
 *   replays fire if it now resolves true
 * - If neither `granted` nor `waitFor` is set, the gate is permanently
 *   closed (analytics is wired but disabled — useful in CI/test environments)
 *
 * `respectDoNotTrack: true` short-circuits everything — the gate is
 * permanently closed regardless of consent config when the browser has DNT
 * set. Hosts that want to override DNT can pass `respectDoNotTrack: false`.
 */
export class ConsentGate {
  private state: ConsentState = 'unknown';
  private readonly required:  boolean;
  private readonly granted:   (() => boolean) | undefined;
  private readonly waitFor:   Promise<unknown> | undefined;
  private readonly dntDenied: boolean;
  /**
   * Functions queued while the gate was closed. Replayed (in order, once)
   * on consent grant. Capped at 200 entries to prevent unbounded memory
   * growth from a permanently-closed gate.
   */
  private deferred: Array<() => void> = [];
  private resolvedFinal = false;

  constructor(config: ConsentConfig | undefined, respectDoNotTrack: boolean) {
    this.required = config?.required ?? false;
    this.granted  = config?.granted;
    this.waitFor  = config?.waitFor;
    this.dntDenied = respectDoNotTrack && hasDoNotTrack();

    if (!this.required) {
      this.state = 'granted';
      this.resolvedFinal = true;
    } else if (this.dntDenied) {
      this.state = 'denied';
      this.resolvedFinal = true;
    } else if (this.waitFor) {
      // Async resolution — flip state when the promise settles.
      this.waitFor.then(
        () => this.evaluate(),
        () => { this.state = 'denied'; this.resolvedFinal = true; this.deferred = []; },
      );
    }
  }

  /** Synchronous open check. Re-evaluates `granted` on every call. */
  isOpen(): boolean {
    if (this.state === 'granted') return true;
    if (this.dntDenied)            return false;
    if (this.granted && this.granted()) {
      this.state = 'granted';
      this.flushDeferred();
      return true;
    }
    return false;
  }

  /**
   * If the gate is open, run `fn` immediately. Otherwise queue it for later
   * — replayed once when consent grants. Used for `first_visit` and
   * `session_start` events that we want to fire eventually if consent
   * arrives, rather than dropping silently.
   */
  defer(fn: () => void): void {
    if (this.isOpen()) {
      fn();
      return;
    }
    if (this.resolvedFinal) return; // permanently closed — don't buffer
    if (this.deferred.length < 200) this.deferred.push(fn);
  }

  /** Force an explicit grant — usually called by integration code from `waitFor`'s `.then`. */
  grant(): void {
    if (this.dntDenied) return; // DNT wins
    this.state = 'granted';
    this.resolvedFinal = true;
    this.flushDeferred();
  }

  /** Force revocation — clears any deferred replays. */
  revoke(): void {
    this.state = 'denied';
    this.resolvedFinal = true;
    this.deferred = [];
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private evaluate(): void {
    this.resolvedFinal = true;
    if (this.granted) {
      if (this.granted()) this.grant();
      else                this.revoke();
    } else {
      // No predicate but waitFor resolved — assume grant.
      this.grant();
    }
  }

  private flushDeferred(): void {
    const queued = this.deferred;
    this.deferred = [];
    for (const fn of queued) {
      try { fn(); } catch { /* one bad replay shouldn't break the rest */ }
    }
  }
}

function hasDoNotTrack(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Various browsers expose DNT differently; check the known signal sites.
  const sources: (string | undefined | null)[] = [
    (navigator as Navigator & { doNotTrack?: string | null }).doNotTrack,
    (navigator as Navigator & { msDoNotTrack?: string | null }).msDoNotTrack,
    (typeof window !== 'undefined' ? (window as Window & { doNotTrack?: string | null }).doNotTrack : null),
  ];
  return sources.some(v => v === '1' || v === 'yes');
}
