import type { TrackerClient } from './TrackerClient';

let registered = false;
let errorHandler: ((e: ErrorEvent) => void) | null = null;
let rejectionHandler: ((e: PromiseRejectionEvent) => void) | null = null;

export function registerAutoCapture(client: TrackerClient): void {
  if (typeof window === 'undefined' || registered) return;

  errorHandler = (e: ErrorEvent) => {
    const err = e.error instanceof Error ? e.error : new Error(e.message ?? 'Unknown error');
    client.error(err, { tags: ['auto-capture'] });
  };

  rejectionHandler = (e: PromiseRejectionEvent) => {
    const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason ?? 'Unhandled rejection'));
    client.error(err, { tags: ['auto-capture', 'unhandled-promise'] });
  };

  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', rejectionHandler);
  registered = true;
}

export function unregisterAutoCapture(): void {
  if (typeof window === 'undefined' || !registered) return;
  if (errorHandler)     window.removeEventListener('error', errorHandler);
  if (rejectionHandler) window.removeEventListener('unhandledrejection', rejectionHandler);
  errorHandler     = null;
  rejectionHandler = null;
  registered       = false;
}
