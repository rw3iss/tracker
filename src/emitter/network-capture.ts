import type { TrackerClient } from './TrackerClient';

export interface NetworkBodyCaptureConfig {
  /** Max bytes of body to attach. Longer bodies are truncated with a "...(truncated)" marker. Default: 8192. */
  maxBytes?:    number;
  /**
   * Whether to attempt body read at all. Default: true (capture bodies on
   * any error event we already emit). Set to `false` to keep the previous
   * behavior (status code + URL only — no body, no synthesized error).
   */
  enabled?:     boolean;
  /**
   * Max ms to wait for the cloned response body to drain. Bodies larger
   * than this (or genuinely streaming) are abandoned with a marker so we
   * never block the app on a slow read. Default: 1500.
   */
  readTimeoutMs?: number;
}

export interface NetworkCaptureConfig {
  /** Intercept window.fetch. Default: true. */
  captureFetch?: boolean;
  /** Intercept XMLHttpRequest. Default: true. */
  captureXhr?:   boolean;
  /**
   * Only capture failed requests (status >= 400 or network error).
   * Set to `false` to capture all requests.
   * Default: true.
   */
  errorsOnly?:   boolean;
  /** Skip requests whose URL matches any of these patterns. */
  ignoreUrls?:   (string | RegExp)[];
  /** Body-capture options for failed requests. See {@link NetworkBodyCaptureConfig}. */
  body?:         NetworkBodyCaptureConfig;
}

let origFetch:   (typeof window.fetch)                   | null = null;
let origXhrOpen: (typeof XMLHttpRequest.prototype.open)  | null = null;
let origXhrSend: (typeof XMLHttpRequest.prototype.send)  | null = null;
let registered = false;

const DEFAULT_BODY_MAX_BYTES = 8 * 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 1500;

function shouldIgnore(url: string, patterns: (string | RegExp)[]): boolean {
  return patterns.some(p => typeof p === 'string' ? url.includes(p) : p.test(url));
}

/**
 * Read up to `maxBytes` from a (cloned) fetch Response body as UTF-8 text,
 * with a hard timeout. Returns `null` on read error, timeout, or empty body.
 *
 * Uses the streaming reader so we can stop after the cap is hit without
 * pulling a multi-MB error body into memory just to truncate it.
 */
async function readBoundedText(
  res: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ text: string; truncated: boolean } | null> {
  // Some runtimes (and old Safari) don't expose `body` as a ReadableStream.
  // Fall back to .text() with a hard timeout in that case.
  if (!res.body || typeof (res.body as any).getReader !== 'function') {
    return Promise.race([
      res.text().then((t) => {
        if (!t) return null;
        const truncated = t.length > maxBytes;
        return { text: truncated ? t.slice(0, maxBytes) + '\n...(truncated)' : t, truncated };
      }).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const chunks: string[] = [];
  let bytes = 0;
  let truncated = false;

  const start = Date.now();

  try {
    while (true) {
      if (Date.now() - start > timeoutMs) {
        truncated = true;
        try { await reader.cancel(); } catch { /* best-effort */ }
        break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes >= maxBytes) {
        // Decode only the slice we want to keep, then stop pulling.
        const remaining = value.byteLength - (bytes - maxBytes);
        chunks.push(decoder.decode(value.subarray(0, Math.max(remaining, 0)), { stream: false }));
        truncated = true;
        try { await reader.cancel(); } catch { /* best-effort */ }
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    if (!truncated) chunks.push(decoder.decode());
  } catch {
    return null;
  }

  const text = chunks.join('');
  if (!text) return null;
  return { text: truncated ? text + '\n...(truncated)' : text, truncated };
}

/**
 * Best-effort parse a captured body as JSON. Returns the parsed object on
 * success, otherwise `null`. Lets the dashboard render structured error
 * payloads (e.g. `{ message: "Bid below minimum", code: "BID_LOW" }`) as
 * objects instead of stringified blobs.
 */
function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Pull a human-readable error message out of an HTTP body. Prefers a
 * NestJS / rw3iss-style `{ error: { message } }` or `{ message }`
 * envelope, then falls back to the raw text (single-line, capped).
 */
function deriveErrorMessage(parsed: unknown, rawText: string): string {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, any>;
    if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message;
    if (obj.error && typeof obj.error === 'object' && typeof obj.error.message === 'string') {
      return obj.error.message;
    }
    if (typeof obj.error === 'string' && obj.error.length > 0) return obj.error;
  }
  // Strip newlines, cap at 240 chars so it fits as an event message.
  const single = rawText.replace(/\s+/g, ' ').trim();
  return single.length > 240 ? single.slice(0, 240) + '…' : single;
}

export function registerNetworkCapture(
  client: TrackerClient,
  config: NetworkCaptureConfig = {},
): void {
  if (registered) return;

  const {
    captureFetch = true,
    captureXhr   = true,
    errorsOnly   = true,
    ignoreUrls   = [],
    body         = {},
  } = config;

  const bodyConfig: Required<NetworkBodyCaptureConfig> = {
    enabled:       body.enabled ?? true,
    maxBytes:      body.maxBytes ?? DEFAULT_BODY_MAX_BYTES,
    readTimeoutMs: body.readTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS,
  };

  if (captureFetch) installFetch(client, errorsOnly, ignoreUrls, bodyConfig);
  if (captureXhr)   installXhr(client, errorsOnly, ignoreUrls, bodyConfig);

  registered = true;
}

export function unregisterNetworkCapture(): void {
  if (!registered) return;

  if (typeof window !== 'undefined' && origFetch) {
    window.fetch = origFetch;
    origFetch    = null;
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    if (origXhrOpen) { XMLHttpRequest.prototype.open = origXhrOpen; origXhrOpen = null; }
    if (origXhrSend) { XMLHttpRequest.prototype.send = origXhrSend; origXhrSend = null; }
  }
  registered = false;
}

function installFetch(
  client: TrackerClient,
  errorsOnly: boolean,
  ignoreUrls: (string | RegExp)[],
  bodyConfig: Required<NetworkBodyCaptureConfig>,
): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;

  const orig = window.fetch.bind(window);
  origFetch  = window.fetch;

  window.fetch = async function (input, init) {
    const url =
      typeof input === 'string'                                                         ? input :
      input instanceof URL                                                               ? input.href :
      (typeof Request !== 'undefined' && input instanceof Request)                     ? input.url :
      String(input);

    const method = (
      init?.method ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
    ).toUpperCase();

    if (ignoreUrls.length && shouldIgnore(url, ignoreUrls)) return orig(input, init);

    try {
      const res = await orig(input, init);
      if (!errorsOnly || !res.ok) {
        const isError = !res.ok;
        const payload: Record<string, unknown> = { method, url, status: res.status };
        let synthesizedError: { name: string; message: string; stack?: string } | undefined;
        let bodyMessage: string | undefined;

        // Read the response body for failed requests so we can surface the
        // actual server-side error in the dashboard. We clone() so the
        // original Response stays untouched for the calling code.
        if (isError && bodyConfig.enabled) {
          try {
            const cloned = res.clone();
            const captured = await readBoundedText(cloned, bodyConfig.maxBytes, bodyConfig.readTimeoutMs);
            if (captured) {
              const parsed = tryParseJson(captured.text);
              payload.body = parsed ?? captured.text;
              if (captured.truncated) payload.bodyTruncated = true;
              bodyMessage = deriveErrorMessage(parsed, captured.text);
            }
          } catch {
            // Best-effort — never let body-read failures break the request.
          }

          synthesizedError = {
            name:    `HttpError${res.status}`,
            message: bodyMessage ?? `${method} ${url} responded with HTTP ${res.status}`,
          };
        }

        client.capture({
          type:     isError ? 'error' : 'info',
          message:  bodyMessage
            ? `${method} ${url} — ${res.status}: ${bodyMessage}`
            : `${method} ${url} — ${res.status}`,
          category: 'network',
          payload,
          tags:     ['auto-capture', 'network'],
          ...(synthesizedError ? { error: synthesizedError } : {}),
        });
      }
      return res;
    } catch (err) {
      client.capture({
        type:     'error',
        message:  `${method} ${url} — network error`,
        category: 'network',
        payload:  { method, url, status: 0 },
        tags:     ['auto-capture', 'network'],
        error: err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : { name: 'NetworkError', message: String(err) },
      });
      throw err;
    }
  };
}

function installXhr(
  client: TrackerClient,
  errorsOnly: boolean,
  ignoreUrls: (string | RegExp)[],
  bodyConfig: Required<NetworkBodyCaptureConfig>,
): void {
  if (typeof XMLHttpRequest === 'undefined') return;

  const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;
  origXhrOpen = _origOpen;
  origXhrSend = _origSend;

  (XMLHttpRequest.prototype as any).open = function (
    method: string, url: string, async?: boolean, user?: string | null, password?: string | null,
  ) {
    xhrMeta.set(this, { method: method.toUpperCase(), url: String(url) });
    return async !== undefined
      ? _origOpen.call(this, method, url, async, user, password)
      : _origOpen.call(this, method, url, true);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const meta = xhrMeta.get(this);
    if (meta && !(ignoreUrls.length && shouldIgnore(meta.url, ignoreUrls))) {
      this.addEventListener('loadend', () => {
        const status   = this.status;
        const isError  = status === 0 || status >= 400;
        if (!errorsOnly || isError) {
          const payload: Record<string, unknown> = { method: meta.method, url: meta.url, status };
          let synthesizedError: { name: string; message: string } | undefined;
          let bodyMessage: string | undefined;

          // XHR body is already buffered by the browser at loadend — no
          // need for streaming or timeout, just read responseText (cap to
          // maxBytes) and best-effort parse as JSON.
          if (isError && status > 0 && bodyConfig.enabled) {
            try {
              const raw = (this as any).responseText ?? '';
              if (typeof raw === 'string' && raw.length > 0) {
                const truncated = raw.length > bodyConfig.maxBytes;
                const text = truncated ? raw.slice(0, bodyConfig.maxBytes) + '\n...(truncated)' : raw;
                const parsed = tryParseJson(text);
                payload.body = parsed ?? text;
                if (truncated) payload.bodyTruncated = true;
                bodyMessage = deriveErrorMessage(parsed, text);
              }
            } catch {
              // Best-effort — XHR.responseText can throw when responseType
              // is not 'text' or ''. Skip body capture in that case.
            }

            synthesizedError = {
              name:    `HttpError${status}`,
              message: bodyMessage ?? `${meta.method} ${meta.url} responded with HTTP ${status}`,
            };
          } else if (isError && status === 0) {
            synthesizedError = {
              name:    'NetworkError',
              message: `${meta.method} ${meta.url} — network error`,
            };
          }

          client.capture({
            type:     isError ? 'error' : 'info',
            message:  bodyMessage
              ? `${meta.method} ${meta.url} — ${status}: ${bodyMessage}`
              : `${meta.method} ${meta.url} — ${status || 'network error'}`,
            category: 'network',
            payload,
            tags:     ['auto-capture', 'network'],
            ...(synthesizedError ? { error: synthesizedError } : {}),
          });
        }
      });
    }
    return _origSend.call(this, body as XMLHttpRequestBodyInit | null | undefined);
  };
}
