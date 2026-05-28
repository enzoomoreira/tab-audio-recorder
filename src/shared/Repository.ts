import type { IRepository, Recording, RecordingMetadata, RecordingFilter, SortOptions } from '../types';
import { createLogger } from './Logger';

const DB_NAME = 'tab-audio-recorder';
const DB_VERSION = 1;
const STORE_META = 'metadata';
const STORE_BLOBS = 'blobs';

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

export class IndexedDBRepository implements IRepository {
  private db: Promise<IDBDatabase> = openDB();

  async save(recording: Recording): Promise<string> {
    const db = await this.db;
    const tx = db.transaction([STORE_META, STORE_BLOBS], 'readwrite');
    await Promise.all([
      req(tx.objectStore(STORE_META).put(recording.metadata)),
      req(tx.objectStore(STORE_BLOBS).put({ id: recording.metadata.id, blob: recording.blob })),
    ]);
    logger.info('Saved', recording.metadata.id, `(${(recording.blob.size / 1024).toFixed(0)} KB)`);
    return recording.metadata.id;
  }

  async list(filter?: RecordingFilter, sort?: SortOptions): Promise<RecordingMetadata[]> {
    const db = await this.db;
    const tx = db.transaction(STORE_META, 'readonly');
    let rows = await req<RecordingMetadata[]>(tx.objectStore(STORE_META).getAll());

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
    const db = await this.db;
    const tx = db.transaction([STORE_META, STORE_BLOBS], 'readwrite');
    await Promise.all([
      req(tx.objectStore(STORE_META).delete(id)),
      req(tx.objectStore(STORE_BLOBS).delete(id)),
    ]);
    logger.info('Deleted', id);
  }

  async getBlobById(id: string): Promise<Blob | null> {
    const db = await this.db;
    const tx = db.transaction(STORE_BLOBS, 'readonly');
    const entry = await req<{ id: string; blob: Blob } | undefined>(
      tx.objectStore(STORE_BLOBS).get(id),
    );
    return entry?.blob ?? null;
  }
}
