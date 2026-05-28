import { DOMScanner } from './DOMScanner';
import { StreamRecorder } from './StreamRecorder';
import { createLogger } from '../shared/Logger';
import type { BgToContentMessage } from '../types';

const logger = createLogger('Content');

// Guard against double-injection (e.g. if executeScript is used later for future features)
const WIN = window as unknown as { __tabAudioRecorderLoaded?: boolean };
if (WIN.__tabAudioRecorderLoaded) {
  logger.debug('Already loaded, skipping');
} else {
  WIN.__tabAudioRecorderLoaded = true;

  const scanner = new DOMScanner();
  const recorder = new StreamRecorder();

  browser.runtime.onMessage.addListener(
    (message: BgToContentMessage): Promise<unknown> | undefined => {
      if (message.type === 'CHECK_MEDIA') {
        return Promise.resolve({ found: scanner.hasMedia() });
      }

      if (message.type === 'START_CAPTURE') {
        return handleStart();
      }

      if (message.type === 'STOP_CAPTURE') {
        return handleStop();
      }

      return undefined;
    },
  );

  async function handleStart(): Promise<{ ok: boolean; error?: string }> {
    const element = scanner.find();
    if (!element) {
      return { ok: false, error: 'No media element found on this page' };
    }
    try {
      recorder.start(element);
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Start failed:', error);
      return { ok: false, error };
    }
  }

  async function handleStop(): Promise<{ ok: boolean; error?: string }> {
    if (!recorder.isRecording()) {
      return { ok: false, error: 'Not recording' };
    }
    try {
      const result = await recorder.stop();
      // Blob is structured-cloneable in Firefox — safe to send via sendMessage.
      void browser.runtime.sendMessage({ type: 'RECORDING_COMPLETE', payload: result });
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Stop failed:', error);
      void browser.runtime.sendMessage({ type: 'RECORDING_ERROR', payload: { reason: error } });
      return { ok: false, error };
    }
  }

  logger.info('Loaded');
}
