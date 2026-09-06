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
let loadRevision = 0;
let playerRevision = 0;
let initialized = false;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
const cards = new Map<string, { signature: string; element: HTMLLIElement; player: AudioPlayer }>();

// Object URL cache: tracks URLs created for blobs so we can revoke on delete.
const objectURLs = new Map<string, string>();

// Unchanged cards retain their players across refreshes and sort changes.
const players: AudioPlayer[] = [];

function destroyPlayers(): void {
  playerRevision++;
  for (const p of players) p.destroy();
  players.length = 0;
  for (const url of objectURLs.values()) URL.revokeObjectURL(url);
  objectURLs.clear();
  cards.clear();
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

  const revision = playerRevision;
  const card = cards.get(id);
  const blob = await sendToBackground({ type: 'GET_BLOB', payload: { id } });
  if (!blob || revision !== playerRevision || cards.get(id) !== card) return null;

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
  await sendToBackground({ type: 'DELETE_RECORDING', payload: { id } });
  cards.delete(id);
  const url = objectURLs.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    objectURLs.delete(id);
  }
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

async function loadRecordings(background = false): Promise<void> {
  const revision = ++loadRevision;
  if (!background) {
    loadingMsg.textContent = 'Loading...';
    loadingMsg.hidden = false;
  }

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
    if (revision !== loadRevision) return;
    logger.error('Failed to list recordings:', err);
    loadingMsg.textContent = 'Failed to load recordings.';
    loadingMsg.hidden = false;
    return;
  }

  if (revision !== loadRevision) return;
  loadingMsg.hidden = true;

  const current = new Map(recordings.map((rec) => [rec.id, JSON.stringify(rec)]));
  for (const [id, card] of cards) {
    if (current.get(id) === card.signature && card.element.isConnected) continue;
    releasePlayer(card.player);
    card.element.remove();
    cards.delete(id);
    const url = objectURLs.get(id);
    if (url) URL.revokeObjectURL(url);
    objectURLs.delete(id);
  }
  for (const rec of recordings) {
    let card = cards.get(rec.id);
    if (!card) {
      let player!: AudioPlayer;
      const element = buildCard(rec, {
        ...cardActions,
        registerPlayer: (created) => {
          player = created;
          players.push(created);
        },
      });
      card = { signature: current.get(rec.id)!, element, player };
      cards.set(rec.id, card);
    }
    listEl.appendChild(card.element);
  }
  listEl.hidden = recordings.length === 0;
  emptyMsg.hidden = recordings.length !== 0;
}

async function refreshVisible(): Promise<void> {
  if (
    !initialized ||
    refreshing ||
    document.hidden ||
    document.getElementById('view-recordings')!.hidden
  )
    return;
  refreshing = true;
  try {
    await loadRecordings(true);
  } finally {
    refreshing = false;
  }
}

const reloadDebounced = debounce(() => void loadRecordings(), 300);
hostFilterEl.addEventListener('input', reloadDebounced);
sortFieldEl.addEventListener('change', () => void loadRecordings());
sortDirEl.addEventListener('change', () => void loadRecordings());
window.addEventListener('focus', () => void refreshVisible());
window.addEventListener('hashchange', () => queueMicrotask(() => void refreshVisible()));
document.addEventListener('visibilitychange', () => void refreshVisible());

// Release media resources and revoke every cached object URL on unload.
window.addEventListener('pagehide', () => {
  loadRevision++;
  clearTimeout(debounceHandle);
  clearInterval(refreshTimer);
  initialized = false;
  destroyPlayers();
});

export async function initRecordings(settings: Settings): Promise<void> {
  sortFieldEl.value = settings.defaultSortField;
  sortDirEl.value = settings.defaultSortDirection;
  await loadRecordings();
  initialized = true;
  refreshTimer = setInterval(() => void refreshVisible(), 2000);
}
