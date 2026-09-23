import Dexie from 'dexie';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkItem, sourceBody, sourceHash } from '../lib/chunking';
import {
  cancelIndexing, ensureContentIndex, getIndexOverview, rebuildIndexes, scheduleIndexing, waitForIndexing,
} from '../lib/content-index';
import { embeddingKey } from '../lib/embeddings';
import { db, deleteItem, exportBackup, importBackup, saveCapture, updateItem } from '../lib/library';
import { getSettings, saveSettings } from '../lib/settings';
import { DEFAULT_SETTINGS, type Item, type Settings } from '../lib/types';

const mocks = vi.hoisted(() => ({ embed: vi.fn(), settings: {} as Record<string, unknown> }));
vi.mock('../lib/embeddings', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/embeddings')>(), embedTexts: mocks.embed,
}));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: {
    get: vi.fn(async () => ({ settings: structuredClone(mocks.settings) })),
    set: vi.fn(async ({ settings }) => { mocks.settings = structuredClone(settings); }),
  } },
  permissions: { contains: vi.fn(async () => true) },
} }));
const now = '2026-09-22T10:00:00.000Z';
function fixture(id = 'source'): Item {
  return { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`,
    title: 'Source title', description: 'Source description', excerpt: '',
    content: '# Installation\nInstall the package.\n\n## Streaming\nStreams Markdown events.',
    source: 'article', domain: 'example.com', author: '', publishedAt: '', truncated: false,
    tags: ['raw-tag'], keywords: [], category: '', notes: 'PRIVATE_NOTE', selections: ['PRIVATE_SELECTION'],
    summaryOverride: 'MANUAL_SUMMARY', tagsOverride: ['MANUAL_TAG'], categoryOverride: 'MANUAL_CATEGORY',
    ai: { summary: 'AI_SUMMARY', category: 'AI_CATEGORY', tags: ['AI_TAG'], keywords: ['AI_KEYWORD'],
      stack: [], useCases: [], provider: 'compatible', model: 'test', analyzedAt: now },
    analysisStatus: 'disabled', contentVersion: 1, createdAt: now, updatedAt: now };
}
async function configure(patch: Partial<Settings>): Promise<Settings> {
  return saveSettings({ ...await getSettings(), ...patch });
}
async function run(): Promise<void> { scheduleIndexing(); await waitForIndexing(); }
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function pauseEmbedding() {
  const started = gate<void>();
  const released = gate<void>();
  mocks.embed.mockImplementationOnce(async (texts: string[], _settings: Settings, signal: AbortSignal) => {
    started.resolve();
    await Promise.race([released.promise, new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })]);
    return texts.map(() => [1, 0, 0]);
  });
  return { started: started.promise, release: () => released.resolve() };
}

beforeEach(async () => {
  cancelIndexing();
  await waitForIndexing();
  if (!db.isOpen()) await db.open();
  await db.transaction('rw', db.tables, () => Promise.all(db.tables.map(table => table.clear())));
  mocks.settings = { ...DEFAULT_SETTINGS, semanticEnabled: true, embeddingEndpoint: 'https://vectors.example/v1',
    embeddingModel: 'multilingual', embeddingApiKey: 'SECRET' };
  mocks.embed.mockReset();
  mocks.embed.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]));
});
afterEach(async () => { cancelIndexing(); await waitForIndexing(); });
afterAll(() => db.close());

describe('persistent source index and migration', () => {
  it('upgrades v2 by adding derived stores while preserving items, jobs and chat records', async () => {
    await db.delete();
    const legacy = new Dexie('starts');
    legacy.version(1).stores({ items: 'id, &normalizedUrl, source, createdAt, updatedAt, *tags, category', jobs: 'itemId, status, nextAttempt, leaseUntil' });
    legacy.version(2).stores({ chatSessions: 'id, updatedAt, status', chatMessages: 'id, sessionId, [sessionId+sequence], runId', chatRuns: 'id, sessionId, status, updatedAt' });
    const original = fixture();
    const job = { itemId: original.id, status: 'pending', nextAttempt: 0, leaseUntil: 0 };
    const chat = { id: 'chat', status: 'idle', updatedAt: now, title: 'preserve' };
    await legacy.table('items').put(original);
    await legacy.table('jobs').put(job);
    await legacy.table('chatSessions').put(chat);
    legacy.close();
    await db.open();
    expect(db.verno).toBe(3);
    expect(await db.items.get(original.id)).toEqual(original);
    expect(await db.jobs.get(original.id)).toEqual(job);
    expect(await db.chatSessions.get('chat')).toEqual(chat);
    expect(await db.sourceIndexes.count()).toBe(0);
    expect(await db.sourceChunks.count()).toBe(0);
    expect(await db.chunkVectors.count()).toBe(0);
  });

  it('prepares imports locally and embeds them only when the consented scheduler runs', async () => {
    const original = fixture();
    const backup = JSON.stringify({ schemaVersion: 1, exportedAt: now, items: [original] });
    await importBackup(backup);
    await ensureContentIndex();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(await db.items.get(original.id)).toEqual(original);
    await configure({ localNotesSearch: true });
    await ensureContentIndex();
    expect(mocks.embed).not.toHaveBeenCalled();
    const chunks = await db.sourceChunks.toArray();
    const text = chunks.map(chunk => chunk.text).join('\n');
    expect(text).toContain('Source description');
    expect(text).toContain('raw-tag');
    expect(text).toContain('Streams Markdown events.');
    expect(text).not.toMatch(/PRIVATE_|MANUAL_|AI_/u);
    expect((await db.sourceIndexes.get(original.id))?.status).toBe('pending');
    expect(JSON.parse(await exportBackup()).items).toEqual([original]);
    expect(await getIndexOverview()).toMatchObject({ total: 1, pending: 1, chunks: chunks.length, vectors: 0, running: false });
    await run();
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect((await db.sourceIndexes.get(original.id))?.status).toBe('ready');
  });

  it('keeps unchanged source rows and vectors untouched despite private or AI edits', async () => {
    const original = fixture();
    await db.items.add(original);
    await run();
    const index = await db.sourceIndexes.get(original.id);
    const chunks = await db.sourceChunks.toArray();
    const vectors = await db.chunkVectors.toArray();
    const calls = mocks.embed.mock.calls.length;
    await updateItem(original.id, { notes: 'new PRIVATE_NOTE', summaryOverride: 'new MANUAL_SUMMARY' });
    await db.items.update(original.id, { selections: ['changed'], ai: { ...original.ai!, summary: 'new AI_SUMMARY' } });
    await run();
    expect(await db.sourceIndexes.get(original.id)).toEqual(index);
    expect(await db.sourceChunks.toArray()).toEqual(chunks);
    expect(await db.chunkVectors.toArray()).toEqual(vectors);
    expect(mocks.embed).toHaveBeenCalledTimes(calls);
  });

  it.each(['ready', 'excluded'] as const)('syncs metadata-only content versions while preserving %s state', async status => {
    const item = fixture();
    item.github = { owner: 'team', repo: 'repo', language: 'TypeScript', license: 'MIT', stars: 12, topics: [], fetchedAt: now };
    if (status === 'excluded') item.githubVisibility = 'private';
    await db.items.add(item);
    await run();
    const before = await db.sourceIndexes.get(item.id);
    const chunks = await db.sourceChunks.toArray();
    const vectors = await db.chunkVectors.toArray();
    const calls = mocks.embed.mock.calls.length;
    const refreshed = { ...item, contentVersion: 2, updatedAt: '2026-09-23T10:00:00.000Z',
      github: { ...item.github, fetchedAt: '2026-09-23T10:00:00.000Z' } };
    expect(sourceHash(refreshed)).toBe(sourceHash(item));
    await db.items.put(refreshed);
    await run();
    expect(await db.sourceIndexes.get(item.id)).toMatchObject({ sourceHash: before!.sourceHash, contentVersion: 2, status });
    expect(await db.sourceChunks.toArray()).toEqual(chunks);
    expect(await db.chunkVectors.toArray()).toEqual(vectors);
    expect(mocks.embed).toHaveBeenCalledTimes(calls);
  });

  it('rejects a late pre-rebuild result even when the source hash is unchanged', async () => {
    await db.items.add(fixture());
    const started = gate<void>();
    const release = gate<void>();
    let oldSignal: AbortSignal | undefined;
    mocks.embed.mockImplementationOnce(async (texts: string[], _settings: Settings, signal: AbortSignal) => {
      oldSignal = signal;
      started.resolve();
      await release.promise;
      return texts.map(() => [99, 0, 0]);
    });
    scheduleIndexing();
    await started.promise;
    const oldHash = (await db.sourceIndexes.get('source'))!.sourceHash;
    await rebuildIndexes();
    expect(oldSignal?.aborted).toBe(true);
    await ensureContentIndex();
    expect((await db.sourceIndexes.get('source'))?.sourceHash).toBe(oldHash);
    const committed: number[][] = [];
    const record = (_key: unknown, vector: { values: number[] }) => { committed.push(vector.values); };
    db.chunkVectors.hook('creating', record);
    try {
      release.resolve();
      await waitForIndexing();
    } finally { db.chunkVectors.hook('creating').unsubscribe(record); }
    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect(committed.length).toBeGreaterThan(0);
    expect(committed.every(vector => vector[0] === 1)).toBe(true);
    expect((await db.sourceIndexes.get('source'))?.status).toBe('ready');
  });

  it('atomically deletes derived rows with the item and prunes direct-deletion orphans', async () => {
    await db.items.bulkAdd([fixture('one'), fixture('two')]);
    await run();
    await deleteItem('one');
    expect(await db.sourceIndexes.get('one')).toBeUndefined();
    expect(await db.sourceChunks.where('itemId').equals('one').count()).toBe(0);
    expect(await db.chunkVectors.where('itemId').equals('one').count()).toBe(0);
    await db.items.delete('two');
    await ensureContentIndex([]);
    expect(await db.sourceIndexes.count()).toBe(0);
    expect(await db.sourceChunks.count()).toBe(0);
    expect(await db.chunkVectors.count()).toBe(0);
  });

  it('rolls item and chunk deletion back if vector deletion fails', async () => {
    await db.items.add(fixture());
    await run();
    const fail = () => { throw new Error('storage failure'); };
    db.chunkVectors.hook('deleting', fail);
    try { await expect(deleteItem('source')).rejects.toThrow('storage failure'); }
    finally { db.chunkVectors.hook('deleting').unsubscribe(fail); }
    expect(await db.items.count()).toBe(1);
    expect(await db.sourceChunks.count()).toBeGreaterThan(0);
    expect(await db.chunkVectors.count()).toBeGreaterThan(0);
  });

  it('rebuilds only derived data and returns before the scheduled vector request finishes', async () => {
    await db.items.add(fixture());
    await run();
    const snapshot = await exportBackup();
    await db.chatSessions.put({ id: 'chat', updatedAt: now } as never);
    const pause = pauseEmbedding();
    await rebuildIndexes();
    await pause.started;
    expect((await getIndexOverview()).running).toBe(true);
    expect(JSON.parse(await exportBackup()).items).toEqual(JSON.parse(snapshot).items);
    expect(await db.chatSessions.count()).toBe(1);
    pause.release();
    await waitForIndexing();
    expect((await db.sourceIndexes.get('source'))?.status).toBe('ready');
  });
});

describe('Markdown chunk boundaries and privacy', () => {
  it('preserves headings and exact offsets, keeping normal fenced code together and splitting oversized code', () => {
    const item = fixture();
    item.content = '# API\n\n```ts\n# not a heading\nconst x = 1;\n```\n\n## Large example\n\n```text\n' + 'line of code\n'.repeat(200) + '```';
    const body = sourceBody(item);
    const chunks = chunkItem(item).filter(chunk => chunk.kind === 'body');
    expect(chunks.every(chunk => chunk.text === body.slice(chunk.start, chunk.end))).toBe(true);
    expect(chunks.every(chunk => chunk.text.length <= 1000)).toBe(true);
    expect(chunks.find(chunk => chunk.text.includes('const x'))).toMatchObject({ heading: 'API' });
    expect(chunks.filter(chunk => chunk.text.includes('line of code')).length).toBeGreaterThan(1);
    expect(chunks.filter(chunk => chunk.text.includes('line of code')).every(chunk => chunk.heading === 'Large example')).toBe(true);
    expect(chunks.some(chunk => chunk.heading === 'not a heading')).toBe(false);
  });

  it('uses smaller CJK chunks and keeps distinct excerpts and long paragraphs', () => {
    const item = { ...fixture(), content: '# 功能\n\n' + '可取消的多语言语义检索。'.repeat(200), excerpt: '独立来源摘录' };
    const chunks = chunkItem(item).filter(chunk => chunk.kind === 'body');
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every(chunk => chunk.text.length <= 400)).toBe(true);
    expect(chunks.map(chunk => chunk.text).join('')).toContain('独立来源摘录');
    expect(chunks.every(chunk => chunk.text === sourceBody(item).slice(chunk.start, chunk.end))).toBe(true);
  });

  it('does not create feature evidence from a title-only bookmark', async () => {
    const { item } = await saveCapture({ url: 'http://localhost/page', title: 'Claims every feature' });
    await ensureContentIndex([item]);
    expect(await db.sourceChunks.count()).toBe(0);
    expect(await db.sourceIndexes.get(item.id)).toMatchObject({ contentState: 'link', chunkCount: 0 });
    expect((await getIndexOverview()).linkOnly).toBe(1);
  });

  it('excludes blocked, private and unverified GitHub sources but allows HTTP docs', async () => {
    await configure({ blockedDomains: ['blocked.example'] });
    const github = { ...fixture('github'), url: 'https://github.com/team/repo', normalizedUrl: 'https://github.com/team/repo', source: 'github' as const, domain: 'github.com' };
    await db.items.bulkAdd([
      { ...fixture('blocked'), url: 'https://sub.blocked.example/doc' },
      github, { ...github, id: 'private', normalizedUrl: 'https://github.com/team/private', githubVisibility: 'private' },
      { ...fixture('local'), url: 'http://localhost/doc', source: 'docs' },
    ]);
    await run();
    expect(await db.sourceIndexes.where('status').equals('excluded').count()).toBe(3);
    expect(await db.sourceChunks.where('itemId').equals('github').count()).toBe(0);
    expect(await db.sourceIndexes.get('local')).toMatchObject({ status: 'ready' });
    expect(mocks.embed).toHaveBeenCalledTimes(1);
  });
});

describe('bounded background embedding queue', () => {
  it('runs batches to completion in one startup and coalesces repeated schedule calls', async () => {
    await db.items.add({ ...fixture(), content: Array.from({ length: 38 }, (_, i) => `Paragraph ${i}: useful source content.`).join('\n\n') });
    for (let i = 0; i < 30; i++) scheduleIndexing();
    await waitForIndexing();
    const index = await db.sourceIndexes.get('source');
    expect(index).toMatchObject({ status: 'ready', vectorCount: 39, chunkCount: 39 });
    expect(mocks.embed.mock.calls.map(([texts]) => texts.length)).toEqual([16, 16, 7]);
    expect((await getIndexOverview()).running).toBe(false);
  });

  it('resumes a partially persisted index without resending successful batches', async () => {
    await db.items.add({ ...fixture(), content: Array.from({ length: 35 }, (_, i) => `Paragraph ${i}: useful source content.`).join('\n\n') });
    mocks.embed.mockImplementationOnce(async (texts: string[]) => texts.map(() => [1, 0, 0]))
      .mockRejectedValueOnce(new Error('transient failure'));
    await run();
    expect(await db.sourceIndexes.get('source')).toMatchObject({ status: 'failed', vectorCount: 16, chunkCount: 36 });
    const firstBatch = mocks.embed.mock.calls[0]![0] as string[];
    await run();
    expect(mocks.embed).toHaveBeenCalledTimes(2);
    await configure({ embeddingApiKey: 'REPLACEMENT_SECRET' });
    await run();
    expect(await db.sourceIndexes.get('source')).toMatchObject({ status: 'ready', vectorCount: 36 });
    expect(mocks.embed.mock.calls.slice(2).flatMap(([texts]) => texts).some(text => firstBatch.includes(text))).toBe(false);
    expect(mocks.embed.mock.calls.map(([texts]) => texts.length)).toEqual([16, 16, 16, 4]);
  });

  it('keeps failed requests terminal across alarms, item edits and a second failed configuration', async () => {
    await db.items.add(fixture());
    mocks.embed.mockRejectedValue(new Error('SECRET billing failure'));
    await run();
    expect(await db.sourceIndexes.get('source')).toMatchObject({ status: 'failed', lastAttemptRevision: 0 });
    for (let i = 0; i < 4; i++) {
      await updateItem('source', { title: `Updated title ${i}`, notes: `Private note ${i}` });
      await db.items.update('source', { contentVersion: i + 2 });
      await run();
    }
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(await db.sourceIndexes.get('source')).toMatchObject({ status: 'failed', contentVersion: 5, lastAttemptRevision: 0 });
    await configure({ embeddingApiKey: 'NEW_SECRET' });
    await run();
    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect(await db.sourceIndexes.get('source')).toMatchObject({ status: 'failed', lastAttemptRevision: 1 });
    for (let i = 0; i < 4; i++) await run();
    expect(mocks.embed).toHaveBeenCalledTimes(2);
  });

  it('does not automatically retry legacy failed rows without an attempt revision', async () => {
    await db.items.add(fixture());
    await ensureContentIndex();
    await db.sourceIndexes.update('source', { status: 'failed', error: 'previous failure', lastAttemptRevision: undefined });
    await run();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(await db.sourceIndexes.get('source')).toMatchObject({ status: 'failed', lastAttemptRevision: 0 });
    await configure({ modelTimeoutSeconds: 240 });
    await run();
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect((await db.sourceIndexes.get('source'))?.status).toBe('ready');
  });

  it.each(['embeddingModel', 'embeddingEndpoint'] as const)('retries failed rows after %s changes', async field => {
    await db.items.add(fixture());
    mocks.embed.mockRejectedValueOnce(new Error('configuration failure'));
    await run();
    await configure(field === 'embeddingModel' ? { embeddingModel: 'new-model' } : { embeddingEndpoint: 'https://other.example/v1' });
    await run();
    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect((await db.sourceIndexes.get('source'))?.status).toBe('ready');
  });

  it('does not transmit source text when semantic consent is disabled', async () => {
    await configure({ semanticEnabled: false });
    await db.items.add(fixture());
    await run();
    expect(await db.sourceChunks.count()).toBeGreaterThan(0);
    expect(await db.sourceIndexes.get('source')).toMatchObject({ status: 'disabled', vectorCount: 0 });
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it('recovers stale indexing status after a terminated worker and retries sanitized failures', async () => {
    await db.items.add(fixture());
    await ensureContentIndex();
    await db.sourceIndexes.update('source', { status: 'indexing' });
    await ensureContentIndex();
    expect((await db.sourceIndexes.get('source'))?.status).toBe('pending');
    mocks.embed.mockRejectedValueOnce(new Error('SECRET endpoint response'));
    await run();
    const failed = await db.sourceIndexes.get('source');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).not.toContain('SECRET');
    expect((await getIndexOverview()).failed).toBe(1);
    await run();
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect((await db.sourceIndexes.get('source'))?.status).toBe('failed');
    await rebuildIndexes();
    await waitForIndexing();
    expect((await db.sourceIndexes.get('source'))?.status).toBe('ready');
  });

  it('cancels an active request, preserves lexical chunks and resumes pending work', async () => {
    await db.items.add(fixture());
    const pause = pauseEmbedding();
    scheduleIndexing();
    await pause.started;
    cancelIndexing();
    await waitForIndexing();
    expect(await db.chunkVectors.count()).toBe(0);
    expect(await db.sourceChunks.count()).toBeGreaterThan(0);
    expect((await db.sourceIndexes.get('source'))?.status).toBe('pending');
    await run();
    expect((await db.sourceIndexes.get('source'))?.status).toBe('ready');
  });

  it.each(['content', 'title', 'delete', 'blocked', 'private', 'unverified', 'consent', 'model', 'endpoint', 'token'] as const)
    ('rejects stale request results after %s changes', async change => {
      const item = fixture();
      if (change === 'private' || change === 'unverified') {
        item.source = 'github'; item.url = 'https://github.com/team/repo'; item.normalizedUrl = item.url;
        item.githubVisibility = 'public';
      }
      await db.items.add(item);
      const pause = pauseEmbedding();
      scheduleIndexing();
      await pause.started;
      if (change === 'content') await db.items.update(item.id, { content: 'New source body', contentVersion: 2 });
      if (change === 'title') await updateItem(item.id, { title: 'Changed title' });
      if (change === 'delete') await deleteItem(item.id);
      if (change === 'blocked') await configure({ blockedDomains: ['example.com'] });
      if (change === 'private') await db.items.update(item.id, { githubVisibility: 'private' });
      if (change === 'unverified') await db.items.update(item.id, { githubVisibility: undefined });
      if (change === 'consent') await configure({ semanticEnabled: false });
      if (change === 'model') await configure({ embeddingModel: 'new-model' });
      if (change === 'endpoint') await configure({ embeddingEndpoint: 'https://other.example/v1' });
      if (change === 'token') await configure({ embeddingApiKey: 'NEW_SECRET' });
      pause.release();
      await waitForIndexing();
      expect(await db.chunkVectors.count()).toBe(0);
      const index = await db.sourceIndexes.get(item.id);
      if (change === 'delete') expect(index).toBeUndefined();
      else if (['blocked', 'private', 'unverified'].includes(change)) expect(index?.status).toBe('excluded');
      else if (change === 'consent') expect(index?.status).toBe('disabled');
      else {
        expect(index?.status).toBe('pending');
        expect(index?.sourceHash).toBe(sourceHash((await db.items.get(item.id))!));
      }
    });

  it('reuses cached vectors after token rotation but rebuilds them for endpoint or model changes', async () => {
    await db.items.add(fixture());
    await run();
    const oldKey = embeddingKey(await getSettings());
    const oldVectors = await db.chunkVectors.toArray();
    const chunks = await db.sourceChunks.toArray();
    await configure({ embeddingApiKey: 'NEW_SECRET' });
    await run();
    expect(await db.chunkVectors.toArray()).toEqual(oldVectors);
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    await configure({ embeddingModel: 'another-model' });
    await run();
    const newKey = embeddingKey(await getSettings());
    expect(newKey).not.toBe(oldKey);
    expect(await db.chunkVectors.where('embeddingKey').equals(oldKey).count()).toBe(0);
    expect((await db.chunkVectors.toArray()).every(vector => vector.id.includes(newKey) && vector.id.includes(vector.sourceHash))).toBe(true);
    expect(await db.sourceChunks.toArray()).toEqual(chunks);
    expect(mocks.embed).toHaveBeenCalledTimes(2);
  });

  it('rejects incompatible dimensions across separate items using one model key', async () => {
    await db.items.bulkAdd([fixture('one'), fixture('two')]);
    mocks.embed.mockImplementationOnce(async (texts: string[]) => texts.map(() => [1, 0]));
    await run();
    expect((await db.sourceIndexes.get('one'))?.status).toBe('ready');
    expect((await db.sourceIndexes.get('two'))?.status).toBe('failed');
    expect(await db.chunkVectors.where('itemId').equals('two').count()).toBe(0);
  });
});
