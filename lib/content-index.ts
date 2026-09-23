import { chunkItem, contentState, sourceHash } from './chunking';
import { embedTexts, embeddingKey } from './embeddings';
import type { ChunkVector, IndexOverview, SourceIndex } from './index-types';
import { db } from './library';
import { assertAllowed, getSettings, withCurrentSettings } from './settings';
import type { Item, Settings } from './types';
import { parseGithubRepo } from './urls';

const BATCH_SIZE = 16;
let preparing: Promise<void> | undefined;
let prepareAll = false;
const prepareIds = new Set<string>();
let running: Promise<void> | undefined;
let requested = false;
let controller: AbortController | undefined;
const activeItems = new Set<string>();
const stores = () => [db.items, db.sourceIndexes, db.sourceChunks, db.chunkVectors];

function eligible(item: Item, settings: Settings): boolean {
  if (item.githubVisibility === 'private'
    || ((item.source === 'github' || parseGithubRepo(item.url)) && item.githubVisibility !== 'public')) return false;
  try { assertAllowed(item.url, settings); return true; } catch { return false; }
}

function sameConfig(left: Settings, right: Settings): boolean {
  return right.semanticEnabled && embeddingKey(left) === embeddingKey(right)
    && left.embeddingApiKey === right.embeddingApiKey && left.revision === right.revision;
}

async function removeDerived(itemId: string): Promise<void> {
  await db.sourceChunks.where('itemId').equals(itemId).delete();
  await db.chunkVectors.where('itemId').equals(itemId).delete();
  await db.sourceIndexes.delete(itemId);
}

async function prune(): Promise<void> {
  await db.transaction('rw', stores(), async () => {
    const ids = new Set(await db.items.toCollection().primaryKeys());
    await db.sourceIndexes.filter(index => !ids.has(index.itemId)).delete();
    await db.sourceChunks.filter(chunk => !ids.has(chunk.itemId)).delete();
    const chunks = new Map<string, { itemId: string; sourceHash: string }>();
    await db.sourceChunks.each(chunk => { chunks.set(chunk.id, { itemId: chunk.itemId, sourceHash: chunk.sourceHash }); });
    await db.chunkVectors.filter(vector => {
      const chunk = chunks.get(vector.chunkId);
      return !ids.has(vector.itemId) || !chunk || chunk.itemId !== vector.itemId || chunk.sourceHash !== vector.sourceHash;
    }).delete();
  });
}

async function prepareBatch(ids: string[]): Promise<void> {
  await withCurrentSettings(settings => db.transaction('rw', stores(), async () => {
    const key = embeddingKey(settings);
    for (const id of ids) {
      const item = await db.items.get(id);
      if (!item) { await removeDerived(id); continue; }
      const hash = sourceHash(item);
      const old = await db.sourceIndexes.get(id);
      const allowed = eligible(item, settings);
      if (!allowed) {
        await db.sourceChunks.where('itemId').equals(id).delete();
        await db.chunkVectors.where('itemId').equals(id).delete();
        if (old?.status !== 'excluded' || old.sourceHash !== hash || old.contentVersion !== item.contentVersion) {
          await db.sourceIndexes.put({ itemId: id, sourceHash: hash, contentVersion: item.contentVersion,
            updatedAt: new Date().toISOString(), status: 'excluded', chunkCount: 0,
            contentState: contentState(item), vectorCount: 0 });
        }
        continue;
      }
      const changed = !old || old.sourceHash !== hash || old.status === 'excluded';
      const failedRevision = old?.lastAttemptRevision ?? settings.revision;
      const retainFailure = old?.status === 'failed' && old.embeddingKey === key && failedRevision === settings.revision;
      let index: SourceIndex;
      if (changed) {
        const chunks = chunkItem(item, hash);
        await removeDerived(id);
        if (chunks.length) await db.sourceChunks.bulkPut(chunks);
        index = { itemId: id, sourceHash: hash, contentVersion: item.contentVersion,
          updatedAt: new Date().toISOString(), chunkCount: chunks.length, contentState: contentState(item),
          status: settings.semanticEnabled ? 'pending' : 'disabled', embeddingKey: key, vectorCount: 0 };
      } else {
        index = { ...old, contentVersion: item.contentVersion };
        if (old.embeddingKey !== key) {
          await db.chunkVectors.where('itemId').equals(id).delete();
          index.embeddingKey = key;
          index.vectorCount = 0;
          delete index.error;
          index.status = settings.semanticEnabled ? 'pending' : 'disabled';
        }
        if (!settings.semanticEnabled) index.status = 'disabled';
        else if (index.status === 'disabled' || (index.status === 'indexing' && !activeItems.has(id))) {
          index.status = index.vectorCount === index.chunkCount ? 'ready' : 'pending';
          delete index.error;
        }
      }
      if (settings.semanticEnabled && retainFailure && index.chunkCount) {
        index.status = 'failed';
        index.error = old.error;
        index.lastAttemptRevision = failedRevision;
      } else if (settings.semanticEnabled && index.status === 'failed') {
        index.status = 'pending';
        delete index.error;
      }
      if (settings.semanticEnabled && !index.chunkCount) index.status = 'ready';
      if (changed || JSON.stringify(index) !== JSON.stringify(old)) {
        index.updatedAt = new Date().toISOString();
        await db.sourceIndexes.put(index);
      }
    }
  }));
}

export function ensureContentIndex(items?: Item[]): Promise<void> {
  if (items?.length) items.forEach(item => prepareIds.add(item.id));
  else prepareAll = true;
  if (!preparing) {
    preparing = (async () => {
      while (prepareAll || prepareIds.size) {
        const all = prepareAll;
        prepareAll = false;
        const idsToPrepare = [...prepareIds];
        prepareIds.clear();
        const ids = all ? await db.items.toCollection().primaryKeys() : idsToPrepare;
        await prune();
        for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
          await prepareBatch(ids.slice(offset, offset + BATCH_SIZE));
        }
      }
    })().finally(() => { preparing = undefined; });
  }
  return preparing;
}

async function processItem(itemId: string, signal: AbortSignal): Promise<void> {
  let expected: SourceIndex | undefined;
  let config: Settings | undefined;
  activeItems.add(itemId);
  try {
    const claim = await withCurrentSettings(settings => db.transaction('rw', stores(), async () => {
      signal.throwIfAborted();
      const item = await db.items.get(itemId);
      const index = await db.sourceIndexes.get(itemId);
      if (!item || !index || !settings.semanticEnabled || !eligible(item, settings)
        || index.sourceHash !== sourceHash(item) || index.embeddingKey !== embeddingKey(settings)
        || index.status !== 'pending') return undefined;
      await db.sourceIndexes.update(itemId, { status: 'indexing', error: undefined, lastAttemptRevision: settings.revision });
      return { index, settings };
    }));
    if (!claim) return;
    expected = claim.index;
    config = claim.settings;
    const chunks = await db.sourceChunks.where('itemId').equals(itemId).sortBy('position');
    const existing = new Set((await db.chunkVectors.where('itemId').equals(itemId).toArray())
      .filter(vector => vector.embeddingKey === expected!.embeddingKey && vector.sourceHash === expected!.sourceHash)
      .map(vector => vector.chunkId));
    const remaining = chunks.filter(chunk => !existing.has(chunk.id));
    for (let start = 0; start < remaining.length; start += BATCH_SIZE) {
      signal.throwIfAborted();
      const current = await getSettings();
      const item = await db.items.get(itemId);
      if (!sameConfig(config, current) || !item || !eligible(item, current) || sourceHash(item) !== expected.sourceHash) return;
      const batch = remaining.slice(start, start + BATCH_SIZE);
      const values = await embedTexts(batch.map(chunk => chunk.text), config, signal);
      const committed = await withCurrentSettings(settings => db.transaction('rw', stores(), async () => {
        signal.throwIfAborted();
        const latest = await db.items.get(itemId);
        const index = await db.sourceIndexes.get(itemId);
        if (!sameConfig(config!, settings) || !latest || !eligible(latest, settings)
          || sourceHash(latest) !== expected!.sourceHash || index?.sourceHash !== expected!.sourceHash
          || index.embeddingKey !== expected!.embeddingKey || index.status !== 'indexing') return false;
        const known = await db.chunkVectors.where('embeddingKey').equals(expected!.embeddingKey!).first();
        const dimensions = values[0]?.length;
        if (!dimensions || dimensions > 4096 || values.length !== batch.length
          || (known && known.dimensions !== dimensions)
          || values.some(vector => vector.length !== dimensions || vector.some(value => !Number.isFinite(value)))) {
          throw new Error('Invalid embedding dimensions');
        }
        const rows: ChunkVector[] = batch.map((chunk, index) => ({
          id: `${expected!.embeddingKey}:${chunk.id}`, itemId, chunkId: chunk.id,
          sourceHash: expected!.sourceHash, embeddingKey: expected!.embeddingKey!, dimensions, values: values[index]!,
        }));
        await db.chunkVectors.bulkPut(rows);
        await db.sourceIndexes.update(itemId, {
          vectorCount: await db.chunkVectors.where('itemId').equals(itemId).count(), updatedAt: new Date().toISOString(),
        });
        return true;
      }));
      if (!committed) return;
    }
    await withCurrentSettings(settings => db.transaction('rw', stores(), async () => {
      signal.throwIfAborted();
      const item = await db.items.get(itemId);
      const index = await db.sourceIndexes.get(itemId);
      if (!sameConfig(config!, settings) || !item || !eligible(item, settings) || sourceHash(item) !== expected!.sourceHash
        || index?.sourceHash !== expected!.sourceHash || index.embeddingKey !== expected!.embeddingKey) return;
      if (index.vectorCount === index.chunkCount) {
        await db.sourceIndexes.update(itemId, { status: 'ready', error: undefined, updatedAt: new Date().toISOString() });
      }
    }));
  } catch (error) {
    if (expected) {
      await db.transaction('rw', db.sourceIndexes, async () => {
        const index = await db.sourceIndexes.get(itemId);
        if (index?.sourceHash !== expected!.sourceHash || index.embeddingKey !== expected!.embeddingKey || index.status !== 'indexing') return;
        await db.sourceIndexes.update(itemId, {
          status: signal.aborted ? 'pending' : 'failed',
          error: signal.aborted ? undefined : 'Embedding 索引失败，请检查设置后重试。', updatedAt: new Date().toISOString(),
        });
      });
    }
    if (signal.aborted) throw error;
  } finally {
    activeItems.delete(itemId);
    // Reconcile deletions, source edits and revoked consent even without a scheduling event.
    await prepareBatch([itemId]);
  }
}

async function drain(signal: AbortSignal): Promise<void> {
  while (requested && !signal.aborted) {
    requested = false;
    await ensureContentIndex();
    if (!(await getSettings()).semanticEnabled) continue;
    let after: string | undefined;
    while (!signal.aborted) {
      const page: SourceIndex[] = await (after === undefined ? db.sourceIndexes.orderBy('itemId')
        : db.sourceIndexes.where('itemId').above(after)).limit(BATCH_SIZE).toArray();
      if (!page.length) break;
      after = page[page.length - 1]!.itemId;
      for (const index of page) {
        if (signal.aborted) break;
        if (index.status === 'pending') await processItem(index.itemId, signal);
      }
    }
  }
}

export function scheduleIndexing(): void {
  requested = true;
  if (running) return;
  const current = new AbortController();
  controller = current;
  running = drain(current.signal).catch(error => {
    if (!current.signal.aborted) throw error;
  }).finally(() => {
    running = undefined;
    if (controller === current) controller = undefined;
    if (requested) scheduleIndexing();
  });
  void running.catch(() => undefined);
}

export function cancelIndexing(): void {
  requested = false;
  controller?.abort(new DOMException('索引已取消。', 'AbortError'));
}

export async function waitForIndexing(): Promise<void> {
  while (running || preparing) await (running ?? preparing);
}

export async function rebuildIndexes(): Promise<void> {
  cancelIndexing();
  await db.transaction('rw', db.sourceIndexes, db.sourceChunks, db.chunkVectors, async () => {
    await db.sourceIndexes.clear();
    await db.sourceChunks.clear();
    await db.chunkVectors.clear();
  });
  scheduleIndexing();
}

export async function getIndexOverview(): Promise<IndexOverview> {
  return db.transaction('r', stores(), async () => {
    const indexes = await db.sourceIndexes.toArray();
    const total = await db.items.count();
    return {
      total, ready: indexes.filter(index => index.status === 'ready').length,
      pending: total - indexes.length + indexes.filter(index => index.status === 'pending' || index.status === 'indexing').length,
      failed: indexes.filter(index => index.status === 'failed').length,
      excluded: indexes.filter(index => index.status === 'excluded').length,
      chunks: await db.sourceChunks.count(), vectors: await db.chunkVectors.count(),
      linkOnly: indexes.filter(index => index.contentState === 'link').length, running: !!running,
    };
  });
}
