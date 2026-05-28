import {
  startRecording,
  stopRecording,
  saveRecording,
  getTabState,
  onTabRemoved,
  onMediaURLDetected,
  repository,
} from './Orchestrator';
import { createLogger } from '../shared/Logger';

const logger = createLogger('Background');

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
      const p = payload as unknown as { filter?: Parameters<typeof repository.list>[0]; sort?: Parameters<typeof repository.list>[1] };
      return repository.list(p.filter, p.sort);
    }

    if (type === 'DELETE_RECORDING') {
      return repository.deleteById((payload as { id: string }).id);
    }

    if (type === 'GET_BLOB') {
      return repository.getBlobById((payload as { id: string }).id);
    }

    return undefined;
  },
);

browser.tabs.onRemoved.addListener(onTabRemoved);

// Detect audio stream URLs from response Content-Type headers.
// This is more precise than filtering request types: we only cache URLs where
// the server actually responded with audio/* (covers mp3, ogg, aac, webm, etc.).
// Runs always so the URL is ready before the user clicks Record.
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId <= 0) return;
    const ct = details.responseHeaders
      ?.find((h) => h.name.toLowerCase() === 'content-type')
      ?.value ?? '';
    if (ct.startsWith('audio/') || ct.includes('mpegURL') || ct.includes('ogg')) {
      onMediaURLDetected(details.tabId, details.url);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

logger.info('Background initialized');
