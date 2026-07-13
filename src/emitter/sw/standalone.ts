/// <reference lib="webworker" />
/**
 * Standalone Service Worker entry for @rw3iss/tracker Background Sync transport.
 *
 * Register this file as your Service Worker when you don't already have one:
 * ```ts
 * TrackerClient.init({
 *   serviceWorkerTransport: { swUrl: '/tracker-sw.js' },
 * });
 * ```
 *
 * If you already have a Service Worker, import `setupTrackerSync` from
 * `@rw3iss/tracker/sw` and call it inside your existing SW instead.
 */
import { setupTrackerSync } from './index';

const sw = self as unknown as ServiceWorkerGlobalScope;

// Activate immediately so the sync handler is ready on first install
sw.addEventListener('install',  () => sw.skipWaiting());
sw.addEventListener('activate', (e) => e.waitUntil(sw.clients.claim()));

setupTrackerSync();
