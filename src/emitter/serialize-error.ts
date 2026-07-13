import type { SerializedError, SerializedErrorPrevious } from '../common/types';

/**
 * Maximum depth of the `cause` chain we walk. Five is well past anything
 * seen in practice and protects against pathological cases (cyclic chains
 * shouldn't be possible, but the cap is cheap insurance). Mirrors the PHP
 * and Go SDKs.
 */
const MAX_PREVIOUS_DEPTH = 5;

/**
 * Per-field toggles for the optional fields on {@link SerializedError}.
 * `name`, `message`, and `stack` are always emitted; these flags only
 * control the four payload-size-sensitive fields.
 */
export interface ErrorEnrichmentFields {
  /** Parsed top stack frame → `error.file`. */
  file?:     boolean;
  /** Parsed top stack frame → `error.line`. */
  line?:     boolean;
  /** `err.code` (Node SystemError, custom subclasses) → `error.code`. */
  code?:     boolean;
  /** Walked `Error.cause` chain → `error.previous[]`. */
  previous?: boolean;
}

/**
 * Accepted values for the `errorEnrichment` config.
 *
 * - `true` / `'full'` (default) — all optional fields on.
 * - `false` / `'minimal'` — name/message/stack only.
 * - object — per-field overrides on top of the full set.
 */
export type ErrorEnrichmentMode =
  | boolean
  | 'full'
  | 'minimal'
  | ErrorEnrichmentFields;

const ERROR_ENRICHMENT_ALL_ON: Required<ErrorEnrichmentFields> = {
  file: true, line: true, code: true, previous: true,
};
const ERROR_ENRICHMENT_ALL_OFF: Required<ErrorEnrichmentFields> = {
  file: false, line: false, code: false, previous: false,
};

function resolveErrorEnrichment(mode: ErrorEnrichmentMode | undefined): Required<ErrorEnrichmentFields> {
  if (mode === false || mode === 'minimal')      return ERROR_ENRICHMENT_ALL_OFF;
  if (mode === true || mode === 'full' || mode == null) return ERROR_ENRICHMENT_ALL_ON;
  return { ...ERROR_ENRICHMENT_ALL_ON, ...mode };
}

/**
 * Serialize a JavaScript `Error` into the wire format shared by every
 * tracker SDK (TS / Go / PHP).
 *
 * `name`, `message`, and `stack` are always emitted. The {@link
 * ErrorEnrichmentMode} controls which of the optional fields — `file`,
 * `line`, `code`, `previous` — are also included.
 *
 *   • `file` / `line` — parsed from the top stack frame so the dashboard
 *     can render a "throw site" link without re-running source-map
 *     resolution.
 *   • `code` — copied off `.code` if the error subclass exposes one
 *     (Node `SystemError`, custom error classes).
 *   • `previous` — walks `Error.cause` up to `MAX_PREVIOUS_DEPTH` levels,
 *     mirroring the chain other SDKs produce. Stack traces are omitted
 *     from previous entries because the root error's stack already
 *     covers the throw site.
 *
 * Primarily a payload-size knob — see `benchmarks/serialize-error.bench.ts`.
 */
export function serializeError(err: unknown, mode: ErrorEnrichmentMode = true): SerializedError {
  if (!(err instanceof Error)) {
    return { name: 'Error', message: String(err) };
  }

  const out: SerializedError = {
    name:    err.name,
    message: err.message,
  };
  if (err.stack) out.stack = err.stack;

  const flags = resolveErrorEnrichment(mode);

  // Fast path: every optional field is off → name/message/stack only.
  if (!flags.file && !flags.line && !flags.code && !flags.previous) return out;

  if (flags.file || flags.line) {
    const top = parseTopFrame(err.stack);
    if (top) {
      if (flags.file) out.file = top.file;
      if (flags.line) out.line = top.line;
    }
  }

  if (flags.code) {
    const code = readErrorCode(err);
    if (code !== undefined) out.code = code;
  }

  if (flags.previous) {
    const previous = collectPrevious(err, flags);
    if (previous.length) out.previous = previous;
  }

  return out;
}

/**
 * `Error.cause` is the standard "previous exception" mechanism in
 * modern JavaScript (ES2022). We walk it iteratively, capping depth and
 * tracking visited refs so a cyclic `cause` (rare but possible if a
 * caller does it on purpose) can't deadlock the serializer.
 */
function collectPrevious(err: Error, flags: Required<ErrorEnrichmentFields>): SerializedErrorPrevious[] {
  const chain: SerializedErrorPrevious[] = [];
  const seen  = new Set<unknown>();
  let current = (err as { cause?: unknown }).cause;
  let depth   = 0;

  while (current !== undefined && current !== null && depth < MAX_PREVIOUS_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);

    if (current instanceof Error) {
      const entry: SerializedErrorPrevious = {
        name:    current.name,
        message: current.message,
      };
      // Previous entries inherit the same field-level flags as the root
      // error — keeps the wire shape internally consistent.
      if (flags.file || flags.line) {
        const frame = parseTopFrame(current.stack);
        if (frame) {
          if (flags.file) entry.file = frame.file;
          if (flags.line) entry.line = frame.line;
        }
      }
      if (flags.code) {
        const code = readErrorCode(current);
        if (code !== undefined) entry.code = code;
      }
      chain.push(entry);
      current = (current as { cause?: unknown }).cause;
    } else {
      chain.push({ name: 'Error', message: String(current) });
      break;
    }
    depth++;
  }

  return chain;
}

/**
 * Best-effort parse of the top frame from a V8-style stack ("at fn
 * (/path/to/file.js:42:7)") or a SpiderMonkey/JavaScriptCore-style stack
 * ("fn@/path/to/file.js:42:7"). Returns null if we can't lock onto a
 * frame — the dashboard treats absent file/line as "unknown" and renders
 * fine.
 */
function parseTopFrame(stack: string | undefined): { file: string; line: number } | null {
  if (!stack) return null;
  const lines = stack.split('\n');
  // First line of `stack` is usually "ErrorName: message" — start from the
  // first frame instead.
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('at ') && !line.includes('@')) continue;

    // V8: "at fn (file:line:col)" or "at file:line:col"
    let match = line.match(/\((.+):(\d+):\d+\)\s*$/);
    if (match) return { file: match[1], line: Number(match[2]) };
    match = line.match(/^at\s+(.+):(\d+):\d+$/);
    if (match) return { file: match[1], line: Number(match[2]) };

    // SpiderMonkey / JSC: "fn@file:line:col"
    match = line.match(/@(.+):(\d+):\d+$/);
    if (match) return { file: match[1], line: Number(match[2]) };
  }
  return null;
}

/**
 * Pull `.code` off custom error subclasses without trusting it blindly —
 * Node's `SystemError.code` is a string (`'ENOENT'`); HTTP-style errors
 * sometimes use numbers. We accept either, drop everything else.
 */
function readErrorCode(err: unknown): string | number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') return code;
  return undefined;
}
