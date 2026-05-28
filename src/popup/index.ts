import { createLogger } from '../shared/Logger';
import type { TabRecordingState } from '../types';

const logger = createLogger('Popup');

const statusEl = document.getElementById('status')!;
const recordBtn = document.getElementById('recordBtn') as HTMLButtonElement;
const errorEl = document.getElementById('error')!;
const managerBtn = document.getElementById('managerBtn')!;

let tabId: number | null = null;
let state: TabRecordingState = 'idle';

async function init(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab', true);
    return;
  }
  tabId = tab.id;

  const response = await browser.runtime.sendMessage({
    type: 'GET_TAB_STATE',
    payload: { tabId },
  });

  applyState((response as { state: TabRecordingState }).state);
}

function applyState(next: TabRecordingState): void {
  state = next;
  errorEl.hidden = true;

  recordBtn.classList.remove('is-recording', 'is-processing');

  if (next === 'idle') {
    setStatus('Ready');
    recordBtn.disabled = false;
    recordBtn.title = 'Start recording';
  } else if (next === 'recording') {
    setStatus('Recording...');
    recordBtn.disabled = false;
    recordBtn.classList.add('is-recording');
    recordBtn.title = 'Stop recording';
  } else {
    setStatus('Saving...');
    recordBtn.disabled = true;
    recordBtn.classList.add('is-processing');
  }
}

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.className = isError ? 'status status--error' : 'status';
}

function showError(msg: string): void {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

recordBtn.addEventListener('click', async () => {
  if (tabId == null) return;

  if (state === 'idle') {
    applyState('recording');
    const res = await browser.runtime.sendMessage({
      type: 'START_RECORDING',
      payload: { tabId },
    });
    const result = res as { ok: boolean; error?: string };
    if (!result.ok) {
      applyState('idle');
      showError(result.error ?? 'Failed to start');
    }
  } else if (state === 'recording') {
    applyState('processing');
    const res = await browser.runtime.sendMessage({
      type: 'STOP_RECORDING',
      payload: { tabId },
    });
    const result = res as { ok: boolean; error?: string };
    if (!result.ok) {
      applyState('recording');
      showError(result.error ?? 'Failed to stop');
    } else {
      applyState('idle');
    }
  }
});

managerBtn.addEventListener('click', () => {
  void browser.runtime.sendMessage({ type: 'OPEN_MANAGER' });
  window.close();
});

init().catch((err: unknown) => {
  logger.error('Init failed:', err);
  setStatus('Error', true);
});
