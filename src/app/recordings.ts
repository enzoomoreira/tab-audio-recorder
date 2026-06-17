import { createLogger } from '../shared/Logger';
import { sendToBackground } from '../shared/messaging';
import type { Settings } from '../shared/Settings';
import { AudioPlayer } from './AudioPlayer';
import { buildCard, type CardActions } from './recordingCard';
import type { RecordingMetadata, SortField, SortDirection, ActionResult } from '../types';

const logger = createLogger('Recordings');

const loadingMsg = document.getElementById('loadingMsg')!;
const emptyMsg = document.getElementById('emptyMsg')!;
const listEl = document.getElementById('list')!;
const hostFilterEl = document.getElementById('hostFilter') as HTMLInputElement;
const sortFieldEl = document.getElementById('sortField') as HTMLSelectElement;
const sortDirEl = document.getElementById('sortDir') as HTMLSelectElement;

let debounceHandle: ReturnType<typeof setTimeout>;

// Object URL cache: tracks URLs created for blobs so we can revoke on delete.
const objectURLs = new Map<string, string>();

// Live players for the currently rendered cards. Destroyed before each rebuild
// so reloading the list (filter/sort change) doesn't orphan <audio> elements.
const players: AudioPlayer[] = [];

function destroyPlayers(): void {
  for (const p of players) p.destroy();
  players.length = 0;
}

function debounce(fn: () => void, ms: number): () => void {
  return () => {
    clearTimeout(debounceHandle);
    debounceHandle = setTimeout(fn, ms);
  };
}

// Fetch the blob once (via the background) and cache its object URL across Play
// and Export for a card.
async function loadBlobURL(id: string): Promise<string | null> {
  const cached = objectURLs.get(id);
  if (cached) return cached;

  const blob = await sendToBackground({ type: 'GET_BLOB', payload: { id } });
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  objectURLs.set(id, url);
  return url;
}

function exportRecording(id: string): Promise<ActionResult> {
  // Background owns the export pipeline (template, subfolder, downloads API);
  // the cached object URL stays in-page for playback only.
  return sendToBackground({ type: 'EXPORT_RECORDING', payload: { id } });
}

async function deleteRecording(id: string): Promise<void> {
  const url = objectURLs.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    objectURLs.delete(id);
  }
  await sendToBackground({ type: 'DELETE_RECORDING', payload: { id } });
}

function releasePlayer(player: AudioPlayer): void {
  player.destroy();
  const idx = players.indexOf(player);
  if (idx !== -1) players.splice(idx, 1);
}

const cardActions: CardActions = {
  loadBlobURL,
  exportRecording,
  deleteRecording,
  registerPlayer: (player) => players.push(player),
  releasePlayer,
  onListEmptied: () => {
    listEl.hidden = true;
    emptyMsg.hidden = false;
  },
};

async function loadRecordings(): Promise<void> {
  loadingMsg.hidden = false;
  emptyMsg.hidden = true;
  listEl.hidden = true;

  const host = hostFilterEl.value.trim();
  const field = sortFieldEl.value as SortField;
  const direction = sortDirEl.value as SortDirection;

  let recordings: RecordingMetadata[];
  try {
    recordings = await sendToBackground({
      type: 'LIST_RECORDINGS',
      payload: {
        filter: host ? { host } : {},
        sort: { field, direction },
      },
    });
  } catch (err) {
    logger.error('Failed to list recordings:', err);
    loadingMsg.textContent = 'Failed to load recordings.';
    return;
  }

  loadingMsg.hidden = true;

  // Tear down players from the previous render before replacing the DOM.
  destroyPlayers();

  if (!recordings.length) {
    listEl.replaceChildren();
    emptyMsg.hidden = false;
    return;
  }

  listEl.replaceChildren();
  for (const rec of recordings) {
    listEl.appendChild(buildCard(rec, cardActions));
  }
  listEl.hidden = false;
}

const reloadDebounced = debounce(loadRecordings, 300);
hostFilterEl.addEventListener('input', reloadDebounced);
sortFieldEl.addEventListener('change', () => void loadRecordings());
sortDirEl.addEventListener('change', () => void loadRecordings());

// Release media resources and revoke every cached object URL on unload.
window.addEventListener('pagehide', () => {
  destroyPlayers();
  for (const url of objectURLs.values()) URL.revokeObjectURL(url);
  objectURLs.clear();
});

export async function initRecordings(settings: Settings): Promise<void> {
  sortFieldEl.value = settings.defaultSortField;
  sortDirEl.value = settings.defaultSortDirection;
  await loadRecordings();
}
