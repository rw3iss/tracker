import type { TrackerEvent } from '../common/types';
import type { ITrackerDeduplicationCache } from './cache/ITrackerDeduplicationCache';

/** Fast, non-cryptographic djb2 hash — sufficient for cache key generation. */
function djb2(s: string): string {
    let hash = 5381;
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
        hash = hash >>> 0;
    }
    return hash.toString(36);
}

/**
 * Function that converts an event into a dedup key. Two events that
 * return the same key within the configured window are considered
 * duplicates and the second one is dropped.
 *
 * Built-in fingerprints come from {@link DEDUP_PRESETS} (per-user,
 * per-session, …); pass your own to opt out of presets entirely.
 */
export type DedupFingerprintFn = (event: TrackerEvent) => string;

/**
 * Field path used by the default field-based fingerprint. Either a
 * top-level event property name, a dotted path into nested objects,
 * or a function that returns a string.
 */
export type DedupField =
    | 'appId'
    | 'type'
    | 'message'
    | 'category'
    | `error.${string}`
    | `context.${string}`
    | `payload.${string}`
    | DedupFingerprintFn;

/**
 * Read a dotted path off an event, walking objects safely. Returns the
 * empty string for any missing intermediate, so a field that's absent
 * never causes a fingerprint mismatch with another absent-field event.
 */
function readPath(event: TrackerEvent, path: string): string {
    const segments = path.split('.');
    let value: unknown = event;
    for (const seg of segments) {
        if (value == null || typeof value !== 'object') return '';
        value = (value as Record<string, unknown>)[seg];
    }
    if (value == null) return '';
    return typeof value === 'string' ? value : String(value);
}

/**
 * Build a fingerprint function from a list of field paths.
 *
 * Joining with NUL guarantees that values can't collide across field
 * boundaries — e.g. an `appId='ab'` + `type='c'` won't fingerprint the
 * same as `appId='a'` + `type='bc'`.
 */
export function buildFingerprintFromFields(
    fields: ReadonlyArray<DedupField>,
): DedupFingerprintFn {
    return (event: TrackerEvent): string => {
        const parts: string[] = [];
        for (const field of fields) {
            parts.push(typeof field === 'function' ? field(event) : readPath(event, field));
        }
        return djb2(parts.join('\x00'));
    };
}

/**
 * Built-in dedup-scope presets. Picking one is the easiest way to
 * change the fingerprint composition; mixing presets with custom
 * fields is also supported via the `fields` option directly.
 *
 *   • `perUser`            — default. Two users hitting the same error
 *                            get separate dedup keys. Same user's
 *                            multiple sessions / tabs share a key.
 *   • `perSession`         — adds `context.sessionId`. Each browser
 *                            tab / session is independent for dedup.
 *   • `perUserAndSession`  — alias for `perSession` (kept for clarity).
 *   • `global`             — drops `context.userId`. Every error is
 *                            dedup'd globally regardless of who hit
 *                            it. Good for a noisy upstream-failure
 *                            class where you only want to be told
 *                            once per window.
 *
 * @see TrackerDeduplicationOptions.scope
 */
export const DEDUP_PRESETS = {
    perUser: [
        'appId', 'type', 'message',
        'error.name', 'error.message',
        'context.userId',
        'context.environment',
    ] as ReadonlyArray<DedupField>,

    perSession: [
        'appId', 'type', 'message',
        'error.name', 'error.message',
        'context.userId',
        'context.sessionId',
        'context.environment',
    ] as ReadonlyArray<DedupField>,

    perUserAndSession: [
        'appId', 'type', 'message',
        'error.name', 'error.message',
        'context.userId',
        'context.sessionId',
        'context.environment',
    ] as ReadonlyArray<DedupField>,

    global: [
        'appId', 'type', 'message',
        'error.name', 'error.message',
        'context.environment',
    ] as ReadonlyArray<DedupField>,
} as const;

/**
 * Built-in dedup scope keys. Exposed as a string union for the
 * `scope` option on {@link TrackerDeduplicationOptions}.
 */
export type DedupScope = keyof typeof DEDUP_PRESETS;

/**
 * Default fingerprint function — used when no `scope`, `fields`, or
 * `fingerprint` is configured. Matches the historical hardcoded
 * behaviour: dedup per-user across the same app + type + message +
 * error name + error message + environment.
 */
export const DEFAULT_FINGERPRINT: DedupFingerprintFn = buildFingerprintFromFields(DEDUP_PRESETS.perUser);

/**
 * Predicate run before fingerprinting. Returning `true` skips dedup
 * for that event entirely — it's neither looked up in the cache nor
 * written to it, so a later event that *would* fingerprint the same
 * still gets a clean first-occurrence pass.
 *
 * Use for intentional repeated events (analytics, lifecycle markers,
 * commit/started pairs) where two firings from the same user inside
 * the dedup window are signal, not noise.
 *
 * @see TrackerDeduplicationOptions.bypassDedup
 */
export type DedupBypassFn = (event: TrackerEvent) => boolean;

/**
 * Sliding-window event deduplicator. Looks up the configured
 * fingerprint in the cache; if it's there, the event is a duplicate
 * (drop it); if not, write it and let the event through.
 *
 * Construction takes a fingerprint function rather than a list of
 * fields — composing fingerprints (`buildFingerprintFromFields`,
 * `DEDUP_PRESETS.*`, custom functions) is the consumer's choice.
 *
 * An optional `bypass` predicate runs first; if it returns true, the
 * event short-circuits past dedup entirely (no cache read, no cache
 * write). This is the escape hatch for intentional repeated events.
 *
 * @see DedupFingerprintFn
 * @see DedupBypassFn
 * @see DEDUP_PRESETS
 * @see TrackerDeduplicationOptions
 */
export class TrackerDeduplicator {
    constructor(
        private readonly cache: ITrackerDeduplicationCache,
        private readonly windowMs: number,
        private readonly fingerprint: DedupFingerprintFn = DEFAULT_FINGERPRINT,
        private readonly bypass?: DedupBypassFn,
    ) {}

    async isDuplicate(event: TrackerEvent): Promise<boolean> {
        if (this.windowMs <= 0) return false;
        // Resolution order, highest priority first:
        //   1. Per-event wire flag — `event.dedup === false` is the
        //      emitter's explicit opt-out. Trust it: dedup is metadata
        //      about the data and the producer knows their domain best.
        //   2. Server-side bypass predicate — cross-app rules, analytics
        //      catch-alls, emergency overrides without redeploying every
        //      emitter.
        //   3. Otherwise: fingerprint and check the cache.
        if (event.dedup === false) return false;
        if (this.bypass?.(event)) return false;

        const key = this.fingerprint(event);
        if (await this.cache.has(key)) return true;

        await this.cache.set(key, this.windowMs);
        return false;
    }
}
