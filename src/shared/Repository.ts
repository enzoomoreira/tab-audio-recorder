import type {
  IRepository,
  Recording,
  RecordingMetadata,
  RecordingFilter,
  SortOptions,
} from '../types';
import { createLogger } from './Logger';

const DB_NAME = 'tab-audio-recorder';
const DB_VERSION = 2;
const STORE_META = 'metadata';
const STORE_BLOBS = 'blobs';
const STORE_CHUNKS = 'chunks';

interface StoredChunk {
  id: string;
  sequence: number;
  blob: Blob;
}

const logger = createLogger('Repository');

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        const store = db.createObjectStore(STORE_META, { keyPath: 'id' });
        store.createIndex('sourceHost', 'sourceHost', { unique: false });
        store.createIndex('startedAt', 'startedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        db.createObjectStore(STORE_CHUNKS, { keyPath: ['id', 'sequence'] }).createIndex('id', 'id');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function req<T>(idbRequest: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error);
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

function deleteChunks(tx: IDBTransaction, id: string): void {
  const store = tx.objectStore(STORE_CHUNKS);
  const request = store.index('id').openKeyCursor(IDBKeyRange.only(id));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    store.delete(cursor.primaryKey);
    cursor.continue();
  };
}

function requireOwner(
  metadata: RecordingMetadata | undefined,
  tabId: number,
  frameId: number,
): RecordingMetadata {
  if (
    !metadata ||
    metadata.status !== 'recording' ||
    metadata.ownerTabId !== tabId ||
    metadata.ownerFrameId !== frameId
  ) {
    throw new Error('Recording session is not active or belongs to another frame');
  }
  return metadata;
}

export class IndexedDBRepository implements IRepository {
  private db: Promise<IDBDatabase> = openDB();

  private async mutate<T>(
    id: string,
    update: (metadata: RecordingMetadata | undefined, tx: IDBTransaction) => T,
  ): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_CHUNKS, STORE_BLOBS], 'readwrite');
      let result: T;
      let failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Recording transaction aborted'));
      const request = tx.objectStore(STORE_META).get(id);
      request.onsuccess = () => {
        try {
          result = update(request.result as RecordingMetadata | undefined, tx);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
    });
  }

  async begin(metadata: RecordingMetadata): Promise<void> {
    await this.mutate(metadata.id, (existing, tx) => {
      if (existing) throw new Error('Recording session already exists');
      tx.objectStore(STORE_META).add({
        ...metadata,
        status: 'recording',
        nextSequence: 0,
        sizeBytes: 0,
      });
    });
  }

  async append(
    id: string,
    tabId: number,
    frameId: number,
    sequence: number,
    blob: Blob,
    endedAt: number,
    startedAt: number,
  ): Promise<void> {
    await this.mutate(id, (existing, tx) => {
      const metadata = requireOwner(existing, tabId, frameId);
      if (sequence !== metadata.nextSequence)
        throw new Error('Recording chunk arrived out of order');
      const captureStartedAt = sequence === 0 ? startedAt : metadata.startedAt;
      tx.objectStore(STORE_CHUNKS).add({ id, sequence, blob });
      tx.objectStore(STORE_META).put({
        ...metadata,
        nextSequence: sequence + 1,
        sizeBytes: metadata.sizeBytes + blob.size,
        endedAt,
        startedAt: captureStartedAt,
        durationMs: Math.max(0, endedAt - captureStartedAt),
        mimeType: metadata.mimeType || blob.type,
      });
    });
  }

  async finalize(
    id: string,
    tabId: number,
    frameId: number,
    chunkCount: number,
    endedAt: number,
  ): Promise<RecordingMetadata> {
    return this.mutate(id, (existing, tx) => {
      const metadata = requireOwner(existing, tabId, frameId);
      if (chunkCount !== metadata.nextSequence || metadata.sizeBytes === 0)
        throw new Error('Recording is empty or has missing chunks');
      const complete: RecordingMetadata = {
        ...metadata,
        status: 'complete',
        endedAt,
        durationMs: Math.max(0, endedAt - metadata.startedAt),
      };
      tx.objectStore(STORE_META).put(complete);
      return complete;
    });
  }

  async interrupt(id: string): Promise<void> {
    await this.mutate(id, (metadata, tx) => {
      if (metadata?.status !== 'recording') return;
      if (metadata.sizeBytes === 0) {
        tx.objectStore(STORE_META).delete(id);
        tx.objectStore(STORE_BLOBS).delete(id);
        deleteChunks(tx, id);
      } else {
        tx.objectStore(STORE_META).put({ ...metadata, status: 'interrupted' });
      }
    });
  }

  async interruptAllExcept(ids: string[]): Promise<void> {
    const db = await this.db;
    const tx = db.transaction([STORE_META, STORE_CHUNKS, STORE_BLOBS], 'readwrite');
    const done = committed(tx);
    const request = tx.objectStore(STORE_META).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const metadata = cursor.value as RecordingMetadata;
      if (metadata.status === 'recording' && !ids.includes(metadata.id)) {
        if (metadata.sizeBytes === 0) {
          cursor.delete();
          tx.objectStore(STORE_BLOBS).delete(metadata.id);
          deleteChunks(tx, metadata.id);
        } else {
          cursor.update({ ...metadata, status: 'interrupted' });
        }
      }
      cursor.continue();
    };
    await done;
  }

  async discard(id: string): Promise<void> {
    await this.deleteById(id);
  }

  async list(filter?: RecordingFilter, sort?: SortOptions): Promise<RecordingMetadata[]> {
    const db = await this.db;
    const tx = db.transaction(STORE_META, 'readonly');
    let rows = await req<RecordingMetadata[]>(tx.objectStore(STORE_META).getAll());
    rows = rows.filter((metadata) => metadata.status !== 'recording' || metadata.sizeBytes > 0);

    if (filter?.host) {
      rows = rows.filter((r) => r.sourceHost === filter.host);
    }
    if (filter?.dateFrom != null) {
      rows = rows.filter((r) => r.startedAt >= filter.dateFrom!);
    }
    if (filter?.dateTo != null) {
      rows = rows.filter((r) => r.startedAt <= filter.dateTo!);
    }

    const field = sort?.field ?? 'startedAt';
    const dir = sort?.direction ?? 'desc';
    rows.sort((a, b) => {
      const diff = (a[field] as number) - (b[field] as number);
      return dir === 'asc' ? diff : -diff;
    });

    return rows;
  }

  async deleteById(id: string): Promise<void> {
    await this.mutate(id, (_metadata, tx) => {
      tx.objectStore(STORE_META).delete(id);
      tx.objectStore(STORE_BLOBS).delete(id);
      deleteChunks(tx, id);
    });
    logger.info('Deleted', id);
  }

  async getBlobById(id: string): Promise<Blob | null> {
    return (await this.getById(id))?.blob ?? null;
  }

  async getMetadataById(id: string): Promise<RecordingMetadata | null> {
    const db = await this.db;
    const tx = db.transaction(STORE_META, 'readonly');
    return (await req<RecordingMetadata | undefined>(tx.objectStore(STORE_META).get(id))) ?? null;
  }

  async getById(id: string): Promise<Recording | null> {
    const db = await this.db;
    const tx = db.transaction([STORE_META, STORE_BLOBS, STORE_CHUNKS], 'readonly');
    const [meta, blobEntry, chunks] = await Promise.all([
      req<RecordingMetadata | undefined>(tx.objectStore(STORE_META).get(id)),
      req<{ id: string; blob: Blob } | undefined>(tx.objectStore(STORE_BLOBS).get(id)),
      req<StoredChunk[]>(tx.objectStore(STORE_CHUNKS).index('id').getAll(IDBKeyRange.only(id))),
    ]);
    if (!meta) return null;
    if (blobEntry) return { metadata: meta, blob: blobEntry.blob };
    if (!chunks.length) return null;
    return {
      metadata: meta,
      blob: new Blob(
        chunks.map((chunk) => chunk.blob),
        { type: meta.mimeType },
      ),
    };
  }
}
