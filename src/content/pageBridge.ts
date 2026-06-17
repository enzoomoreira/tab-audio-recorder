// Shared ISOLATED-world <-> MAIN-world postMessage plumbing for the content
// recorders. The element and Web Audio strategies each pair an ISOLATED-world
// driver (MediaElementRecorder / WebAudioRecorder) with a self-contained
// MAIN-world hook, and both speak the same tagged protocol. The transport --
// posting to the page, awaiting a typed reply, and subscribing to spontaneous
// messages -- lives here once instead of being copied into each driver.

export const TAG = 'tab-audio-recorder';
export const TAG_PAGE = 'tab-audio-recorder-page';

/** Send a message to the MAIN-world hook (tagged so the page cannot spoof it). */
export function postToPage(payload: Record<string, unknown>): void {
  window.postMessage({ source: TAG, ...payload }, window.location.origin);
}

/** Resolve with the next MAIN-world reply of the given `type`, or reject on timeout. */
export function waitForReply<T>(type: string, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error(`Page hook did not respond within ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const data = event.data as { source?: string; type?: string } | null;
      if (!data || data.source !== TAG_PAGE || data.type !== type) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(data as unknown as T);
    };

    window.addEventListener('message', handler);
  });
}

/**
 * Subscribe to spontaneous MAIN-world messages of the given `type` (ones the
 * hook may send at any time, not awaited as a request/response). `handler`
 * receives the message data; returns a disposer that removes the listener.
 */
export function onPageMessage<T extends { type?: string; error?: string }>(
  type: string,
  handler: (data: T) => void,
): () => void {
  const listener = (event: MessageEvent): void => {
    if (event.source !== window) return;
    const data = event.data as ({ source?: string } & T) | null;
    if (!data || data.source !== TAG_PAGE || data.type !== type) return;
    handler(data);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
