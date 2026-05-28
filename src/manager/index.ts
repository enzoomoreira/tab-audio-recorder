import { createLogger } from '../shared/Logger';
import type { RecordingMetadata, SortField, SortDirection } from '../types';

const logger = createLogger('Manager');

const loadingMsg = document.getElementById('loadingMsg')!;
const emptyMsg = document.getElementById('emptyMsg')!;
const listEl = document.getElementById('list')!;
const hostFilterEl = document.getElementById('hostFilter') as HTMLInputElement;
const sortFieldEl = document.getElementById('sortField') as HTMLSelectElement;
const sortDirEl = document.getElementById('sortDir') as HTMLSelectElement;

let debounceHandle: ReturnType<typeof setTimeout>;

// Object URL cache: tracks URLs created for blobs so we can revoke on delete
const objectURLs = new Map<string, string>();

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

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function extFromMime(mime: string): string {
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
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

  if (!recordings.length) {
    emptyMsg.hidden = false;
    return;
  }

  listEl.innerHTML = '';
  for (const rec of recordings) {
    listEl.appendChild(buildCard(rec));
  }
  listEl.hidden = false;
}

function buildCard(meta: RecordingMetadata): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset['id'] = meta.id;

  // <audio> starts hidden — revealed only after the blob is loaded and playback starts.
  // This avoids showing an empty/broken player to the user.
  li.innerHTML = `
    <div class="card__header">
      <span class="card__host">${escapeHtml(meta.sourceHost)}</span>
      <span class="card__date">${escapeHtml(formatDate(meta.startedAt))}</span>
    </div>
    <div class="card__title" title="${escapeHtml(meta.sourceTitle)}">${escapeHtml(meta.sourceTitle)}</div>
    <audio class="card__player" controls preload="none" aria-label="Recording player" hidden></audio>
    <div class="card__footer">
      <span class="card__meta">${formatDuration(meta.durationMs)} &middot; ${formatSize(meta.sizeBytes)} &middot; ${escapeHtml(meta.mimeType.split(';')[0] ?? meta.mimeType)}</span>
      <div class="card__actions">
        <button class="btn btn--play" data-action="play">Play</button>
        <button class="btn btn--save" data-action="save">Save file</button>
        <button class="btn btn--danger" data-action="delete">Delete</button>
      </div>
    </div>
  `;

  const audio = li.querySelector('.card__player') as HTMLAudioElement;
  const playBtn = li.querySelector('[data-action="play"]') as HTMLButtonElement;
  const saveBtn = li.querySelector('[data-action="save"]') as HTMLButtonElement;
  const deleteBtn = li.querySelector('[data-action="delete"]') as HTMLButtonElement;

  // Fetches the blob once and caches the object URL for subsequent Save calls.
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

  // Play button: load blob, reveal player, start playback, then hide itself
  // (the native audio controls take over from that point).
  playBtn.addEventListener('click', async () => {
    playBtn.disabled = true;
    playBtn.textContent = 'Loading...';

    const url = await ensureObjectURL();
    if (!url) {
      playBtn.textContent = 'Error';
      playBtn.disabled = false;
      return;
    }

    audio.src = url;
    audio.hidden = false;
    void audio.play();
    playBtn.hidden = true; // native controls replace the button from here
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const url = await ensureObjectURL();
    if (!url) {
      saveBtn.textContent = 'Error';
      saveBtn.disabled = false;
      return;
    }

    const ext = extFromMime(meta.mimeType);
    const dateStr = new Date(meta.startedAt).toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const filename = `${meta.sourceHost}_${dateStr}.${ext}`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    saveBtn.textContent = 'Save file';
    saveBtn.disabled = false;
  });

  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`Delete recording from "${meta.sourceHost}"?\n\nThis cannot be undone.`)) return;

    deleteBtn.disabled = true;

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

void loadRecordings();
