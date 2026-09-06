// @vitest-environment node
// happy-dom's Blob doesn't survive fake-indexeddb's structured-clone roundtrip
// (it's a stub, not a real Blob with .text()/.arrayBuffer()). Run this file in
// the Node environment, which provides a spec-compliant Blob that clones cleanly.
import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { IndexedDBRepository } from './Repository';
import type { RecordingMetadata } from '../types';

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

async function persistRecording(
  repo: IndexedDBRepository,
  id: string,
  overrides: Partial<RecordingMetadata> = {},
  body = 'audio-data',
): Promise<void> {
  const metadata = meta(id, { ...overrides, ownerTabId: 1, ownerFrameId: 0 });
  const blob = new Blob(
    [overrides.sizeBytes === undefined ? body : new Uint8Array(overrides.sizeBytes)],
    { type: 'audio/webm' },
  );
  await repo.begin(metadata);
  await repo.append(id, 1, 0, 0, blob, metadata.endedAt, metadata.startedAt);
  await repo.finalize(id, 1, 0, 1, metadata.endedAt);
}

describe('IndexedDBRepository', () => {
  let repo: IndexedDBRepository;

  beforeEach(() => {
    // Reset IDB between tests so each starts with a fresh DB.
    (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;
    repo = new IndexedDBRepository();
  });

  it('finalize then list returns the metadata', async () => {
    await persistRecording(repo, 'a');
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('a');
  });

  it('append persists the blob and getBlobById reads it back', async () => {
    await persistRecording(repo, 'a', {}, 'hello-bytes');
    const blob = await repo.getBlobById('a');
    expect(blob).not.toBeNull();
    expect(await blob?.text()).toBe('hello-bytes');
  });

  it('getBlobById returns null for missing id', async () => {
    expect(await repo.getBlobById('missing')).toBeNull();
  });

  it('getById returns both metadata and blob, or null if either is missing', async () => {
    await persistRecording(repo, 'a');
    const r = await repo.getById('a');
    expect(r?.metadata.id).toBe('a');
    expect(r?.blob).toBeInstanceOf(Blob);
    expect(await repo.getById('nope')).toBeNull();
  });

  it('deleteById removes both metadata and blob', async () => {
    await persistRecording(repo, 'a');
    await repo.deleteById('a');
    expect(await repo.list()).toHaveLength(0);
    expect(await repo.getBlobById('a')).toBeNull();
  });

  it('list filters by host', async () => {
    await persistRecording(repo, 'a', { sourceHost: 'example.com' });
    await persistRecording(repo, 'b', { sourceHost: 'other.com' });
    const filtered = await repo.list({ host: 'other.com' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('b');
  });

  it('list filters by dateFrom and dateTo', async () => {
    await persistRecording(repo, 'a', { startedAt: 100 });
    await persistRecording(repo, 'b', { startedAt: 200 });
    await persistRecording(repo, 'c', { startedAt: 300 });
    const result = await repo.list({ dateFrom: 150, dateTo: 250 });
    expect(result.map((r) => r.id)).toEqual(['b']);
  });

  it('list sorts by startedAt desc by default', async () => {
    await persistRecording(repo, 'a', { startedAt: 100 });
    await persistRecording(repo, 'b', { startedAt: 300 });
    await persistRecording(repo, 'c', { startedAt: 200 });
    const sorted = await repo.list();
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('list sorts asc by sizeBytes when requested', async () => {
    await persistRecording(repo, 'a', { sizeBytes: 30 });
    await persistRecording(repo, 'b', { sizeBytes: 10 });
    await persistRecording(repo, 'c', { sizeBytes: 20 });
    const sorted = await repo.list(undefined, { field: 'sizeBytes', direction: 'asc' });
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('begin with same id rejects without replacing the recording', async () => {
    await persistRecording(repo, 'a', { sourceTitle: 'v1' });
    await expect(repo.begin(meta('a', { sourceTitle: 'v2' }))).rejects.toThrow(
      'Recording session already exists',
    );
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.sourceTitle).toBe('v1');
  });
});
