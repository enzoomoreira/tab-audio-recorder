import {
  startRecording,
  stopRecording,
  saveRecording,
  getTabState,
  onTabRemoved,
  onMediaURLDetected,
  exportRecordingById,
  repository,
} from './Orchestrator';
import { createLogger, setVerbose } from '../shared/Logger';
import { getSettings, onSettingsChanged } from '../shared/Settings';

const logger = createLogger('Background');

// --- Boot: load settings, apply verbose flag, subscribe to changes ---
void (async () => {
  const settings = await getSettings();
  setVerbose(settings.verboseLogging);
  logger.info('Background initialized, verbose logging:', settings.verboseLogging);
})();

onSettingsChanged((settings) => {
  setVerbose(settings.verboseLogging);
});

// --- Message router ---
browser.runtime.onMessage.addListener(
  (message: { type: string; payload?: unknown }, sender): Promise<unknown> | undefined => {
    const { type, payload } = message as { type: string; payload: Record<string, unknown> };

    // --- Popup ---
    if (type === 'GET_TAB_STATE') {
      return Promise.resolve({ state: getTabState(payload['tabId'] as number) });
    }

    if (type === 'START_RECORDING') {
      return startRecording(payload['tabId'] as number);
    }

    if (type === 'STOP_RECORDING') {
      return stopRecording(payload['tabId'] as number);
    }

    if (type === 'OPEN_MANAGER') {
      void browser.tabs.create({ url: browser.runtime.getURL('manager/index.html') });
      return undefined;
    }

    if (type === 'OPEN_SETTINGS') {
      void browser.runtime.openOptionsPage();
      return undefined;
    }

    // --- Content script test bridge (E2E-builds only; see src/content/index.ts) ---
    // Vite replaces `__TEST_BRIDGE__` at build time; production strips both branches.
    if (__TEST_BRIDGE__) {
      if (type === 'TEST_START_RECORDING') {
        const tabId = sender.tab?.id;
        return tabId != null ? startRecording(tabId) : Promise.resolve({ ok: false, error: 'no tab' });
      }

      if (type === 'TEST_STOP_RECORDING') {
        const tabId = sender.tab?.id;
        return tabId != null ? stopRecording(tabId) : Promise.resolve({ ok: false, error: 'no tab' });
      }
    }

    // --- Content script ---
    if (type === 'RECORDING_COMPLETE') {
      const tabId = sender.tab?.id;
      if (tabId != null) {
        void saveRecording(tabId, payload as unknown as Parameters<typeof saveRecording>[1]);
      }
      return undefined;
    }

    if (type === 'RECORDING_ERROR') {
      logger.error('Recording error on tab', sender.tab?.id, (payload as { reason: string }).reason);
      return undefined;
    }

    // --- Manager ---
    if (type === 'LIST_RECORDINGS') {
      const p = payload as unknown as {
        filter?: Parameters<typeof repository.list>[0];
        sort?: Parameters<typeof repository.list>[1];
      };
      return repository.list(p.filter, p.sort);
    }

    if (type === 'DELETE_RECORDING') {
      return repository.deleteById((payload as { id: string }).id);
    }

    if (type === 'GET_BLOB') {
      return repository.getBlobById((payload as { id: string }).id);
    }

    if (type === 'EXPORT_RECORDING') {
      return exportRecordingById((payload as { id: string }).id);
    }

    return undefined;
  },
);

browser.tabs.onRemoved.addListener(onTabRemoved);

// --- webRequest: detect audio stream URLs by Content-Type ---
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId <= 0) return;
    const ct = details.responseHeaders
      ?.find((h) => h.name.toLowerCase() === 'content-type')
      ?.value ?? '';
    if (ct.startsWith('audio/') || ct.includes('mpegURL') || ct.includes('ogg')) {
      onMediaURLDetected(details.tabId, details.frameId, details.url);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

// --- Hotkey: record-toggle ---
browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'record-toggle') return;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    logger.warn('record-toggle: no active tab');
    return;
  }

  const state = getTabState(tab.id);
  if (state === 'idle') {
    const result = await startRecording(tab.id);
    if (!result.ok) logger.warn('record-toggle start failed:', result.error);
  } else if (state === 'recording') {
    const result = await stopRecording(tab.id);
    if (!result.ok) logger.warn('record-toggle stop failed:', result.error);
  } else {
    logger.debug('record-toggle ignored, tab is processing');
  }
});
