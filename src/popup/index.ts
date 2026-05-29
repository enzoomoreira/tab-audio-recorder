import { createLogger } from '../shared/Logger';
import type { TabRecordingState, ActionResult } from '../types';

const logger = createLogger('Popup');

const statusEl = document.getElementById('status')!;
const recordBtn = document.getElementById('recordBtn') as HTMLButtonElement;
const errorEl = document.getElementById('error')!;
const managerBtn = document.getElementById('managerBtn')!;
const settingsBtn = document.getElementById('settingsBtn')!;

let tabId: number | null = null;
let state: TabRecordingState = 'idle';

async function init(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab', true);
    return;
  }
  tabId = tab.id;
  await refreshState();
}

async function refreshState(): Promise<void> {
  if (tabId == null) return;
  const response = await browser.runtime.sendMessage({
    type: 'GET_TAB_STATE',
    payload: { tabId },
  });
  applyState((response as { state: TabRecordingState }).state);
}

function applyState(next: TabRecordingState): void {
  state = next;
  errorEl.hidden = true;

  recordBtn.classList.remove('is-recording', 'is-processing', 'is-armed');

  if (next === 'idle') {
    setStatus('Ready');
    recordBtn.disabled = false;
    recordBtn.title = 'Record now, or arm to capture the next audio that plays';
  } else if (next === 'armed') {
    setStatus('Armed — waiting for audio');
    recordBtn.disabled = false;
    recordBtn.classList.add('is-armed');
    recordBtn.title = 'Disarm';
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

// One button drives the whole lifecycle. The background decides what the toggle
// means from the current state (stop / disarm / start now / arm), so the popup
// just sends TOGGLE_RECORDING and re-reads the resulting state.
recordBtn.addEventListener('click', async () => {
  if (tabId == null || state === 'processing') return;

  const prev = state;
  recordBtn.disabled = true;
  const res = await browser.runtime.sendMessage({
    type: 'TOGGLE_RECORDING',
    payload: { tabId },
  });
  const result = res as ActionResult;
  if (!result.ok) {
    applyState(prev);
    showError(result.error ?? 'Action failed');
    return;
  }
  await refreshState();
});

managerBtn.addEventListener('click', () => {
  void browser.runtime.sendMessage({ type: 'OPEN_MANAGER' });
  window.close();
});

settingsBtn.addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
  window.close();
});

init().catch((err: unknown) => {
  logger.error('Init failed:', err);
  setStatus('Error', true);
});
