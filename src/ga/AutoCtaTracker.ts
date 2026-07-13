/**
 * Global click delegator that auto-emits CTA events for elements matching
 * a configurable selector. One listener at the document root handles every
 * click in the page, so authors don't have to wire `onClick` handlers on
 * each button/link they want tracked — they just add a `data-cta-id`
 * attribute and the click is captured.
 *
 * Decoupled from gtag and from the GoogleAnalyticsPlugin: takes an `emit`
 * callback at construction. Can be reused for any tracker pipeline (e.g.
 * the analytics plugin's tracker.event() flow) by passing a different
 * `emit`.
 *
 * @example
 * ```typescript
 * // Manual usage:
 * const tracker = new AutoCtaTracker(
 *   (name, params) => myAnalytics.fire(name, params),
 *   { selector: '[data-cta-id], [data-cta]', fallback: ['id', 'text'] },
 * );
 * tracker.install();
 *
 * // From the GA plugin:
 * ga.installAutoTracking();
 * ```
 */

/**
 * Sources `AutoCtaTracker` can fall back to when the primary attribute is
 * missing. Both the named tokens (`'id'`, `'text'`, `'class'`, `'href'`)
 * and the bare attribute aliases (`'cta-id'`, `'data-cta-id'`, `'data-cta'`)
 * are supported as ergonomic shortcuts; `'attr:<name>'` remains the escape
 * hatch for any other attribute name.
 *
 * Why dedicated aliases for `cta-id` / `data-cta-id` / `data-cta`: these
 * are the three names everyone actually writes in markup, and forcing
 * authors to remember the `attr:` prefix for them produced TypeScript
 * errors and a lot of "why doesn't `'cta-id'` just work" questions.
 */
export type CtaIdFallback =
    | 'id'              // element's `id` attribute
    | 'text'            // textContent (slugified, max 64 chars)
    | 'class'           // first class name
    | 'href'            // pathname (anchors only)
    | 'cta-id'          // value of the `cta-id` attribute (no `data-` prefix)
    | 'data-cta-id'     // value of the `data-cta-id` attribute
    | 'data-cta'        // value of the `data-cta` attribute
    | `attr:${string}`; // any other HTML attribute, e.g. 'attr:aria-label'

export interface AutoCtaTrackerOptions {
    /**
     * CSS selector matched via `closest()` on the click target.
     * Default: `'[data-cta-id], [data-cta], [cta-id]'` — picks up authors
     * using either the standard `data-` prefixed names or the shorter
     * `cta-id` form (common in legacy/HTML-template codebases).
     *
     * To track ALL buttons + links regardless of attributes, use
     * `'button, a'` and configure `fallback: ['id', 'text']`.
     */
    selector?: string;

    /**
     * Primary attribute to use as the CTA identifier.
     * Default: `'data-cta-id'`.
     */
    idAttribute?: string;

    /**
     * Fallback sources to try when the primary attribute is absent.
     * Tried in order, first non-empty wins. Default:
     * `['cta-id', 'data-cta', 'id', 'text']`.
     */
    fallback?: CtaIdFallback[];

    /**
     * GA event name to fire. Default: `'cta_click'`.
     */
    eventName?: string;

    /**
     * Include all `data-*` attributes (other than `data-cta-id` /
     * `data-cta`) in the event payload as `cta_<name>` keys. Useful for
     * carrying things like `data-cta-section="hero"` through to GA.
     * Default: `true`.
     */
    captureDataAttrs?: boolean;

    /**
     * Custom enrichment hook. Return additional params to merge into the
     * event payload. Return `null` to skip the event entirely.
     */
    enrich?: (el: Element, event: MouseEvent) => Record<string, unknown> | null;

    /**
     * Filter — return `false` to skip an element. Runs before enrich.
     * Useful for excluding internal-only buttons from tracking.
     */
    filter?: (el: Element, event: MouseEvent) => boolean;
}

/** Default selector — picks up both `data-`-prefixed and bare `cta-id`. */
const DEFAULT_SELECTOR = '[data-cta-id], [data-cta], [cta-id]';

/**
 * Default fallback chain — tried in order when the primary attribute
 * (`data-cta-id`) is absent. Covers the three CTA-id attribute names
 * authors actually write, then degrades to id and text.
 */
const DEFAULT_FALLBACK: CtaIdFallback[] = ['cta-id', 'data-cta', 'id', 'text'];

/**
 * Maximum text length captured as `cta_text` / used for slugification.
 * Caps payload size and protects from accidentally shipping page-length
 * descriptions through to GA.
 */
const MAX_TEXT_LEN = 128;

/**
 * Global delegated-click handler that fires CTA events for matching
 * elements. Single listener at the document root with capture-phase
 * passive semantics — minimal overhead, works with dynamically-added
 * elements (no re-binding needed).
 */
export class AutoCtaTracker {
    private listener: ((event: MouseEvent) => void) | null = null;
    private installed = false;

    /**
     * @param emit  Function called once per matched click —
     *              `(eventName, params)`. Wire this to gtag('event', ...),
     *              tracker.event(...), or any other analytics pipeline.
     * @param opts  Configuration — see {@link AutoCtaTrackerOptions}.
     */
    constructor(
        private readonly emit: (name: string, params: Record<string, unknown>) => void,
        private readonly opts: AutoCtaTrackerOptions = {},
    ) {}

    /**
     * Attach the delegated click listener. Idempotent — multiple calls
     * don't double-register. No-op when `document` is unavailable
     * (e.g. SSR / Node).
     */
    install(): void {
        if (this.installed || typeof document === 'undefined') return;
        this.installed = true;
        const handler = (event: MouseEvent): void => this.handleClick(event);
        this.listener = handler;
        document.addEventListener('click', handler, { capture: true, passive: true });
    }

    /** Remove the click listener. Idempotent. */
    uninstall(): void {
        if (!this.installed) return;
        this.installed = false;
        if (this.listener && typeof document !== 'undefined') {
            document.removeEventListener('click', this.listener, { capture: true } as EventListenerOptions);
        }
        this.listener = null;
    }

    // ── Internals ──────────────────────────────────────────────────────

    private handleClick(event: MouseEvent): void {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const selector = this.opts.selector ?? DEFAULT_SELECTOR;
        const el = target.closest(selector);
        if (!el) return;

        if (this.opts.filter && !this.opts.filter(el, event)) return;

        const ctaId = this.resolveId(el);
        if (!ctaId) return;

        const payload: Record<string, unknown> = {
            cta_id:    ctaId,
            cta_text:  extractText(el),
            cta_tag:   el.tagName.toLowerCase(),
            page_path: typeof location !== 'undefined' ? location.pathname : undefined,
        };

        if (this.opts.captureDataAttrs !== false) {
            Object.assign(payload, extractDataAttrs(el));
        }

        if (el instanceof HTMLAnchorElement && el.href) {
            try { payload.cta_href = new URL(el.href, location.href).href; }
            catch { /* swallow malformed href */ }
        }

        if (this.opts.enrich) {
            const extra = this.opts.enrich(el, event);
            if (extra === null) return;
            if (extra) Object.assign(payload, extra);
        }

        // Drop undefined values to keep the GA payload tidy.
        for (const key of Object.keys(payload)) {
            if (payload[key] === undefined) delete payload[key];
        }

        try { this.emit(this.opts.eventName ?? 'cta_click', payload); }
        catch { /* never break the host on a tracking failure */ }
    }

    private resolveId(el: Element): string | null {
        const primaryAttr = this.opts.idAttribute ?? 'data-cta-id';
        const primary = el.getAttribute(primaryAttr);
        if (primary) return primary;

        const sources = this.opts.fallback ?? DEFAULT_FALLBACK;
        for (const source of sources) {
            const id = resolveFromSource(el, source);
            if (id) return id;
        }
        return null;
    }
}

/**
 * Direct-attribute aliases recognised in {@link CtaIdFallback} without the
 * `attr:` prefix. Anything else still has to use `'attr:<name>'`.
 */
const DIRECT_ATTR_ALIASES = new Set(['cta-id', 'data-cta-id', 'data-cta']);

/** Extract one fallback identifier from a source spec. */
function resolveFromSource(el: Element, source: CtaIdFallback): string | null {
    if (source === 'id') {
        return el.id || null;
    }
    if (source === 'text') {
        const text = extractText(el);
        return text ? slugify(text) : null;
    }
    if (source === 'class') {
        const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean);
        return cls[0] ?? null;
    }
    if (source === 'href') {
        if (el instanceof HTMLAnchorElement && el.href) {
            try { return new URL(el.href, location.href).pathname; }
            catch { return null; }
        }
        return null;
    }
    if (DIRECT_ATTR_ALIASES.has(source)) {
        return el.getAttribute(source) || null;
    }
    if (source.startsWith('attr:')) {
        return el.getAttribute(source.slice(5)) || null;
    }
    return null;
}

/** Trim + truncate textContent for safe inclusion in event payloads. */
function extractText(el: Element): string {
    return (el.textContent ?? '').trim().slice(0, MAX_TEXT_LEN);
}

/**
 * Convert text to a URL-safe slug for use as a fallback CTA id.
 * Keeps lowercase a-z, 0-9; collapses everything else to single hyphens.
 */
function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

/**
 * Pull all `data-*` attributes (except `data-cta-id` and `data-cta`) into
 * the event payload, keyed by their natural snake_case form. So:
 *
 *   - `data-cta-section="hero"`  → `cta_section: 'hero'`
 *   - `data-cta-variant="A"`     → `cta_variant: 'A'`
 *   - `data-track-step="3"`      → `track_step: '3'`
 *
 * The browser already lowercases + camelCases attribute names into
 * `dataset` keys, so we just convert the camelCase back to snake_case.
 * Authors writing `data-cta-X` get `cta_X` in the payload directly — no
 * surprise prefix mangling.
 */
function extractDataAttrs(el: Element): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (!(el instanceof HTMLElement)) return result;
    for (const [key, value] of Object.entries(el.dataset)) {
        if (key === 'ctaId' || key === 'cta') continue;
        if (value === undefined) continue;
        result[camelToSnake(key)] = value;
    }
    return result;
}

/** dataset normalizes attribute names to camelCase; convert back. */
function camelToSnake(s: string): string {
    return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
