import { createLogger } from '../shared/Logger';
import { sendToBackground } from '../shared/messaging';
import type { AppSection, TabRecordingState } from '../types';

const logger = createLogger('Popup');

const statusEl = document.getElementById('status')!;
const recordBtn = document.getElementById('recordBtn') as HTMLButtonElement;
const errorEl = document.getElementById('error')!;
const managerBtn = document.getElementById('managerBtn')!;
const settingsBtn = document.getElementById('settingsBtn')!;

let tabId: number | null = null;
let state: TabRecordingState = 'idle';
let actionPending = false;
let refreshVersion = 0;
const progressTimer = setInterval((): void => {
  if (state === 'recording' && !actionPending)
    void refreshState().catch((error: unknown): void => showError(String(error)));
}, 2000);

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
  const version = ++refreshVersion;
  const result = await sendToBackground({ type: 'GET_TAB_STATE', payload: { tabId } });
  if (version !== refreshVersion) return;
  applyState(result.state);
  if (result.state === 'recording' && result.progress) {
    const seconds = Math.floor(result.progress.savedDurationMs / 1000);
    const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    setStatus(
      `Recording - saved through ${elapsed} (${(result.progress.savedBytes / 1024 / 1024).toFixed(1)} MB)`,
    );
  }
  if (result.error) showError(result.error);
}

function onStateChanged(
  changes: Record<string, browser.storage.StorageChange>,
  area: string,
): void {
  if (area !== 'session' || !changes['recordingState']) return;
  void refreshState().catch((err: unknown) => {
    showError(err instanceof Error ? err.message : String(err));
  });
}

browser.storage.onChanged.addListener(onStateChanged);
window.addEventListener('unload', (): void => {
  refreshVersion++;
  clearInterval(progressTimer);
  browser.storage.onChanged.removeListener(onStateChanged);
});

function applyState(next: TabRecordingState): void {
  state = next;
  errorEl.hidden = true;

  recordBtn.classList.remove('is-recording', 'is-processing', 'is-armed');

  if (next === 'idle') {
    setStatus('Ready');
    recordBtn.title = 'Record now, or arm to capture the next audio that plays';
  } else if (next === 'armed') {
    setStatus('Armed — waiting for audio');
    recordBtn.classList.add('is-armed');
    recordBtn.title = 'Disarm';
  } else if (next === 'recording') {
    setStatus('Recording...');
    recordBtn.classList.add('is-recording');
    recordBtn.title = 'Stop recording';
  } else {
    setStatus('Saving...');
    recordBtn.classList.add('is-processing');
    recordBtn.title = 'Saving recording';
  }
  recordBtn.setAttribute('aria-label', recordBtn.title);
  updateButtonAvailability();
}

function updateButtonAvailability(): void {
  recordBtn.disabled = actionPending || state === 'processing';
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
recordBtn.addEventListener('click', async (): Promise<void> => {
  if (tabId == null || state === 'processing' || actionPending) return;

  actionPending = true;
  recordBtn.disabled = true;
  try {
    const result = await sendToBackground({ type: 'TOGGLE_RECORDING', payload: { tabId } });
    await refreshState();
    if (!result.ok) showError(result.error);
  } catch (err: unknown) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    actionPending = false;
    updateButtonAvailability();
  }
});

async function openApp(section: AppSection): Promise<void> {
  try {
    await sendToBackground({ type: 'OPEN_APP', payload: { section } });
    window.close();
  } catch (err: unknown) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

managerBtn.addEventListener('click', (): void => {
  void openApp('recordings');
});

settingsBtn.addEventListener('click', (): void => {
  void openApp('settings');
});

init().catch((err: unknown) => {
  logger.error('Init failed:', err);
  setStatus('Error', true);
});
