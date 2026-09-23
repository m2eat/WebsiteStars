import { describe, expect, it, vi } from 'vitest';
import MiniSearch from 'minisearch';
import { DEFAULT_SETTINGS, type Item, type Settings } from '../lib/types';
import { chunkItem, sourceHash } from '../lib/chunking';
import type { LibrarySearchInput, RetrievalIndexSnapshot } from '../lib/retrieval';

vi.mock('wxt/browser', () => ({ browser: { storage: { local: { get: vi.fn() } } } }));
import { LocalRetrievalService } from '../lib/retrieval';

function item(id: string, patch: Partial<Item>): Item {
  return {
    id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`,
    title: id, description: '', excerpt: '', content: '', truncated: false, source: 'docs',
    domain: 'example.com', author: '', publishedAt: '', tags: [], keywords: [], category: '',
    notes: '', selections: [], analysisStatus: 'disabled', createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z', contentVersion: 1, ...patch,
  };
}
const github = (language: string) => ({ owner: 'org', repo: language, language, license: '', stars: 0, topics: [], fetchedAt: '' });
const collection: Item[] = [
  item('atlas', { title: 'Atlas', content: 'Hybrid retrieval combines sparse keyword rankings and dense vectors to find documents.' }),
  item('cipher', { title: 'Cipher', content: 'Documents are protected with end-to-end encryption and customer controlled keys.' }),
  item('quill', { title: 'Quill', content: 'Collaborative editing supports simultaneous coauthoring in shared documents.' }),
  item('snapshot', { title: 'Snapshot', content: 'Backup and restore preserve historical versions of each document.' }),
  item('harbor', { title: 'Harbor', content: 'Self-hosted installations run offline without access to the internet.' }),
  item('pulse', { title: 'Pulse', content: 'Monitoring provides metrics and observability for production services.' }),
  item('polyglot', { title: 'Polyglot', content: 'Machine translation converts documents between human languages.' }),
  item('swift-parser', { title: 'TypeScript parser', content: 'A TypeScript parser reads source files.', github: github('TypeScript') }),
  item('python-data', { title: 'Python data', content: 'Python data processing handles tabular datasets.', github: github('Python') }),
  item('deep', { title: 'Long handbook', content: `${'Historical introduction and release administration. '.repeat(800)}\n# Ranking\nReranking compares retrieved candidates for relevance to the question.\n` }),
  item('go-worker', { title: 'Go worker', content: 'Go concurrency uses goroutines to schedule tasks.', github: github('Go') }),
  item('sharp', { title: 'C# workspace', content: 'C# tooling integrates with .NET applications.', github: github('C#') }),
  item('cpp', { title: 'C++ workspace', content: 'C++ tooling analyzes memory ownership.', github: github('C++') }),
  item('vector-lab', { title: 'Vector lab', content: 'Vector similarity supports semantic search.', category: 'Research' }),
  item('plain', { title: 'C workspace', content: 'C tooling uses header files.', github: github('C') }),
  item('metadata', { title: 'Encryption bookmark', tags: ['Encryption'], ai: {
    summary: 'Generated encryption feature claim', tags: [], keywords: [], category: '', stack: [], useCases: [],
    provider: 'fixture', model: 'fixture', analyzedAt: '2026-09-01T00:00:00.000Z',
  } }),
  item('note-only', { title: 'Inbox bookmark', notes: 'PRIVATE_NEEDLE confidential migration shortlist' }),
];

// This fixed concept space simulates embeddings; it measures integration, not model quality.
const concepts = [
  /retrieval|vector|知识库|语义搜索/iu,
  /encryption|加密/iu,
  /collaborative|coauthoring|synchronized writing|共同编写/iu,
  /backup|restore|recover previous revisions|恢复旧版本/iu,
  /self-hosted|offline|disconnected deployment|离线部署/iu,
  /monitoring|observability|service health|服务监控/iu,
  /translation|human languages|翻译/iu,
  /typescript|\bts\b/iu,
  /python|\bpy\b/iu,
  /reranking|候选重排/iu,
  /golang|\bgo\b/iu,
  /c#|csharp/iu,
  /c\+\+|\bcpp\b/iu,
];
function simulatedEmbedding(text: string): number[] {
  const values = concepts.map(concept => concept.test(text) ? 1 : 0);
  return [...values, values.some(Boolean) ? 0 : 1];
}
function indexed(items: Item[]): RetrievalIndexSnapshot {
  const chunks = items.flatMap(entry => chunkItem(entry));
  return {
    chunks,
    indexes: items.map(entry => ({ itemId: entry.id, sourceHash: sourceHash(entry), contentVersion: entry.contentVersion,
      updatedAt: entry.updatedAt, status: 'ready', chunkCount: chunks.filter(chunk => chunk.itemId === entry.id).length,
      contentState: entry.content ? 'body' : 'link', embeddingKey: 'simulated-concepts-v1', vectorCount: 1 })),
    vectors: chunks.map(chunk => ({ id: chunk.id, itemId: chunk.itemId, chunkId: chunk.id,
      sourceHash: chunk.sourceHash, embeddingKey: 'simulated-concepts-v1', dimensions: concepts.length + 1,
      values: simulatedEmbedding(chunk.text) })),
  };
}
function retrieval(items: Item[], semanticEnabled = false, localNotesSearch = false) {
  const settings: Settings = { ...DEFAULT_SETTINGS, queryEnabled: true, semanticEnabled, localNotesSearch };
  const snapshot = indexed(items);
  const semanticQuery = vi.fn(async (query: string) => simulatedEmbedding(query));
  return { semanticQuery, service: new LocalRetrievalService(settings, async () => undefined, {
    loadItems: async () => structuredClone(items), getItem: async id => structuredClone(items.find(entry => entry.id === id)),
    getSettings: async () => settings, loadIndex: async () => snapshot,
    embeddingKey: () => 'simulated-concepts-v1', semanticQuery,
  }) };
}

interface Holdout { name: string; input: LibrarySearchInput; relevant: string; semanticOnly?: boolean }
const holdout: Holdout[] = [
  { name: 'English literal', input: { queries: ['hybrid retrieval'] }, relevant: 'atlas' },
  { name: 'Chinese to English', input: { queries: ['知识库'] }, relevant: 'atlas', semanticOnly: true },
  { name: 'Chinese encryption', input: { queries: ['加密'] }, relevant: 'cipher', semanticOnly: true },
  { name: 'English synonym editing', input: { queries: ['synchronized writing'] }, relevant: 'quill', semanticOnly: true },
  { name: 'English synonym restore', input: { queries: ['recover previous revisions'] }, relevant: 'snapshot', semanticOnly: true },
  { name: 'English synonym hosting', input: { queries: ['disconnected deployment'] }, relevant: 'harbor', semanticOnly: true },
  { name: 'Chinese monitoring', input: { queries: ['服务监控'] }, relevant: 'pulse', semanticOnly: true },
  { name: 'Chinese translation', input: { queries: ['翻译'] }, relevant: 'polyglot', semanticOnly: true },
  { name: 'TS alias and filter', input: { queries: ['ts parser'], language: 'ts' }, relevant: 'swift-parser' },
  { name: 'Python alias', input: { queries: ['py'], language: 'py' }, relevant: 'python-data' },
  { name: 'Long source body', input: { queries: ['reranking'] }, relevant: 'deep' },
  { name: 'Chinese long source', input: { queries: ['候选重排'] }, relevant: 'deep', semanticOnly: true },
  { name: 'Go alias', input: { queries: ['golang'], language: 'golang' }, relevant: 'go-worker' },
  { name: 'C sharp alias', input: { queries: ['csharp'], language: 'csharp' }, relevant: 'sharp' },
  { name: 'C plus plus alias', input: { queries: ['cpp'], language: 'cpp' }, relevant: 'cpp' },
  { name: 'Exclusion and category', input: { queries: ['vector'], excludeIds: ['atlas'], category: 'Research' }, relevant: 'vector-lab' },
];

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
function baselineTokens(text: string): string[] {
  const input = text.normalize('NFKC').toLowerCase().trim();
  const tokens: string[] = [];
  const add = (part: string) => { for (const word of segmenter.segment(part)) if (word.isWordLike) tokens.push(word.segment); };
  let offset = 0;
  for (const match of input.matchAll(/(?:[a-z][a-z\d]*(?:\+\+|#)|[a-z\d]+(?:[._-][a-z\d]+)+)/giu)) {
    add(input.slice(offset, match.index));
    tokens.push(match[0]);
    if (!/(?:\+\+|#)$/u.test(match[0])) tokens.push(...match[0].split(/[._-]/u));
    offset = match.index! + match[0].length;
  }
  add(input.slice(offset));
  return [...new Set(tokens)];
}
// Frozen whole-document lexical baseline from the previous retrieval design.
function baseline(input: LibrarySearchInput): string[] {
  const items = collection.filter(entry => (!input.language || entry.github?.language.toLowerCase() === input.language.toLowerCase())
    && (!input.category || entry.category === input.category) && !input.excludeIds?.includes(entry.id));
  const boosts = { title: 12, repo: 12, tags: 7, keywords: 5, category: 3, summary: 5,
    useCases: 5, stack: 4, description: 3, excerpt: 2, content: 1, language: 4, source: 1 };
  const index = new MiniSearch({ fields: Object.keys(boosts), tokenize: baselineTokens, processTerm: term => term,
    searchOptions: { boost: boosts, combineWith: 'OR', prefix: term => !/(?:\+\+|#)$/u.test(term) && term.length > 1,
      fuzzy: term => /^[a-z]{5,}$/u.test(term) ? 0.15 : false } });
  index.addAll(items.map(entry => ({ ...entry, language: entry.github?.language ?? '',
    repo: entry.github ? `${entry.github.owner}/${entry.github.repo}` : '', tags: entry.tags.join(' '),
    keywords: entry.keywords.join(' '), summary: entry.ai?.summary ?? '', useCases: '', stack: '' })));
  const scores = new Map<string, number>();
  for (const query of input.queries) index.search(query).forEach((result, rank) => {
    scores.set(String(result.id), (scores.get(String(result.id)) ?? 0) + 1 / (61 + rank));
  });
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

describe('fixed retrieval holdout — simulated semantic integration only', () => {
  it('reports baseline and upgraded Recall@3 across sixteen fixed English/Chinese cases', async () => {
    let baselineHits = 0;
    let lexicalHits = 0;
    let hybridHits = 0;
    for (const scenario of holdout) {
      if (baseline(scenario.input).slice(0, 3).includes(scenario.relevant)) baselineHits++;
      const lexical = await retrieval(collection).service.search(scenario.input);
      if (lexical.items.slice(0, 3).some(entry => entry.itemId === scenario.relevant)) lexicalHits++;
      const { service, semanticQuery } = retrieval(collection, true);
      const hybrid = await service.search(scenario.input);
      const ids = hybrid.items.slice(0, 3).map(entry => entry.itemId);
      expect(ids, scenario.name).toContain(scenario.relevant);
      expect(hybrid.diagnostics?.mode, scenario.name).toBe('hybrid');
      if (scenario.semanticOnly) {
        expect(lexical.items.some(entry => entry.itemId === scenario.relevant), scenario.name).toBe(false);
        expect(hybrid.items.find(entry => entry.itemId === scenario.relevant)?.matchedBy).toContain('semantic');
        expect(semanticQuery).toHaveBeenCalledTimes(1);
      }
      if (ids.includes(scenario.relevant)) hybridHits++;
    }
    const metrics = { cases: holdout.length, baselineRecallAt3: baselineHits / holdout.length,
      upgradedLexicalRecallAt3: lexicalHits / holdout.length, simulatedHybridRecallAt3: hybridHits / holdout.length };
    console.info('SIMULATED SEMANTIC holdout; integration coverage only, not real embedding model quality:', metrics);
    expect(metrics.upgradedLexicalRecallAt3).toBeGreaterThanOrEqual(metrics.baselineRecallAt3);
    expect(metrics.simulatedHybridRecallAt3).toBeGreaterThan(metrics.upgradedLexicalRecallAt3);
  });

  it('covers note opt-in, complete small-library browsing, metadata rejection, and follow-up evidence', async () => {
    const { service } = retrieval(collection, false, true);
    expect((await service.brief()).tinyLibrary).toBe(true);
    const first = await service.browse({});
    const second = await service.browse({ offset: first.nextOffset });
    expect([...first.items, ...second.items]).toHaveLength(collection.length);
    const note = await service.search({ queries: ['PRIVATE_NEEDLE'] });
    expect(note.items.map(entry => entry.itemId)).toEqual(['note-only']);
    expect(JSON.stringify(note)).not.toContain('PRIVATE_NEEDLE');
    expect((await retrieval(collection).service.search({ queries: ['PRIVATE_NEEDLE'] })).items).toEqual([]);
    await expect(service.validate([{ itemId: 'metadata', quote: 'Encryption bookmark', reason: 'Claims encryption' }]))
      .rejects.toThrow('不能证明能力');
    await service.read({ itemId: 'deep', query: 'reranking' });
    expect(await service.validate([{ itemId: 'deep', quote: 'Reranking compares retrieved candidates', reason: '原文说明候选重排' }])).toHaveLength(1);
  });
});
