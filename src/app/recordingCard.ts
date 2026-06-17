import { createLogger } from '../shared/Logger';
import { AudioPlayer } from './AudioPlayer';
import type { RecordingMetadata, ActionResult } from '../types';

const logger = createLogger('RecordingCard');

// The data/lifecycle hooks a card needs from the recordings view. Kept as an
// interface so the card builder stays a pure view concern: it never touches the
// object-URL cache, the runtime message bus, or the players array directly.
export interface CardActions {
  /** Resolve (and cache) an object URL for the recording's blob, or null. */
  loadBlobURL(id: string): Promise<string | null>;
  /** Run the background export pipeline for the recording. */
  exportRecording(id: string): Promise<ActionResult>;
  /** Delete the recording (blob + metadata) and release its cached URL. */
  deleteRecording(id: string): Promise<void>;
  /** Track a player so the view can tear it down on reload/unload. */
  registerPlayer(player: AudioPlayer): void;
  /** Destroy a player and stop tracking it. */
  releasePlayer(player: AudioPlayer): void;
  /** Called after a delete leaves the list empty. */
  onListEmptied(): void;
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
// so the view never assembles HTML from strings.
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

/** Builds one recording card: header, inline lazy player, and export/delete actions. */
export function buildCard(meta: RecordingMetadata, actions: CardActions): HTMLLIElement {
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

  const player = new AudioPlayer(playerEl, meta.durationMs, () => actions.loadBlobURL(meta.id));
  actions.registerPlayer(player);

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting...';

    const result = await actions.exportRecording(meta.id);

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
    actions.releasePlayer(player);
    await actions.deleteRecording(meta.id);

    const list = li.parentElement;
    li.remove();
    if (list && list.children.length === 0) actions.onListEmptied();
  });

  return li;
}
