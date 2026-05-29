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
import type { InboundMessage } from '../types';

const logger = createLogger('Background');

// --- Boot: rehydrate state (survives MV3 suspension), load settings ---
// Exposed as a promise so event handlers that fire on a fresh wake (e.g. the
// hotkey) can await hydration before reading per-tab state.
const ready = (async () => {
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

      case 'OPEN_MANAGER':
        void browser.tabs.create({ url: browser.runtime.getURL('manager/index.html') });
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
// the tab state. Works with the popup closed (the listener lives here in the
// background). `await ready` guards against the listener firing on a fresh MV3
// wake before state has been rehydrated.
browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'record-toggle') return;
  await ready;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    logger.warn('record-toggle: no active tab');
    return;
  }

  const result = await toggleRecording(tab.id);
  if (!result.ok) logger.warn('record-toggle failed:', result.error);
});
