import { createLogger } from '../shared/Logger';
import type { Settings } from '../shared/Settings';
import { AudioPlayer } from './AudioPlayer';
import type { RecordingMetadata, SortField, SortDirection } from '../types';

const logger = createLogger('Recordings');

const loadingMsg = document.getElementById('loadingMsg')!;
const emptyMsg = document.getElementById('emptyMsg')!;
const listEl = document.getElementById('list')!;
const hostFilterEl = document.getElementById('hostFilter') as HTMLInputElement;
const sortFieldEl = document.getElementById('sortField') as HTMLSelectElement;
const sortDirEl = document.getElementById('sortDir') as HTMLSelectElement;

let debounceHandle: ReturnType<typeof setTimeout>;

// Object URL cache: tracks URLs created for blobs so we can revoke on delete
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

function fmt(n: number, unit: string): string {
  return `${n.toFixed(0)} ${unit}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return fmt(bytes, 'B');
  if (bytes < 1024 * 1024) return fmt(bytes / 1024, 'KB');
  return fmt(bytes / (1024 * 1024), 'MB');
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ts));
}

interface ElProps {
  className?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
}

// Builds a DOM node via the structured API (textContent escapes automatically),
// so the manager never assembles HTML from strings.
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title !== undefined) node.title = props.title;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

async function loadRecordings(): Promise<void> {
  loadingMsg.hidden = false;
  emptyMsg.hidden = true;
  listEl.hidden = true;

  const host = hostFilterEl.value.trim() || undefined;
  const field = sortFieldEl.value as SortField;
  const direction = sortDirEl.value as SortDirection;

  let recordings: RecordingMetadata[];
  try {
    recordings = await browser.runtime.sendMessage({
      type: 'LIST_RECORDINGS',
      payload: {
        filter: host ? { host } : undefined,
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
    listEl.appendChild(buildCard(rec));
  }
  listEl.hidden = false;
}

function buildCard(meta: RecordingMetadata): HTMLLIElement {
  const li = el('li', { className: 'card', attrs: { 'data-id': meta.id } });

  const header = el('div', { className: 'card__header' }, [
    el('span', { className: 'card__host', text: meta.sourceHost }),
    el('span', { className: 'card__date', text: formatDate(meta.startedAt) }),
  ]);

  const title = el('div', {
    className: 'card__title',
    title: meta.sourceTitle,
    text: meta.sourceTitle,
  });

  const btn = el('button', { className: 'player__btn', attrs: { 'aria-label': 'Play' } });
  const scrubber = el('input', {
    className: 'player__scrubber',
    attrs: { type: 'range', min: '0', max: '1000', value: '0', step: '1', 'aria-label': 'Seek' },
  });
  const track = el('div', { className: 'player__track' }, [scrubber]);
  const time = el('span', { className: 'player__time', text: '0:00 / 0:00' });
  const playerEl = el('div', { className: 'player' }, [btn, track, time]);

  const codec = meta.mimeType.split(';')[0] ?? meta.mimeType;
  const metaText = `${formatDuration(meta.durationMs)} · ${formatSize(meta.sizeBytes)} · ${codec}`;
  const exportBtn = el('button', {
    className: 'btn btn--export',
    text: 'Export',
    attrs: { 'data-action': 'export' },
  });
  const deleteBtn = el('button', {
    className: 'btn btn--danger',
    text: 'Delete',
    attrs: { 'data-action': 'delete' },
  });
  const footer = el('div', { className: 'card__footer' }, [
    el('span', { className: 'card__meta', text: metaText }),
    el('div', { className: 'card__actions' }, [exportBtn, deleteBtn]),
  ]);

  li.append(header, title, playerEl, footer);

  // Fetch blob once, cache the object URL across Play and Export.
  async function ensureObjectURL(): Promise<string | null> {
    const cached = objectURLs.get(meta.id);
    if (cached) return cached;

    const blob: Blob | null = await browser.runtime.sendMessage({
      type: 'GET_BLOB',
      payload: { id: meta.id },
    });
    if (!blob) return null;

    const url = URL.createObjectURL(blob);
    objectURLs.set(meta.id, url);
    return url;
  }

  const player = new AudioPlayer(playerEl, meta.durationMs, ensureObjectURL);
  players.push(player);

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting...';

    // Background owns the export pipeline (template, subfolder, downloads API).
    // This keeps the lazy-loaded objectURL cache for in-page playback only.
    const result: { ok: boolean; error?: string } = await browser.runtime.sendMessage({
      type: 'EXPORT_RECORDING',
      payload: { id: meta.id },
    });

    if (!result.ok) {
      exportBtn.textContent = 'Error';
      logger.error('Export failed:', result.error);
      setTimeout(() => {
        exportBtn.textContent = 'Export';
        exportBtn.disabled = false;
      }, 1500);
      return;
    }

    exportBtn.textContent = 'Exported';
    setTimeout(() => {
      exportBtn.textContent = 'Export';
      exportBtn.disabled = false;
    }, 1500);
  });

  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`Delete recording from "${meta.sourceHost}"?\n\nThis cannot be undone.`)) return;

    deleteBtn.disabled = true;
    player.destroy();
    const idx = players.indexOf(player);
    if (idx !== -1) players.splice(idx, 1);

    const url = objectURLs.get(meta.id);
    if (url) {
      URL.revokeObjectURL(url);
      objectURLs.delete(meta.id);
    }

    await browser.runtime.sendMessage({ type: 'DELETE_RECORDING', payload: { id: meta.id } });

    li.remove();
    if (!listEl.children.length) {
      listEl.hidden = true;
      emptyMsg.hidden = false;
    }
  });

  return li;
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
