import type { WebDriver } from 'selenium-webdriver';
import { extensionBaseUrl } from './fixture';

/** Dispatch a custom event on the current page; content script forwards to background. */
export async function startRecording(driver: WebDriver): Promise<void> {
  await driver.executeScript(
    `window.dispatchEvent(new CustomEvent('tab-audio-recorder-cmd', { detail: 'START' }));`,
  );
}

export async function stopRecording(driver: WebDriver): Promise<void> {
  await driver.executeScript(
    `window.dispatchEvent(new CustomEvent('tab-audio-recorder-cmd', { detail: 'STOP' }));`,
  );
}

/** Block until at least one recording entry is in IndexedDB. */
export async function waitForRecording(
  driver: WebDriver,
  timeoutMs = 15_000,
): Promise<{ count: number; lastSize: number; lastMime: string } | null> {
  const baseUrl = await extensionBaseUrl(driver);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    // Use a tiny inline reader inside the extension origin so IDB resolves to the extension's store.
    await driver.get(`${baseUrl}/manager/index.html`);
    // The manager UI reads via runtime messaging; give it a moment to populate.
    const result = await driver.executeScript<{
      count: number;
      lastSize: number;
      lastMime: string;
    } | null>(
      `return new Promise(async (resolve) => {
        try {
          const list = await browser.runtime.sendMessage({
            type: 'LIST_RECORDINGS',
            payload: { sort: { field: 'startedAt', direction: 'desc' } },
          });
          if (!Array.isArray(list) || list.length === 0) return resolve(null);
          const last = list[0];
          resolve({ count: list.length, lastSize: last.sizeBytes, lastMime: last.mimeType });
        } catch (err) {
          resolve(null);
        }
      });`,
    );
    if (result && result.count > 0 && result.lastSize > 0) return result;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * Try to record and assert that no recording was saved (e.g. DRM, no audio
 * source, error path). Returns true if the tab returned to `idle` with zero
 * entries in IDB.
 */
export async function waitForFailedRecording(
  driver: WebDriver,
  timeoutMs = 8_000,
): Promise<boolean> {
  const baseUrl = await extensionBaseUrl(driver);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await driver.get(`${baseUrl}/manager/index.html`);
    const result = await driver.executeScript<{ count: number }>(
      `return new Promise(async (resolve) => {
        const list = await browser.runtime.sendMessage({ type: 'LIST_RECORDINGS', payload: {} });
        resolve({ count: Array.isArray(list) ? list.length : 0 });
      });`,
    );
    if (result.count === 0) {
      // Give the orchestrator a small grace window in case a save is pending.
      await new Promise((r) => setTimeout(r, 300));
      const recheck = await driver.executeScript<{ count: number }>(
        `return new Promise(async (resolve) => {
          const list = await browser.runtime.sendMessage({ type: 'LIST_RECORDINGS', payload: {} });
          resolve({ count: Array.isArray(list) ? list.length : 0 });
        });`,
      );
      if (recheck.count === 0) return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Delete all recordings via the runtime API (cleanup between tests). */
export async function clearRecordings(driver: WebDriver): Promise<void> {
  const baseUrl = await extensionBaseUrl(driver);
  await driver.get(`${baseUrl}/manager/index.html`);
  await driver.executeScript(
    `return new Promise(async (resolve) => {
      const list = await browser.runtime.sendMessage({ type: 'LIST_RECORDINGS', payload: {} });
      if (Array.isArray(list)) {
        for (const m of list) {
          await browser.runtime.sendMessage({ type: 'DELETE_RECORDING', payload: { id: m.id } });
        }
      }
      resolve(true);
    });`,
  );
}
