import type { ITrackerClientPlugin, ITrackerClientRef } from '../emitter/ITrackerClientPlugin';
import type { TrackerEvent } from '../common/types';
import { ANALYTICS_CATEGORY, AnalyticsEvent, DEFAULT_STORAGE_PREFIX } from './vocabulary';
import { ANALYTICS_DEFAULTS } from './types';
import { VisitorManager } from './VisitorManager';
import { SessionLifecycle } from './SessionLifecycle';
import { AttributionStore } from './AttributionStore';
import { ConsentGate } from './ConsentGate';
import { EngagementTracker } from './EngagementTracker';

/**
 * Identity snapshot returned by `AnalyticsPlugin.snapshot()`. Matches the
 * `IIdentitySource` interface in `@rw3iss/tracker/ga` so the analytics
 * plugin can be passed directly as a GA `identitySource`. Decoupled here
 * via a structural type so `/analytics` doesn't import from `/ga`.
 */
export interface AnalyticsIdentitySnapshot {
  clientId?:  string;
  sessionId?: string;
  userId?:    string;
}
import {
  PageViewCollector,
  ScrollDepthCollector,
  OutboundLinkCollector,
  DownloadCollector,
  FormCollector,
  SearchCollector,
  type ICollector,
  type CollectorEmit,
} from './collectors';
import type {
  AnalyticsConfig,
  EngagementConfig,
  FormConfig,
  DownloadConfig,
  UtmConfig,
} from './types';

/**
 * Auto-emits a stable analytics vocabulary by composing the collectors,
 * lifecycle pieces, and consent gate.
 *
 * Wire it up once at `TrackerClient.init`:
 *
 * ```typescript
 * import { TrackerClient } from '@rw3iss/tracker';
 * import { AnalyticsPlugin } from '@rw3iss/tracker/analytics';
 *
 * TrackerClient.init({
 *   endpoint: 'https://tracker.example.com/ingest/events',
 *   appId:    'my-app',
 *   plugins:  [new AnalyticsPlugin({ ...overrides })],
 * });
 * ```
 *
 * Default config produces a GA4-equivalent enhanced-measurement set: page
 * views, sessions (with attribution), engagement time, scroll depth, outbound
 * clicks, file downloads, form interactions. Pass `false` for any individual
 * collector to disable, or override config object.
 *
 * The plugin is decoupled from the rest of the tracker — it consumes only the
 * `ITrackerClientPlugin` lifecycle hooks (`onInit`/`onCapture`/`onDestroy`)
 * and the `ITrackerClientRef.capture()` method.
 */
export class AnalyticsPlugin implements ITrackerClientPlugin {
  /** Plugin name — readable by `tracker.getPlugin('AnalyticsPlugin')` if exposed. */
  static readonly PLUGIN_NAME = 'AnalyticsPlugin';
  readonly name = AnalyticsPlugin.PLUGIN_NAME;

  // Lifecycle pieces
  private readonly visitor:     VisitorManager;
  private readonly sessionLife: SessionLifecycle;
  private readonly attribution: AttributionStore;
  private readonly consent:     ConsentGate;
  private readonly engagement:  EngagementTracker | null;

  // Collectors
  private readonly collectors: ICollector[] = [];
  private readonly scrollDepth: ScrollDepthCollector | null = null;
  private readonly search: SearchCollector | null = null;

  // Sampling
  private readonly sampleRate:     number;
  private readonly alwaysEmitSet:  Set<string> | null;
  private readonly alwaysEmitWhen: ((event: TrackerEvent) => boolean) | undefined;

  // Filtering
  private readonly ignorePathPatterns: (string | RegExp)[];

  // State
  private clientRef: ITrackerClientRef | null = null;
  /** Tracks the last-seen userId on the client context, for identity-merge events. */
  private lastSeenUserId: string | null = null;
  /** Throttle handle for `setUserId` change detection. */
  private identityCheckHandle: ReturnType<typeof setInterval> | null = null;
  private readonly emitIdentityMergeEvent: boolean;
  private readonly ipAnonymization: boolean;
  private readonly storagePrefix:  string;

  constructor(private readonly config: AnalyticsConfig = {}) {
    this.storagePrefix = config.storagePrefix ?? DEFAULT_STORAGE_PREFIX;

    // Lifecycle pieces
    this.visitor     = new VisitorManager(config.visitor, this.storagePrefix);
    this.sessionLife = new SessionLifecycle(config.sessions, this.storagePrefix);
    this.attribution = new AttributionStore(
      this.coerceUtm(config.utm),
      config.referrer ?? ANALYTICS_DEFAULTS.referrer,
      config.ignoreReferrers ?? [],
      this.storagePrefix,
    );
    this.consent = new ConsentGate(config.consent, config.respectDoNotTrack ?? ANALYTICS_DEFAULTS.respectDoNotTrack);

    // Engagement tracker (optional)
    this.engagement = config.engagement === false
      ? null
      : new EngagementTracker(this.coerceEngagement(config.engagement));

    // Sampling
    this.sampleRate     = config.sampleRate ?? ANALYTICS_DEFAULTS.sampleRate;
    this.alwaysEmitSet  = config.alwaysEmit ? new Set(config.alwaysEmit) : null;
    this.alwaysEmitWhen = config.alwaysEmitWhen;

    // Filtering
    this.ignorePathPatterns = config.ignorePaths ?? [];

    // Identity merge
    this.emitIdentityMergeEvent = config.emitIdentityMergeEvent ?? ANALYTICS_DEFAULTS.emitIdentityMergeEvent;
    this.ipAnonymization        = config.ipAnonymization ?? ANALYTICS_DEFAULTS.ipAnonymization;

    // ── Build collectors ─────────────────────────────────────────────────
    const emit = this.makeEmit();

    if (config.scrollDepth !== false) {
      const milestones = Array.isArray(config.scrollDepth) ? config.scrollDepth : ANALYTICS_DEFAULTS.scrollDepth;
      const c = new ScrollDepthCollector(emit, milestones);
      this.scrollDepth = c;
      this.collectors.push(c);
    }

    if (config.pageViews !== false) {
      this.collectors.push(new PageViewCollector(emit, {
        debounceMs:   config.pageViewDebounceMs ?? ANALYTICS_DEFAULTS.pageViewDebounceMs,
        ignorePaths:  this.ignorePathPatterns,
        onPageChange: (to, _from) => {
          // Page boundary — flush engagement, reset scroll milestones, fire search if applicable.
          this.engagement?.flush();
          this.scrollDepth?.resetForPageView();
          this.search?.notify(to);
        },
      }));
    }

    if (config.outboundClicks !== false) {
      this.collectors.push(new OutboundLinkCollector(emit));
    }

    if (config.fileDownloads !== false) {
      this.collectors.push(new DownloadCollector(emit, this.coerceDownloads(config.fileDownloads)));
    }

    if (config.forms !== false) {
      this.collectors.push(new FormCollector(emit, this.coerceForms(config.forms)));
    }

    {
      const c = new SearchCollector(emit, config.searchParams ?? ANALYTICS_DEFAULTS.searchParams);
      this.search = c;
      this.collectors.push(c);
    }

    // Engagement tracker pushes events through the same emit pipeline.
    if (this.engagement) {
      this.engagement.onEmit = (engagement_time_msec) => {
        emit({
          message:  AnalyticsEvent.UserEngagement,
          category: ANALYTICS_CATEGORY,
          payload: { engagement_time_msec },
        });
      };
    }

    // Wire session lifecycle → emission
    this.sessionLife.onSessionStart = (state) => {
      // Attribution is captured for each new session.
      const attr = this.attribution.captureForNewSession();
      emit({
        message:  AnalyticsEvent.SessionStart,
        category: ANALYTICS_CATEGORY,
        payload: { session_number: state.number, session_start_ts: state.startTs, ...attr },
      });
    };
    this.sessionLife.onSessionEnd = (state) => {
      emit({
        message:  AnalyticsEvent.SessionEnd,
        category: ANALYTICS_CATEGORY,
        payload: { session_number: state.number, session_duration_ms: Date.now() - state.startTs },
      });
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  //  ITrackerClientPlugin lifecycle
  // ──────────────────────────────────────────────────────────────────────

  onInit(client: ITrackerClientRef): void {
    this.clientRef = client;

    // First visit emit (before session_start, so it's the very first event).
    this.consent.defer(() => {
      const _id = this.visitor.getId();
      if (this.visitor.isFirstVisit()) {
        this.captureRaw({
          message:  AnalyticsEvent.FirstVisit,
          category: ANALYTICS_CATEGORY,
          payload: {},
        });
      }
      // Touch session — emits session_start lazily.
      this.sessionLife.getSessionId();
    });

    // Install collectors.
    for (const c of this.collectors) {
      try { c.install(); }
      catch { /* one bad collector shouldn't break the rest */ }
    }
    this.engagement?.install();

    // Identity-merge: poll the context for userId changes once per second.
    // Cheap (single getter), and reliable across all the ways `setContext`
    // can be called — no observer hook on TrackerClient is required.
    this.identityCheckHandle = setInterval(() => this.checkIdentity(), 1000);
    this.checkIdentity();
  }

  /**
   * Synchronous transform — called for every event the host emits, including
   * the analytics events we ourselves emit (we tag those with
   * `category === 'analytics'` and skip stamping to avoid recursion).
   *
   * Stamps:
   * - visitor `client_id`
   * - session `session_id`, `session_number`, `is_first_visit`
   * - attribution payload (UTM, referrer)
   * - `ip_anonymization` hint
   *
   * Then applies sampling — if the event isn't in the always-emit set or
   * passes the predicate, dropped events return `null` from a sentinel value
   * inside the payload. Since `onCapture` must return a `TrackerEvent`, we
   * use a marker that the host's `beforeSend` config can drop... but a cleaner
   * approach is to gate via consent + sampling at emission time and let
   * non-analytics events pass through unmodified.
   */
  onCapture(event: TrackerEvent): TrackerEvent {
    // Pass-through for events that aren't ours and not sampling candidates.
    // Other plugins/hosts emit errors, info, etc — we don't sample those.
    const isOurs = event.category === ANALYTICS_CATEGORY || event.category === 'ecommerce';

    // Stamp analytics context onto our own events. We also stamp some pieces
    // (client_id, session_id) onto every event so consumers can correlate
    // errors with the same visitor + session.
    const clientId  = this.visitor.getId();
    const sessionId = this.sessionLife.getSessionId();
    const sessionState = this.sessionLife.getState();
    this.sessionLife.markActive();

    const enrichedPayload: Record<string, unknown> = {
      ...(event.payload ?? {}),
      client_id:  clientId,
      session_id: sessionId,
    };
    if (isOurs) {
      enrichedPayload.session_number = sessionState.number;
      // Stamp attribution onto every analytics event in the session.
      const attr = this.attribution.getStamp();
      for (const [k, v] of Object.entries(attr)) {
        if (v !== undefined && enrichedPayload[k] === undefined) enrichedPayload[k] = v;
      }
      if (this.ipAnonymization) enrichedPayload.ip_anonymization = true;
    }

    return { ...event, payload: enrichedPayload };
  }

  onDestroy(): void {
    if (this.identityCheckHandle !== null) clearInterval(this.identityCheckHandle);
    this.identityCheckHandle = null;
    this.engagement?.flush();
    this.engagement?.destroy();
    for (const c of this.collectors) try { c.uninstall(); } catch { /* swallow */ }
    this.sessionLife.destroy();
    this.clientRef = null;
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────────────────────────────────

  /** Visitor's long-lived `client_id`. Stable across sessions. */
  getClientId(): string {
    return this.visitor.getId();
  }

  /** Current `session_id`. Stable for the duration of a single session. */
  getSessionId(): string {
    return this.sessionLife.getSessionId();
  }

  /**
   * Snapshot of the current identity — visitor / session / user IDs.
   *
   * Implements the `IIdentitySource` shape consumed by
   * `@rw3iss/tracker/ga`'s `GoogleAnalyticsPlugin.identitySource`. Pass
   * an `AnalyticsPlugin` instance directly into the GA plugin's options
   * and the two systems will share `client_id` / `session_id` / `user_id`.
   *
   * Returns a fresh object on every call — safe to mutate the result
   * without affecting plugin state. Fields are omitted (left `undefined`)
   * when the underlying source isn't ready or the user isn't identified.
   */
  snapshot(): AnalyticsIdentitySnapshot {
    return {
      clientId:  this.visitor.getId(),
      sessionId: this.sessionLife.getSessionId(),
      userId:    this.lastSeenUserId ?? undefined,
    };
  }

  /**
   * Reset the visitor identity. Next emit will create a new `client_id` and
   * fire `first_visit` again. Use on consent revocation or explicit "forget me"
   * flows.
   */
  resetVisitor(): void {
    this.visitor.reset();
    this.attribution.reset();
  }

  /** Force a session rotation — emits `session_end` then `session_start`. */
  rotateSession(): void {
    this.sessionLife.rotate();
  }

  /** Grant consent imperatively (alternative to `consent.waitFor` config). */
  grantConsent(): void {
    this.consent.grant();
  }

  /** Revoke consent imperatively. Future emits are dropped until granted again. */
  revokeConsent(): void {
    this.consent.revoke();
    this.resetVisitor();
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Internals
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Emit hook handed to every collector. Applies consent gating + sampling.
   * The actual `client.capture()` call happens here; collectors stay pure.
   */
  private makeEmit(): CollectorEmit {
    return (partial) => {
      this.consent.defer(() => {
        if (!this.shouldEmit(partial)) return;
        this.captureRaw(partial);
      });
    };
  }

  /**
   * Bypass the emit gate (consent already cleared, sampling skipped) — used
   * for first_visit/session_start/identity-merge events. The TrackerClient's
   * own pipeline still runs (enrichers, plugins, beforeSend) as normal.
   */
  private captureRaw(partial: { message: string; category?: string; payload?: Record<string, unknown>; tags?: string[] }): void {
    if (!this.clientRef) return;
    this.clientRef.capture({
      type:     'event',
      message:  partial.message,
      category: partial.category,
      payload:  partial.payload ?? {},
      tags:     partial.tags,
    });
  }

  /** Sampling + always-emit check. */
  private shouldEmit(partial: { message: string }): boolean {
    if (this.sampleRate >= 1.0) return true;
    if (this.alwaysEmitSet?.has(partial.message)) return true;
    if (this.alwaysEmitWhen) {
      // Build a minimal event for the predicate.
      const fakeEvent: TrackerEvent = {
        type:      'event',
        message:   partial.message,
        timestamp: Date.now(),
      };
      if (this.alwaysEmitWhen(fakeEvent)) return true;
    }
    return Math.random() < this.sampleRate;
  }

  /**
   * Polls the `TrackerClient`'s context for userId changes. When the user
   * signs in (anonymous → identified) we emit `user_identified` so the
   * consumer can backfill prior anonymous events to the new userId. When the
   * user signs out we emit `user_anonymized`.
   */
  private checkIdentity(): void {
    if (!this.clientRef) return;
    const ctx = this.clientRef.getContext();
    const current = ctx.userId ?? null;
    if (current === this.lastSeenUserId) return;
    const previous = this.lastSeenUserId;
    this.lastSeenUserId = current;
    if (!this.emitIdentityMergeEvent) return;

    if (previous === null && current !== null) {
      // anonymous → identified
      this.captureRaw({
        message:  AnalyticsEvent.UserIdentified,
        category: ANALYTICS_CATEGORY,
        payload: { user_id: current, client_id: this.visitor.getId() },
      });
    } else if (previous !== null && current === null) {
      // identified → anonymous
      this.captureRaw({
        message:  AnalyticsEvent.UserAnonymized,
        category: ANALYTICS_CATEGORY,
        payload: { previous_user_id: previous, client_id: this.visitor.getId() },
      });
    }
  }

  // ── Config coercion (boolean shortcuts → full configs) ────────────────

  private coerceUtm(utm: AnalyticsConfig['utm']): UtmConfig | undefined {
    if (utm === false) return undefined;
    if (utm === true || utm === undefined) return ANALYTICS_DEFAULTS.utm;
    return { ...ANALYTICS_DEFAULTS.utm, ...utm };
  }

  private coerceEngagement(eng: AnalyticsConfig['engagement']): EngagementConfig {
    if (eng === true || eng === undefined) return ANALYTICS_DEFAULTS.engagement;
    if (eng === false) return ANALYTICS_DEFAULTS.engagement; // unreachable — handled at construction
    return { ...ANALYTICS_DEFAULTS.engagement, ...eng };
  }

  private coerceForms(forms: AnalyticsConfig['forms']): FormConfig {
    if (forms === true || forms === undefined) return ANALYTICS_DEFAULTS.forms;
    if (forms === false) return { start: false, submit: false };
    return { ...ANALYTICS_DEFAULTS.forms, ...forms };
  }

  private coerceDownloads(d: AnalyticsConfig['fileDownloads']): DownloadConfig {
    if (d === true || d === undefined) return ANALYTICS_DEFAULTS.fileDownloads;
    if (d === false) return { extensions: [], respectDownloadAttr: false };
    return { ...ANALYTICS_DEFAULTS.fileDownloads, ...d };
  }
}
