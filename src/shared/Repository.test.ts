// @vitest-environment node
// happy-dom's Blob doesn't survive fake-indexeddb's structured-clone roundtrip
// (it's a stub, not a real Blob with .text()/.arrayBuffer()). Run this file in
// the Node environment, which provides a spec-compliant Blob that clones cleanly.
import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDBRepository } from './Repository';
import type { Recording, RecordingMetadata } from '../types';

function meta(id: string, overrides: Partial<RecordingMetadata> = {}): RecordingMetadata {
  return {
    id,
    sourceUrl: `https://${overrides.sourceHost ?? 'example.com'}/`,
    sourceHost: 'example.com',
    sourceTitle: `Track ${id}`,
    mimeType: 'audio/webm;codecs=opus',
    durationMs: 5000,
    sizeBytes: 1024,
    startedAt: Date.UTC(2026, 0, 1),
    endedAt: Date.UTC(2026, 0, 1) + 5000,
    ...overrides,
  };
}

function rec(
  id: string,
  overrides: Partial<RecordingMetadata> = {},
  body = 'audio-data',
): Recording {
  return {
    metadata: meta(id, overrides),
    blob: new Blob([body], { type: 'audio/webm' }),
  };
}

describe('IndexedDBRepository', () => {
  let repo: IndexedDBRepository;

  beforeEach(() => {
    // Reset IDB between tests so each starts with a fresh DB.
    (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
    repo = new IndexedDBRepository();
  });

  it('save then list returns the metadata', async () => {
    await repo.save(rec('a'));
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('a');
  });

  it('save persists the blob and getBlobById reads it back', async () => {
    await repo.save(rec('a', {}, 'hello-bytes'));
    const blob = await repo.getBlobById('a');
    expect(blob).not.toBeNull();
    expect(await blob?.text()).toBe('hello-bytes');
  });

  it('getBlobById returns null for missing id', async () => {
    expect(await repo.getBlobById('missing')).toBeNull();
  });

  it('getById returns both metadata and blob, or null if either is missing', async () => {
    await repo.save(rec('a'));
    const r = await repo.getById('a');
    expect(r?.metadata.id).toBe('a');
    expect(r?.blob).toBeInstanceOf(Blob);
    expect(await repo.getById('nope')).toBeNull();
  });

  it('deleteById removes both metadata and blob', async () => {
    await repo.save(rec('a'));
    await repo.deleteById('a');
    expect(await repo.list()).toHaveLength(0);
    expect(await repo.getBlobById('a')).toBeNull();
  });

  it('list filters by host', async () => {
    await repo.save(rec('a', { sourceHost: 'example.com' }));
    await repo.save(rec('b', { sourceHost: 'other.com' }));
    const filtered = await repo.list({ host: 'other.com' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('b');
  });

  it('list filters by dateFrom and dateTo', async () => {
    await repo.save(rec('a', { startedAt: 100 }));
    await repo.save(rec('b', { startedAt: 200 }));
    await repo.save(rec('c', { startedAt: 300 }));
    const result = await repo.list({ dateFrom: 150, dateTo: 250 });
    expect(result.map((r) => r.id)).toEqual(['b']);
  });

  it('list sorts by startedAt desc by default', async () => {
    await repo.save(rec('a', { startedAt: 100 }));
    await repo.save(rec('b', { startedAt: 300 }));
    await repo.save(rec('c', { startedAt: 200 }));
    const sorted = await repo.list();
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('list sorts asc by sizeBytes when requested', async () => {
    await repo.save(rec('a', { sizeBytes: 30 }));
    await repo.save(rec('b', { sizeBytes: 10 }));
    await repo.save(rec('c', { sizeBytes: 20 }));
    const sorted = await repo.list(undefined, { field: 'sizeBytes', direction: 'asc' });
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('save with same id overwrites previous record', async () => {
    await repo.save(rec('a', { sourceTitle: 'v1' }));
    await repo.save(rec('a', { sourceTitle: 'v2' }));
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.sourceTitle).toBe('v2');
  });
});
