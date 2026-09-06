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
  let activeCaptureId: string | null = null;
  // A media-element recorder waiting for the next play() to auto-start. Distinct
  // from activeRecorder: it is not yet recording, only armed. Promoted to
  // activeRecorder once it fires.
  let armedRecorder: MediaElementRecorder | null = null;
  let armedCaptureId: string | null = null;

  // Wire a recorder's spontaneous-error callback so a mid-capture failure
  // (not triggered by stop) clears local state and notifies the background.
  function wireErrors(
    rec: IRecorder & { onError: ((reason: string) => void) | null },
    captureId: string,
  ): void {
    rec.onError = (reason) => {
      logger.error('Recorder errored mid-capture:', reason);
      if (activeRecorder === rec) {
        activeRecorder = null;
        activeCaptureId = null;
      }
      void browser.runtime.sendMessage({ type: 'RECORDING_ERROR', payload: { reason, captureId } });
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
        return handleStartDOM(message.payload.bitrate, message.payload.captureId);
      }

      if (message.type === 'START_NETWORK_CAPTURE') {
        return handleStartNetwork(message.payload.url, message.payload.captureId);
      }

      if (message.type === 'START_WEBAUDIO_CAPTURE') {
        return handleStartWebAudio(message.payload.bitrate, message.payload.captureId);
      }

      if (message.type === 'STOP_CAPTURE') {
        if (message.payload.captureId !== activeCaptureId)
          return Promise.resolve({ ok: false, error: 'Recording session is no longer active.' });
        return handleStop();
      }

      if (message.type === 'ARM_CAPTURE') {
        return Promise.resolve(handleArm(message.payload.bitrate, message.payload.captureId));
      }

      if (message.type === 'DISARM_CAPTURE') {
        if (message.payload.captureId !== armedCaptureId) return Promise.resolve({ ok: true });
        armedRecorder?.disarm();
        armedRecorder = null;
        armedCaptureId = null;
        return Promise.resolve({ ok: true });
      }

      if (message.type === 'ABORT_CAPTURE') {
        if (
          message.payload.captureId === activeCaptureId &&
          activeRecorder instanceof MediaElementRecorder
        ) {
          activeRecorder.abort();
          activeRecorder = null;
          activeCaptureId = null;
        }
        if (message.payload.captureId === armedCaptureId) {
          armedRecorder?.disarm();
          armedRecorder = null;
          armedCaptureId = null;
        }
        return Promise.resolve({ ok: true });
      }

      return undefined;
    },
  );

  async function handleStartDOM(bitrate: number, captureId: string): Promise<ActionResult> {
    if (activeRecorder?.isRecording()) {
      return { ok: false, error: 'Already recording' };
    }
    try {
      const rec = new MediaElementRecorder();
      await rec.start(bitrate, captureId);
      activeRecorder = rec;
      activeCaptureId = captureId;
      wireErrors(rec, captureId);
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
  function handleArm(bitrate: number, captureId: string): ActionResult {
    if (activeRecorder?.isRecording()) {
      return { ok: false, error: 'Already recording' };
    }
    armedRecorder?.disarm();
    const rec = new MediaElementRecorder();
    rec.onArmFired = () => {
      activeRecorder = rec;
      activeCaptureId = captureId;
      armedRecorder = null;
      armedCaptureId = null;
      wireErrors(rec, captureId);
      void browser.runtime.sendMessage({ type: 'ARMED_STARTED', payload: { captureId } });
    };
    rec.onArmFailed = (reason) => {
      if (armedRecorder === rec) {
        armedRecorder = null;
        armedCaptureId = null;
      }
      void browser.runtime.sendMessage({ type: 'RECORDING_ERROR', payload: { reason, captureId } });
    };
    armedRecorder = rec;
    armedCaptureId = captureId;
    rec.arm(bitrate, captureId);
    return { ok: true };
  }

  async function handleStartNetwork(url: string, captureId: string): Promise<ActionResult> {
    if (activeRecorder?.isRecording()) {
      return { ok: false, error: 'Already recording' };
    }
    try {
      const rec = new NetworkRecorder();
      await rec.start(url, captureId);
      activeRecorder = rec;
      activeCaptureId = captureId;
      wireErrors(rec, captureId);
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Network capture start failed:', error);
      return { ok: false, error };
    }
  }

  async function handleStartWebAudio(bitrate: number, captureId: string): Promise<ActionResult> {
    if (activeRecorder?.isRecording()) {
      return { ok: false, error: 'Already recording' };
    }
    try {
      const rec = new WebAudioRecorder();
      const hasContexts = await rec.probe();
      if (!hasContexts) {
        return { ok: false, error: 'No AudioContext detected on this page' };
      }
      await rec.start(bitrate, captureId);
      activeRecorder = rec;
      activeCaptureId = captureId;
      wireErrors(rec, captureId);
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
    const captureId = activeCaptureId!;
    const recorder = activeRecorder;
    try {
      const result = await recorder.stop();
      if (activeRecorder === recorder) {
        activeRecorder = null;
        activeCaptureId = null;
      }
      // All audio chunks have committed before completion is announced.
      void browser.runtime.sendMessage({ type: 'RECORDING_COMPLETE', payload: result });
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Stop failed:', error);
      if (activeRecorder === recorder) {
        activeRecorder = null;
        activeCaptureId = null;
      }
      void browser.runtime.sendMessage({
        type: 'RECORDING_ERROR',
        payload: { reason: error, captureId },
      });
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
