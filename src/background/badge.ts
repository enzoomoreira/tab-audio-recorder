import type { TabRecordingState } from '../types';

// Reflects the tab's recording state on the toolbar icon, so the armed/recording
// state is visible even when the popup is closed. `browser.action` is optional
// here so unit tests (which mock a minimal `browser`) don't need to stub it.
export function updateBadge(tabId: number, state: TabRecordingState): void {
  const action = browser.action;
  if (!action?.setBadgeText) return;
  let text = '';
  let color = '#d98000';
  if (state === 'armed') {
    text = '●'; // filled circle
    color = '#d98000'; // amber
  } else if (state === 'recording') {
    text = 'REC';
    color = '#cc0000'; // red
  }
  void action.setBadgeText({ text, tabId }).catch(() => undefined);
  if (text && action.setBadgeBackgroundColor) {
    void action.setBadgeBackgroundColor({ color, tabId }).catch(() => undefined);
  }
}
