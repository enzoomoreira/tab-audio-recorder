import { MediaElementRecorder } from './MediaElementRecorder';
import { NetworkRecorder } from './NetworkRecorder';
import { WebAudioRecorder } from './WebAudioRecorder';
import { createLogger } from '../shared/Logger';
import type { BgToContentMessage, IRecorder, ActionResult } from '../types';

const logger = createLogger('Content');

// Guard against double-injection
const WIN = window as unknown as { __tabAudioRecorderLoaded?: boolean };
if (WIN.__tabAudioRecorderLoaded) {
  logger.debug('Already loaded, skipping');
} else {
  WIN.__tabAudioRecorderLoaded = true;

  let activeRecorder: IRecorder | null = null;
  // A media-element recorder waiting for the next play() to auto-start. Distinct
  // from activeRecorder: it is not yet recording, only armed. Promoted to
  // activeRecorder once it fires.
  let armedRecorder: MediaElementRecorder | null = null;

  // Wire a recorder's spontaneous-error callback so a mid-capture failure
  // (not triggered by stop) clears local state and notifies the background.
  function wireErrors(rec: { onError: ((reason: string) => void) | null }): void {
    rec.onError = (reason) => {
      logger.error('Recorder errored mid-capture:', reason);
      activeRecorder = null;
      void browser.runtime.sendMessage({ type: 'RECORDING_ERROR', payload: { reason } });
    };
  }

  browser.runtime.onMessage.addListener(
    (message: BgToContentMessage): Promise<unknown> | undefined => {
      if (message.type === 'CHECK_MEDIA') {
        return new MediaElementRecorder()
          .probe()
          .then((r) => ({ found: r.found, playing: r.playing }));
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

      if (message.type === 'ARM_CAPTURE') {
        return Promise.resolve(handleArm(message.payload.bitrate));
      }

      if (message.type === 'DISARM_CAPTURE') {
        armedRecorder?.disarm();
        armedRecorder = null;
        return Promise.resolve({ ok: true });
      }

      if (message.type === 'ABORT_CAPTURE') {
        if (activeRecorder instanceof MediaElementRecorder) {
          activeRecorder.abort();
          activeRecorder = null;
        }
        armedRecorder?.disarm();
        armedRecorder = null;
        return Promise.resolve({ ok: true });
      }

      return undefined;
    },
  );

  async function handleStartDOM(bitrate: number): Promise<ActionResult> {
    if (activeRecorder?.isRecording()) {
      return { ok: false, error: 'Already recording' };
    }
    try {
      const rec = new MediaElementRecorder();
      await rec.start(bitrate);
      activeRecorder = rec;
      wireErrors(rec);
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('DOM capture start failed:', error);
      return { ok: false, error };
    }
  }

  // Arms a media-element recorder. Capture does not start now -- the MAIN-world
  // hook starts it synchronously on the next play() and signals back via
  // onArmFired, at which point the recorder becomes the active one and the
  // background is told to flip the tab to 'recording'.
  function handleArm(bitrate: number): ActionResult {
    if (activeRecorder?.isRecording()) {
      return { ok: false, error: 'Already recording' };
    }
    armedRecorder?.disarm();
    const rec = new MediaElementRecorder();
    rec.onArmFired = () => {
      activeRecorder = rec;
      armedRecorder = null;
      wireErrors(rec);
      void browser.runtime.sendMessage({ type: 'ARMED_STARTED' });
    };
    rec.onArmFailed = (reason) => {
      armedRecorder = null;
      void browser.runtime.sendMessage({ type: 'RECORDING_ERROR', payload: { reason } });
    };
    armedRecorder = rec;
    rec.arm(bitrate);
    return { ok: true };
  }

  async function handleStartNetwork(url: string): Promise<ActionResult> {
    if (activeRecorder?.isRecording()) {
      return { ok: false, error: 'Already recording' };
    }
    try {
      const rec = new NetworkRecorder();
      rec.start(url);
      activeRecorder = rec;
      wireErrors(rec);
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Network capture start failed:', error);
      return { ok: false, error };
    }
  }

  async function handleStartWebAudio(bitrate: number): Promise<ActionResult> {
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
      wireErrors(rec);
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('WebAudio capture start failed:', error);
      return { ok: false, error };
    }
  }

  async function handleStop(): Promise<ActionResult> {
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
      } else if (detail === 'ARM') {
        void browser.runtime.sendMessage({ type: 'TEST_ARM_RECORDING' });
      }
    });
    logger.info('Test bridge enabled on', location.origin);
  }

  logger.info('Loaded');
}
