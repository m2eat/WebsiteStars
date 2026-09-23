import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, saveCapture } from '../lib/library';
import { DEFAULT_SETTINGS, type Settings } from '../lib/types';
import { ensureContentIndex, scheduleIndexing, waitForIndexing, cancelIndexing } from '../lib/content-index';
import { LocalRetrievalService } from '../lib/retrieval';

const state = vi.hoisted(() => ({ settings: {} as Settings }));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: { get: vi.fn(async () => ({ settings: structuredClone(state.settings) })) } },
  permissions: { contains: vi.fn(async () => true) },
} }));
vi.mock('../lib/model-fetch', () => ({ modelFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }));

const corpus = JSON.parse(await readFile(new URL('./fixtures/retrieval-quality.json', import.meta.url), 'utf8')) as { documents: { id: string; title: string; text: string }[]; queries: { text: string; expected: string }[] };
const live = process.env.STARTS_LIVE_EMBEDDINGS === '1';
describe.skipIf(!live)('real local multilingual retrieval evaluation', () => {
  beforeEach(async () => {
    cancelIndexing(); await waitForIndexing();
    await db.items.clear(); await db.sourceChunks.clear(); await db.sourceIndexes.clear(); await db.chunkVectors.clear();
    state.settings = { ...DEFAULT_SETTINGS, queryEnabled: true, semanticEnabled: true, embeddingEndpoint: 'http://127.0.0.1:11434/v1', embeddingModel: 'bge-m3:latest' };
  });
  it('evaluates the persisted hybrid retriever with real bge-m3 vectors and fixed Chinese descriptions', async () => {
    const itemIds = new Map<string, string>();
    for (const doc of corpus.documents) {
      const { item } = await saveCapture({ url: `https://example.com/${doc.id}`, title: doc.title, description: doc.text, content: `# ${doc.title}\n\n${doc.text}`, source: 'article' });
      itemIds.set(doc.id, item.id);
    }
    await ensureContentIndex(); scheduleIndexing(); await waitForIndexing();
    expect(await db.chunkVectors.count()).toBeGreaterThanOrEqual(corpus.documents.length);
    const started = Date.now();
    const rows = [];
    for (const query of corpus.queries) {
      const retriever = new LocalRetrievalService(state.settings, async () => undefined);
      const result = await retriever.search({ queries: [query.text], question: query.text });
      const rank = result.items.findIndex(item => item.itemId === itemIds.get(query.expected)) + 1;
      rows.push({ query: query.text, expected: query.expected, rank });
    }
    const top3 = rows.filter(row => row.rank > 0 && row.rank <= 3).length;
    console.log(JSON.stringify({ model: state.settings.embeddingModel, documents: corpus.documents.length, questions: rows.length, top1: rows.filter(row => row.rank === 1).length, top3, queryElapsedMs: Date.now() - started, rows }, null, 2));
    expect(top3).toBeGreaterThanOrEqual(10);
  }, 180000);
});
