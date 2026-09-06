import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const window = new Window();
window.document.body.innerHTML =
  '<p id="status"></p><button id="recordBtn"></button><p id="error" hidden></p><button id="managerBtn"></button><button id="settingsBtn"></button>';
Object.assign(globalThis, { window, document: window.document, __TEST_BRIDGE__: false });
let currentState = 'recording';
let failToggle = false;
const listeners = new Set<(changes: object, area: string) => void>();
Object.assign(globalThis, {
  browser: {
    tabs: { query: async () => [{ id: 1 }] },
    runtime: {
      sendMessage: async (message: { type: string }): Promise<unknown> => {
        if (message.type === 'GET_TAB_STATE') return { state: currentState };
        if (failToggle) throw new Error('Background disconnected');
        currentState = 'processing';
        return { ok: true };
      },
    },
    storage: {
      onChanged: {
        addListener: (listener: (changes: object, area: string) => void): void => {
          listeners.add(listener);
        },
        removeListener: (listener: (changes: object, area: string) => void): void => {
          listeners.delete(listener);
        },
      },
    },
  },
});
await import('../../src/popup/index');
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
await settle();
const button = window.document.getElementById('recordBtn') as unknown as HTMLButtonElement;
button.click();
await settle();
assert.equal(window.document.getElementById('status')!.textContent, 'Saving...');
currentState = 'idle';
for (const listener of listeners) listener({ recordingState: {} }, 'session');
await settle();
assert.equal(
  window.document.getElementById('status')!.textContent,
  'Ready',
  'popup must leave Saving when background finishes',
);
assert.equal(button.disabled, false);
failToggle = true;
button.click();
await settle();
assert.equal(button.disabled, false, 'failed messaging must allow retry');
assert.equal(window.document.getElementById('error')!.textContent, 'Background disconnected');
window.dispatchEvent(new window.Event('unload'));
assert.equal(listeners.size, 0);
console.log('PASS popup: save completion, rejected message recovery, listener cleanup');
await window.happyDOM.close();
