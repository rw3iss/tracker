/**
 * Runs before every test file (via jest.config.js setupFiles).
 * Polyfills globals that are available in Node 17+ / modern browsers
 * but may be absent from the jsdom sandbox used by jest-environment-jsdom.
 */
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = (val) => JSON.parse(JSON.stringify(val));
}
