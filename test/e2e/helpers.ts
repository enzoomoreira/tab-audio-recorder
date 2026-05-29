import type { WebDriver } from 'selenium-webdriver';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { extensionBaseUrl } from './fixture';

/** Dispatch a custom event on the current page; content script forwards to background. */
export async function startRecording(driver: WebDriver): Promise<void> {
  await driver.executeScript(
    `window.dispatchEvent(new CustomEvent('tab-audio-recorder-cmd', { detail: 'START' }));`,
  );
}

// After dispatching STOP, let the stop -> RECORDING_COMPLETE -> save chain finish
// BEFORE the caller navigates. waitForRecording navigates the recording tab to
// the manager, and `webNavigation.onCommitted` tears down the content script (and
// its in-flight MediaRecorder) on that navigation -- if the save hasn't landed
// yet, the recording is lost. The settle window removes that race.
const STOP_SETTLE_MS = 1500;

export async function stopRecording(driver: WebDriver): Promise<void> {
  await driver.executeScript(
    `window.dispatchEvent(new CustomEvent('tab-audio-recorder-cmd', { detail: 'STOP' }));`,
  );
  await new Promise((r) => setTimeout(r, STOP_SETTLE_MS));
}

/** Arm the tab: the next media element that plays is auto-captured. */
export async function armRecording(driver: WebDriver): Promise<void> {
  await driver.executeScript(
    `window.dispatchEvent(new CustomEvent('tab-audio-recorder-cmd', { detail: 'ARM' }));`,
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

/**
 * Read the background context's captured log buffer (TEST_GET_LOGS bridge).
 * Navigates to the manager page (extension origin) so `browser.runtime` is
 * available. Best-effort: returns a marker line on failure instead of throwing.
 */
export async function getBackgroundLogs(driver: WebDriver): Promise<string[]> {
  try {
    const baseUrl = await extensionBaseUrl(driver);
    await driver.get(`${baseUrl}/manager/index.html`);
    const result = await driver.executeScript<string[]>(
      `return new Promise(async (resolve) => {
        try {
          const r = await browser.runtime.sendMessage({ type: 'TEST_GET_LOGS' });
          resolve(r && Array.isArray(r.logs) ? r.logs : []);
        } catch (e) {
          resolve(['<could not read logs: ' + e + '>']);
        }
      });`,
    );
    return result ?? [];
  } catch (err) {
    return [`<getBackgroundLogs failed: ${String(err)}>`];
  }
}

const ARTIFACT_DIR = resolve(process.cwd(), 'e2e-artifacts');

/**
 * On a failed test, capture what happened: a screenshot of the current page and
 * the background log buffer (which strategy ran, what error). Both are
 * best-effort -- a dead/hung driver must not mask the original assertion.
 */
export async function dumpDiagnostics(driver: WebDriver, label: string): Promise<void> {
  const safe = label.replace(/[^a-z0-9-]+/gi, '_').slice(0, 80);
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const png = await driver.takeScreenshot();
    writeFileSync(resolve(ARTIFACT_DIR, `${safe}.png`), png, 'base64');
    console.error(`[e2e] screenshot: e2e-artifacts/${safe}.png`);
  } catch (err) {
    console.error('[e2e] screenshot failed:', String(err));
  }
  const logs = await getBackgroundLogs(driver);
  console.error(
    `[e2e] background logs for "${label}":\n${logs.join('\n')}\n[e2e] --- end background logs ---`,
  );
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
