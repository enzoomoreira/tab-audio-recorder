import { Window } from 'happy-dom';
import { IDBFactory, IDBDatabase, IDBObjectStore } from 'fake-indexeddb';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RecordingMetadata } from '../../src/types';

const before = process.argv.includes('--before');
const results: Record<string, boolean> = {};
const win = new Window({ url: 'https://extension.invalid/app/index.html' });
Object.assign(win, { SyntaxError });
const globals = globalThis as Record<string, unknown>;
globals.__TEST_BRIDGE__ = false;
globals.document = win.document;
globals.window = win;
globals.confirm = (): boolean => true;
globals.indexedDB = new IDBFactory();
process.on('unhandledRejection', (): void => {});
console.error = (...args: unknown[]): void => {
  console.log(...args.map((value) => (value instanceof Error ? value.message : value)));
};
const tick = (): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, 20));

async function sourceModule(path: string): Promise<Record<string, unknown>> {
  const source = before
    ? Bun.spawnSync(['git', 'show', `79214b0:${path}`], { timeout: 10000 }).stdout.toString()
    : await Bun.file(path).text();
  const resolved = source.replace(/from ['"](\.[^'"]+)['"]/g, (_: string, dep: string): string => {
    const absolute = resolve(dirname(path), dep);
    return `from '${pathToFileURL(absolute + '.ts').href}'`;
  });
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(resolved);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const meta: RecordingMetadata = {
  id: 'repro',
  sourceUrl: 'https://example.com',
  sourceHost: 'example.com',
  sourceTitle: 'Audio',
  mimeType: 'audio/webm',
  durationMs: 1000,
  sizeBytes: 5,
  startedAt: 1000,
  endedAt: 2000,
};
const capture = {
  blob: new Blob(['audio']),
  mimeType: meta.mimeType,
  durationMs: 1000,
  startedAt: 1000,
  endedAt: 2000,
};

// A request success is followed by an abort before transaction completion.
const repoModule = await sourceModule('src/shared/Repository.ts');
const Repository =
  repoModule.IndexedDBRepository as typeof import('../../src/shared/Repository').IndexedDBRepository;
const repo = new Repository();
const originalPut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>): IDBRequest {
  const request = originalPut.apply(this, args);
  if (this.name === 'blobs')
    request.addEventListener('success', (): void => this.transaction.abort());
  return request;
};
let rejected = false;
try {
  await repo.save({ metadata: meta, blob: capture.blob });
} catch {
  rejected = true;
}
await tick();
results.abortedSaveRejected = rejected && (await repo.list()).length === 0;
IDBObjectStore.prototype.put = originalPut;
let committed = false;
const originalTransaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (
  ...args: Parameters<IDBDatabase['transaction']>
): IDBTransaction {
  const transaction = originalTransaction.apply(this, args);
  if (args[1] === 'readwrite')
    transaction.addEventListener('complete', (): void => {
      committed = true;
    });
  return transaction;
};
await repo.save({ metadata: meta, blob: capture.blob });
results.saveWaitsForCommit = committed;
IDBDatabase.prototype.transaction = originalTransaction;

class FakeAudio extends win.EventTarget {
  static instances: FakeAudio[] = [];
  src = '';
  paused = true;
  duration = 1;
  currentTime = 0;
  playCount = 0;
  constructor() {
    super();
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.playCount++;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {}
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
}
globals.Audio = FakeAudio;
const playerModule = await sourceModule('src/app/AudioPlayer.ts');
const Player = playerModule.AudioPlayer as typeof import('../../src/app/AudioPlayer').AudioPlayer;
function playerContainer(): HTMLElement {
  const container = win.document.createElement('div');
  container.innerHTML =
    '<button class="player__btn"></button><input class="player__scrubber"><span class="player__time"></span>';
  return container as unknown as HTMLElement;
}
let finishLoad!: (value: string) => void;
const playerEl = playerContainer();
const player = new Player(
  playerEl,
  1000,
  (): Promise<string> =>
    new Promise((done) => {
      finishLoad = done;
    }),
);
playerEl.querySelector<HTMLButtonElement>('button')!.click();
player.destroy();
finishLoad('blob:late');
await tick();
results.destroyedPlayerStaysStopped = FakeAudio.instances.at(-1)!.playCount === 0;
let attempts = 0;
const retryEl = playerContainer();
new Player(retryEl, 1000, async (): Promise<string> => {
  attempts++;
  throw new Error('Read failed');
});
retryEl.querySelector<HTMLButtonElement>('button')!.click();
await tick();
retryEl.querySelector<HTMLButtonElement>('button')!.click();
await tick();
results.failedPlayerCanRetry = attempts === 2;

let revoked = 0;
const listeners = new Set<(delta: { id: number; state: { current: string } }) => void>();
let storedSettings: Record<string, unknown> = {};
let failSettings = false;
let delayNextWrite = false;
globals.browser = {
  tabs: { get: async (): Promise<object> => ({ url: meta.sourceUrl, title: meta.sourceTitle }) },
  storage: {
    local: {
      get: async (): Promise<object> => ({ settings: storedSettings }),
      set: async (value: { settings: Record<string, unknown> }): Promise<void> => {
        if (failSettings) throw new Error('Storage failed');
        if (delayNextWrite) {
          delayNextWrite = false;
          await new Promise((done) => setTimeout(done, 150));
        }
        storedSettings = value.settings;
      },
    },
  },
  downloads: {
    onChanged: {
      addListener: (fn: (delta: { id: number; state: { current: string } }) => void): void => {
        listeners.add(fn);
      },
      removeListener: (fn: (delta: { id: number; state: { current: string } }) => void): void => {
        listeners.delete(fn);
      },
    },
    download: async (): Promise<number> => {
      for (const fn of listeners) fn({ id: 1, state: { current: 'complete' } });
      return 1;
    },
  },
};
globals.AudioContext = class {
  decodeAudioData(): Promise<object> {
    return Promise.resolve({
      numberOfChannels: 1,
      length: 8,
      sampleRate: 48000,
      getChannelData: (): Float32Array => new Float32Array(8),
    });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
};
URL.createObjectURL = (): string => 'blob:download';
URL.revokeObjectURL = (): void => {
  revoked++;
};
const serviceModule = await sourceModule('src/background/RecordingsService.ts');
const service = serviceModule as unknown as typeof import('../../src/background/RecordingsService');
await service.exportRecording({ metadata: meta, blob: capture.blob });
results.earlyDownloadReleasesURL = revoked === 1 && listeners.size === 0;

win.document.body.innerHTML = await Bun.file('src/app/index.html').text();
const settingsModule = await sourceModule('src/app/settings.ts');
const { DEFAULT_SETTINGS } = await import('../../src/shared/Settings');
(settingsModule.initSettings as (settings: typeof DEFAULT_SETTINGS) => void)(DEFAULT_SETTINGS);
const template = win.document.getElementById('filenameTemplate') as unknown as HTMLInputElement;
template.value = 'Changed_{host}';
delayNextWrite = true;
template.dispatchEvent(new win.Event('input') as unknown as Event);
await new Promise((done) => setTimeout(done, 330));
(win.document.getElementById('resetBtn') as unknown as HTMLButtonElement).click();
await new Promise((done) => setTimeout(done, 400));
results.resetWinsOverInFlightSave =
  storedSettings.filenameTemplate === DEFAULT_SETTINGS.filenameTemplate;
failSettings = true;
template.value = 'Fail_{host}';
template.dispatchEvent(new win.Event('input') as unknown as Event);
await new Promise((done) => setTimeout(done, 400));
results.settingsFailureVisible = win.document
  .getElementById('status')!
  .textContent!.includes('Could not save');
const cardModule = await sourceModule('src/app/recordingCard.ts');
const buildCard = cardModule.buildCard as typeof import('../../src/app/recordingCard').buildCard;
let released = false;
const card = buildCard(meta, {
  loadBlobURL: async (): Promise<null> => null,
  exportRecording: async (): Promise<never> => {
    throw new Error('Export connection failed');
  },
  deleteRecording: async (): Promise<never> => {
    throw new Error('Delete connection failed');
  },
  registerPlayer: (): void => {},
  releasePlayer: (): void => {
    released = true;
  },
  onListEmptied: (): void => {},
});
card.querySelector<HTMLButtonElement>('[data-action="export"]')!.click();
await new Promise((done) => setTimeout(done, 1550));
results.exportFailureAllowsRetry =
  !card.querySelector<HTMLButtonElement>('[data-action="export"]')!.disabled;
card.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click();
await tick();
results.deleteFailurePreservesPlayer =
  !released && !card.querySelector<HTMLButtonElement>('[data-action="delete"]')!.disabled;

const pendingLists: Array<(rows: RecordingMetadata[]) => void> = [];
Object.assign(globals.browser as object, {
  runtime: {
    sendMessage: (): Promise<RecordingMetadata[]> => new Promise((done) => pendingLists.push(done)),
  },
});
const recordingsModule = await sourceModule('src/app/recordings.ts');
const initialLoad = (
  recordingsModule.initRecordings as (settings: typeof DEFAULT_SETTINGS) => Promise<void>
)(DEFAULT_SETTINGS);
win.document.getElementById('sortDir')!.dispatchEvent(new win.Event('change'));
pendingLists[1]!([{ ...meta, id: 'new' }]);
await tick();
pendingLists[0]!([{ ...meta, id: 'old' }]);
await initialLoad;
results.latestListResponseWins =
  win.document.getElementById('list')!.firstElementChild?.getAttribute('data-id') === 'new';
win.dispatchEvent(new win.Event('pagehide'));
console.log(JSON.stringify({ mode: before ? 'before' : 'after', results }, null, 2));
await win.happyDOM.abort();
if (!before && Object.values(results).some((ok) => !ok)) process.exitCode = 1;
