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

  li.innerHTML = `
    <div class="card__header">
      <span class="card__host">${escapeHtml(meta.sourceHost)}</span>
      <span class="card__date">${escapeHtml(formatDate(meta.startedAt))}</span>
    </div>
    <div class="card__title" title="${escapeHtml(meta.sourceTitle)}">${escapeHtml(meta.sourceTitle)}</div>
    <audio class="card__player" controls preload="none" aria-label="Recording player"></audio>
    <div class="card__footer">
      <span class="card__meta">${formatDuration(meta.durationMs)} &middot; ${formatSize(meta.sizeBytes)} &middot; ${escapeHtml(meta.mimeType.split(';')[0] ?? meta.mimeType)}</span>
      <div class="card__actions">
        <button class="btn btn--load" data-action="load">Load audio</button>
        <button class="btn btn--save" data-action="save">Save file</button>
        <button class="btn btn--danger" data-action="delete">Delete</button>
      </div>
    </div>
  `;

  const audio = li.querySelector('.card__player') as HTMLAudioElement;
  const loadBtn = li.querySelector('[data-action="load"]') as HTMLButtonElement;
  const saveBtn = li.querySelector('[data-action="save"]') as HTMLButtonElement;
  const deleteBtn = li.querySelector('[data-action="delete"]') as HTMLButtonElement;

  async function fetchBlob(): Promise<Blob | null> {
    return browser.runtime.sendMessage({ type: 'GET_BLOB', payload: { id: meta.id } });
  }

  function getOrCreateObjectURL(blob: Blob): string {
    let url = objectURLs.get(meta.id);
    if (!url) {
      url = URL.createObjectURL(blob);
      objectURLs.set(meta.id, url);
    }
    return url;
  }

  loadBtn.addEventListener('click', async () => {
    loadBtn.disabled = true;
    loadBtn.textContent = 'Loading...';

    const blob = await fetchBlob();
    if (!blob) {
      loadBtn.textContent = 'Error';
      return;
    }

    audio.src = getOrCreateObjectURL(blob);
    void audio.play();
    loadBtn.textContent = 'Loaded';
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Preparing...';

    const blob = await fetchBlob();
    if (!blob) {
      saveBtn.textContent = 'Error';
      saveBtn.disabled = false;
      return;
    }

    const ext = extFromMime(meta.mimeType);
    const dateStr = new Date(meta.startedAt).toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const filename = `${meta.sourceHost}_${dateStr}.${ext}`;

    const a = document.createElement('a');
    a.href = getOrCreateObjectURL(blob);
    a.download = filename;
    a.click();

    saveBtn.textContent = 'Save file';
    saveBtn.disabled = false;
  });

  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`Delete recording from "${meta.sourceHost}"?\n\nThis cannot be undone.`)) return;

    deleteBtn.disabled = true;

    // Revoke any open object URL for this blob
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
