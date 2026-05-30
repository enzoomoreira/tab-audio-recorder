import {
  startRecording,
  stopRecording,
  toggleRecording,
  armRecording,
  disarmRecording,
  onArmedStarted,
  saveRecording,
  getTabState,
  clearTab,
  hydrate,
  onMediaURLDetected,
  exportRecordingById,
  repository,
} from './Orchestrator';
import { createLogger, setVerbose, getLogBuffer } from '../shared/Logger';
import { getSettings, onSettingsChanged } from '../shared/Settings';
import type { InboundMessage, AppSection } from '../types';

const logger = createLogger('Background');

// Open the unified app page deep-linked to a section. Find-or-focus: if a tab is
// already on the app page, focus it and just re-target the section via the hash
// (a fragment-only change never reloads the page — the SPA's hashchange listener
// swaps sections). Otherwise open a fresh tab. Keeps the popup's two buttons from
// ever spawning duplicate copies of the same page.
async function openApp(section: AppSection): Promise<void> {
  const base = browser.runtime.getURL('app/index.html');
  const target = `${base}#${section}`;

  const tabs = await browser.tabs.query({});
  const existing = tabs.find((t) => t.url === base || t.url?.startsWith(`${base}#`));

  if (existing?.id != null) {
    await browser.tabs.update(existing.id, { active: true, url: target });
    if (existing.windowId != null) {
      await browser.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await browser.tabs.create({ url: target });
}

// --- Boot: rehydrate state (survives MV3 suspension), load settings ---
void (async () => {
  await hydrate();
  const settings = await getSettings();
  setVerbose(settings.verboseLogging);
  logger.info('Background initialized, verbose logging:', settings.verboseLogging);
})();

onSettingsChanged((settings) => {
  setVerbose(settings.verboseLogging);
});

// --- Message router ---
// `message` is untrusted input typed as the closed InboundMessage union; the
// switch narrows each case so payloads are accessed without `as` casts.
browser.runtime.onMessage.addListener(
  (message: InboundMessage, sender): Promise<unknown> | undefined => {
    switch (message.type) {
      // --- Popup ---
      case 'GET_TAB_STATE':
        return Promise.resolve({ state: getTabState(message.payload.tabId) });

      case 'TOGGLE_RECORDING':
        return toggleRecording(message.payload.tabId);

      case 'OPEN_APP':
        void openApp(message.payload.section);
        return undefined;

      // --- Content script ---
      case 'RECORDING_COMPLETE': {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          void saveRecording(tabId, message.payload).catch((err: unknown) => {
            logger.error('saveRecording threw for tab', tabId, err);
            clearTab(tabId);
          });
        }
        return undefined;
      }

      case 'RECORDING_ERROR': {
        const tabId = sender.tab?.id;
        logger.error('Recording error on tab', tabId, message.payload.reason);
        if (tabId != null) {
          // An armed auto-start that failed (e.g. DRM): disarm every frame.
          if (getTabState(tabId) === 'armed') void disarmRecording(tabId);
          else clearTab(tabId);
        }
        return undefined;
      }

      case 'ARMED_STARTED': {
        const tabId = sender.tab?.id;
        if (tabId != null) void onArmedStarted(tabId, sender.frameId ?? 0);
        return undefined;
      }

      // --- Manager ---
      case 'LIST_RECORDINGS':
        return repository.list(message.payload.filter, message.payload.sort);

      case 'DELETE_RECORDING':
        return repository.deleteById(message.payload.id);

      case 'GET_BLOB':
        return repository.getBlobById(message.payload.id);

      case 'EXPORT_RECORDING':
        return exportRecordingById(message.payload.id);

      // --- Test bridge (E2E builds only; bodies stripped from production) ---
      case 'TEST_START_RECORDING': {
        if (!__TEST_BRIDGE__) return undefined;
        const tabId = sender.tab?.id;
        return tabId != null
          ? startRecording(tabId)
          : Promise.resolve({ ok: false, error: 'no tab' });
      }

      case 'TEST_STOP_RECORDING': {
        if (!__TEST_BRIDGE__) return undefined;
        const tabId = sender.tab?.id;
        return tabId != null
          ? stopRecording(tabId)
          : Promise.resolve({ ok: false, error: 'no tab' });
      }

      case 'TEST_ARM_RECORDING': {
        if (!__TEST_BRIDGE__) return undefined;
        const tabId = sender.tab?.id;
        return tabId != null
          ? armRecording(tabId)
          : Promise.resolve({ ok: false, error: 'no tab' });
      }

      case 'TEST_GET_LOGS': {
        if (!__TEST_BRIDGE__) return undefined;
        return Promise.resolve({ logs: getLogBuffer() });
      }

      default:
        return undefined;
    }
  },
);

browser.tabs.onRemoved.addListener(clearTab);

// Clear recording state when the top frame navigates away: the content script
// (and any in-flight MediaRecorder) is destroyed, so the orchestrator must not
// keep believing the tab is recording.
browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (getTabState(details.tabId) !== 'idle') {
    logger.info('Top frame navigated mid-recording, clearing state for tab', details.tabId);
  }
  clearTab(details.tabId);
});

// --- webRequest: detect audio stream URLs by Content-Type ---
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId <= 0) return;
    const ct =
      details.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
    if (ct.startsWith('audio/') || ct.includes('mpegURL') || ct.includes('ogg')) {
      onMediaURLDetected(details.tabId, details.frameId, details.url);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

// --- Hotkey: record-toggle ---
// Same logic as the popup button: stop / disarm / start-now / arm, decided from
// the tab state. The listener lives in the background, so it works with the popup
// closed.
browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'record-toggle') return;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    logger.warn('record-toggle: no active tab');
    return;
  }

  const result = await toggleRecording(tab.id);
  if (!result.ok) logger.warn('record-toggle failed:', result.error);
});
