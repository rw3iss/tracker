import type { VisitorStorageKind, VisitorConfig } from '../types';

/**
 * Read/write/remove abstraction over `localStorage` / `sessionStorage` /
 * `document.cookie` / in-memory map. Single dependency point for visitor +
 * session + attribution persistence so swapping storage modes is a single
 * config flag rather than threaded conditionals.
 *
 * All methods are silent on failure (storage may be disabled, full, or
 * unavailable in private browsing) — analytics should never break the host
 * app.
 *
 * @example
 * ```typescript
 * const store = new BrowserStorage('localStorage');
 * store.set('clientId', 'v_8c4e');
 * const id = store.get('clientId');
 * ```
 */
export class BrowserStorage {
  private memory: Map<string, string> = new Map();

  /**
   * @param kind   Backing storage to use.
   * @param cookie Cookie attributes — only used when `kind === 'cookie'`.
   */
  constructor(
    private readonly kind: VisitorStorageKind,
    private readonly cookie: Pick<VisitorConfig, 'cookieDomain' | 'cookieMaxAge' | 'cookiePath' | 'cookieSameSite' | 'cookieSecure'> = {},
  ) {}

  /** True if the chosen backing storage is reachable in the current environment. */
  get available(): boolean {
    if (this.kind === 'memory') return true;
    if (typeof document === 'undefined') return false;
    if (this.kind === 'cookie') return true;
    try {
      const slot = this.kind === 'localStorage' ? window.localStorage : window.sessionStorage;
      const test = '__vt_probe__';
      slot.setItem(test, '1');
      slot.removeItem(test);
      return true;
    } catch {
      return false;
    }
  }

  /** Read a value. Returns `null` when missing or storage is unreachable. */
  get(key: string): string | null {
    try {
      switch (this.kind) {
        case 'memory':         return this.memory.get(key) ?? null;
        case 'localStorage':   return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
        case 'sessionStorage': return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null;
        case 'cookie':         return this.readCookie(key);
      }
    } catch { return null; }
  }

  /** Write a value. Silent on failure. */
  set(key: string, value: string): void {
    try {
      switch (this.kind) {
        case 'memory':         this.memory.set(key, value); return;
        case 'localStorage':   if (typeof localStorage   !== 'undefined') localStorage.setItem(key, value); return;
        case 'sessionStorage': if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, value); return;
        case 'cookie':         this.writeCookie(key, value); return;
      }
    } catch { /* swallow — storage failure must never break the host */ }
  }

  /** Remove a value. Silent on failure. */
  remove(key: string): void {
    try {
      switch (this.kind) {
        case 'memory':         this.memory.delete(key); return;
        case 'localStorage':   if (typeof localStorage   !== 'undefined') localStorage.removeItem(key); return;
        case 'sessionStorage': if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(key); return;
        case 'cookie':         this.expireCookie(key); return;
      }
    } catch { /* swallow */ }
  }

  // ── Cookie helpers ─────────────────────────────────────────────────────

  private readCookie(name: string): string | null {
    if (typeof document === 'undefined') return null;
    const target = `${encodeURIComponent(name)}=`;
    const all = document.cookie.split(/;\s*/);
    for (const c of all) {
      if (c.startsWith(target)) {
        try { return decodeURIComponent(c.substring(target.length)); }
        catch { return null; }
      }
    }
    return null;
  }

  private writeCookie(name: string, value: string): void {
    if (typeof document === 'undefined') return;
    const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
    parts.push(`Path=${this.cookie.cookiePath ?? '/'}`);
    if (this.cookie.cookieDomain)  parts.push(`Domain=${this.cookie.cookieDomain}`);
    if (this.cookie.cookieMaxAge !== undefined) parts.push(`Max-Age=${this.cookie.cookieMaxAge}`);
    parts.push(`SameSite=${this.cookie.cookieSameSite ?? 'Lax'}`);
    const secure = this.cookie.cookieSecure ?? (typeof location !== 'undefined' && location.protocol === 'https:');
    if (secure) parts.push('Secure');
    document.cookie = parts.join('; ');
  }

  private expireCookie(name: string): void {
    if (typeof document === 'undefined') return;
    const parts = [`${encodeURIComponent(name)}=`, `Max-Age=0`, `Path=${this.cookie.cookiePath ?? '/'}`];
    if (this.cookie.cookieDomain) parts.push(`Domain=${this.cookie.cookieDomain}`);
    document.cookie = parts.join('; ');
  }
}
