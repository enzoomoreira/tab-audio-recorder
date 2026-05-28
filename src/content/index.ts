import { DOMScanner } from './DOMScanner';
import { StreamRecorder } from './StreamRecorder';
import { NetworkRecorder } from './NetworkRecorder';
import { WebAudioRecorder } from './WebAudioRecorder';
import { createLogger } from '../shared/Logger';
import type { BgToContentMessage, IRecorder } from '../types';
import type { DiagnosticReport } from './DOMScanner';

const logger = createLogger('Content');

// Guard against double-injection
const WIN = window as unknown as { __tabAudioRecorderLoaded?: boolean };
if (WIN.__tabAudioRecorderLoaded) {
  logger.debug('Already loaded, skipping');
} else {
  WIN.__tabAudioRecorderLoaded = true;

  const scanner = new DOMScanner();
  let activeRecorder: IRecorder | null = null;

  browser.runtime.onMessage.addListener(
    (message: BgToContentMessage | { type: 'DIAGNOSE' }): Promise<unknown> | undefined => {
      if (message.type === 'CHECK_MEDIA') {
        return Promise.resolve({ found: scanner.hasMedia() });
      }

      if (message.type === 'START_CAPTURE') {
        return handleStartDOM(message.payload.bitrate);
      }

      if (message.type === 'START_NETWORK_CAPTURE') {
        return handleStartNetwork(message.payload.url);
      }

      if (message.type === 'START_WEBAUDIO_CAPTURE') {
        return handleStartWebAudio(message.payload.bitrate);
      }

      if (message.type === 'STOP_CAPTURE') {
        return handleStop();
      }

      if (message.type === 'DIAGNOSE') {
        const report: DiagnosticReport = scanner.diagnose();
        return Promise.resolve(report);
      }

      return undefined;
    },
  );

  async function handleStartDOM(bitrate: number): Promise<{ ok: boolean; error?: string }> {
    if (activeRecorder?.isRecording()) {
      return { ok: false, error: 'Already recording' };
    }
    const element = scanner.find();
    if (!element) {
      return { ok: false, error: 'No media element found on this page' };
    }
    try {
      const rec = new StreamRecorder();
      rec.start(element, bitrate);
      activeRecorder = rec;
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('DOM capture start failed:', error);
      return { ok: false, error };
    }
  }

  async function handleStartNetwork(url: string): Promise<{ ok: boolean; error?: string }> {
    if (activeRecorder?.isRecording()) {
      return { ok: false, error: 'Already recording' };
    }
    try {
      const rec = new NetworkRecorder();
      rec.start(url);
      activeRecorder = rec;
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Network capture start failed:', error);
      return { ok: false, error };
    }
  }

  async function handleStartWebAudio(bitrate: number): Promise<{ ok: boolean; error?: string }> {
    if (activeRecorder?.isRecording()) {
      return { ok: false, error: 'Already recording' };
    }
    try {
      const rec = new WebAudioRecorder();
      const hasContexts = await rec.probe();
      if (!hasContexts) {
        return { ok: false, error: 'No AudioContext detected on this page' };
      }
      await rec.start(bitrate);
      activeRecorder = rec;
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('WebAudio capture start failed:', error);
      return { ok: false, error };
    }
  }

  async function handleStop(): Promise<{ ok: boolean; error?: string }> {
    if (!activeRecorder?.isRecording()) {
      return { ok: false, error: 'Not recording' };
    }
    try {
      const result = await activeRecorder.stop();
      activeRecorder = null;
      // Blob is structured-cloneable in Firefox
      void browser.runtime.sendMessage({ type: 'RECORDING_COMPLETE', payload: result });
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Stop failed:', error);
      activeRecorder = null;
      void browser.runtime.sendMessage({ type: 'RECORDING_ERROR', payload: { reason: error } });
      return { ok: false, error };
    }
  }

  // Test bridge: E2E-builds only, localhost-only. Lets specs trigger START/STOP
  // via dispatchEvent without needing the popup UI. The outer `__TEST_BRIDGE__`
  // check is replaced by Vite at build time -- production builds (where
  // VITE_TEST_BRIDGE is not set) strip the entire block as dead code, so no
  // localhost page can ever reach the background via this path.
  if (__TEST_BRIDGE__ && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
    window.addEventListener('tab-audio-recorder-cmd', (event) => {
      const detail = (event as CustomEvent).detail;
      if (detail === 'START') {
        void browser.runtime.sendMessage({ type: 'TEST_START_RECORDING' });
      } else if (detail === 'STOP') {
        void browser.runtime.sendMessage({ type: 'TEST_STOP_RECORDING' });
      }
    });
    logger.info('Test bridge enabled on', location.origin);
  }

  logger.info('Loaded');
}
