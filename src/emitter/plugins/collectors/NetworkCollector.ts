import type { Breadcrumb } from '../../../common/types';

export interface NetworkBreadcrumbBodyConfig {
  /** Capture response bodies for failed (status >= 400 or status 0) requests. Default: true. */
  enabled?:        boolean;
  /** Max bytes of body to attach. Default: 2048 (smaller than the tracker-event default since breadcrumbs piggyback on other events). */
  maxBytes?:       number;
  /** Hard timeout for streaming response reads. Default: 1000 ms. */
  readTimeoutMs?:  number;
}

export interface NetworkCrumbConfig {
  /** Intercept window.fetch. Default: true. */
  captureFetch?: boolean;
  /** Intercept XMLHttpRequest. Default: true. */
  captureXhr?:   boolean;
  /** Skip requests whose URL matches any of these patterns. */
  ignoreUrls?:   (string | RegExp)[];
  /** Return false to drop this breadcrumb. */
  filter?:       (crumb: Breadcrumb) => boolean;
  /** Mutate the breadcrumb before it is added to the buffer. */
  transform?:    (crumb: Breadcrumb) => Breadcrumb;
  /** Capture failed-request response bodies inline on the breadcrumb. See {@link NetworkBreadcrumbBodyConfig}. */
  body?:         NetworkBreadcrumbBodyConfig;
}

const DEFAULT_BODY_MAX_BYTES = 2 * 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 1000;

async function readBoundedText(
  res: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ text: string; truncated: boolean } | null> {
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

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Records network request breadcrumbs by monkey-patching fetch and XMLHttpRequest.
 * Both patches are fully restored on uninstall().
 *
 * For failed requests (status 0 or >= 400) the response body is captured
 * inline on the breadcrumb (`data.body`, with optional `data.bodyTruncated`).
 * Bodies are size-capped and read with a hard timeout so a stuck stream
 * never delays user code.
 */
export class NetworkCollector {
  private origFetch:    (typeof window.fetch)                        | null = null;
  private origXhrOpen: (typeof XMLHttpRequest.prototype.open)        | null = null;
  private origXhrSend: (typeof XMLHttpRequest.prototype.send)        | null = null;

  constructor(
    private readonly push:   (crumb: Breadcrumb) => void,
    private readonly config: NetworkCrumbConfig,
  ) {}

  install(): void {
    const { captureFetch = true, captureXhr = true } = this.config;
    if (captureFetch) this.installFetch();
    if (captureXhr)   this.installXhr();
  }

  uninstall(): void {
    if (typeof window !== 'undefined') {
      if (this.origFetch) { window.fetch = this.origFetch; this.origFetch = null; }
    }
    if (typeof XMLHttpRequest !== 'undefined') {
      if (this.origXhrOpen) { XMLHttpRequest.prototype.open = this.origXhrOpen; this.origXhrOpen = null; }
      if (this.origXhrSend) { XMLHttpRequest.prototype.send = this.origXhrSend; this.origXhrSend = null; }
    }
  }

  private shouldIgnore(url: string): boolean {
    return this.config.ignoreUrls?.some(p =>
      typeof p === 'string' ? url.includes(p) : p.test(url),
    ) ?? false;
  }

  private bodyConfig(): Required<NetworkBreadcrumbBodyConfig> {
    const b = this.config.body ?? {};
    return {
      enabled:       b.enabled ?? true,
      maxBytes:      b.maxBytes ?? DEFAULT_BODY_MAX_BYTES,
      readTimeoutMs: b.readTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS,
    };
  }

  private emit(
    method: string,
    url: string,
    status: number,
    duration: number,
    extra?: { body?: unknown; bodyTruncated?: boolean },
  ): void {
    const isError = status === 0 || status >= 400;
    const data: Record<string, unknown> = { method, url, status, duration };
    if (extra?.body !== undefined) data.body = extra.body;
    if (extra?.bodyTruncated)      data.bodyTruncated = true;

    const crumb: Breadcrumb = {
      timestamp: Date.now(),
      category:  'network',
      message:   `${method} ${url} — ${status || 'error'}`,
      level:     isError ? 'error' : 'info',
      data,
    };
    const { filter, transform } = this.config;
    if (filter && !filter(crumb)) return;
    this.push(transform ? transform(crumb) : crumb);
  }

  private installFetch(): void {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;

    const self = this;
    const orig = window.fetch.bind(window);
    this.origFetch = window.fetch;

    window.fetch = async function (input, init) {
      const url =
        typeof input === 'string'                                              ? input :
        input instanceof URL                                                   ? input.href :
        typeof Request !== 'undefined' && input instanceof Request ? input.url :
        String(input);
      const method = (
        init?.method ??
        (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
      ).toUpperCase();

      if (self.shouldIgnore(url)) return orig(input, init);

      const start = Date.now();
      try {
        const res = await orig(input, init);
        const duration = Date.now() - start;
        const isError = !res.ok;
        const bc = self.bodyConfig();

        if (isError && bc.enabled) {
          let bodyExtra: { body?: unknown; bodyTruncated?: boolean } | undefined;
          try {
            const captured = await readBoundedText(res.clone(), bc.maxBytes, bc.readTimeoutMs);
            if (captured) {
              const parsed = tryParseJson(captured.text);
              bodyExtra = {
                body:          parsed ?? captured.text,
                bodyTruncated: captured.truncated,
              };
            }
          } catch {
            // Best-effort.
          }
          self.emit(method, url, res.status, duration, bodyExtra);
        } else {
          self.emit(method, url, res.status, duration);
        }
        return res;
      } catch (err) {
        self.emit(method, url, 0, Date.now() - start);
        throw err;
      }
    };
  }

  private installXhr(): void {
    if (typeof XMLHttpRequest === 'undefined') return;

    const self = this;
    const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string; start: number }>();

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    this.origXhrOpen = origOpen;
    this.origXhrSend = origSend;

    (XMLHttpRequest.prototype as any).open = function (method: string, url: string, async?: boolean, user?: string | null, password?: string | null) {
      xhrMeta.set(this, { method: method.toUpperCase(), url: String(url), start: 0 });
      return async !== undefined
        ? origOpen.call(this, method, url, async, user, password)
        : origOpen.call(this, method, url, true);
    };

    XMLHttpRequest.prototype.send = function (body) {
      const meta = xhrMeta.get(this);
      if (meta && !self.shouldIgnore(meta.url)) {
        meta.start = Date.now();
        this.addEventListener('loadend', () => {
          const duration = Date.now() - meta.start;
          const status   = this.status;
          const isError  = status === 0 || status >= 400;
          const bc       = self.bodyConfig();

          if (isError && status > 0 && bc.enabled) {
            let bodyExtra: { body?: unknown; bodyTruncated?: boolean } | undefined;
            try {
              const raw = (this as any).responseText ?? '';
              if (typeof raw === 'string' && raw.length > 0) {
                const truncated = raw.length > bc.maxBytes;
                const text = truncated ? raw.slice(0, bc.maxBytes) + '\n...(truncated)' : raw;
                const parsed = tryParseJson(text);
                bodyExtra = { body: parsed ?? text, bodyTruncated: truncated };
              }
            } catch {
              // responseText can throw if responseType isn't 'text'/'';
              // skip body capture quietly.
            }
            self.emit(meta.method, meta.url, status, duration, bodyExtra);
          } else {
            self.emit(meta.method, meta.url, status, duration);
          }
        });
      }
      return origSend.call(this, body as XMLHttpRequestBodyInit | null | undefined);
    };
  }
}
