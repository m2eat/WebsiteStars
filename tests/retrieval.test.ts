import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Item, type Settings } from '../lib/types';

const storageGet = vi.hoisted(() => vi.fn<() => Promise<Record<string, unknown>>>());
vi.mock('wxt/browser', () => ({ browser: { storage: { local: { get: storageGet } } } }));
import MiniSearch from 'minisearch';
import { db } from '../lib/library';
import { embeddingKey } from '../lib/embeddings';
import { chunkItem, sourceHash } from '../lib/chunking';
import { LocalRetrievalService, RETRIEVAL_LIMITS, type RetrievalDependencies, type RetrievalIndexSnapshot } from '../lib/retrieval';

function item(id: string, patch: Partial<Item> = {}): Item {
  return {
    id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`,
    title: id, description: '', excerpt: '', content: '', truncated: false, source: 'article',
    domain: 'example.com', author: '', publishedAt: '', tags: [], keywords: [], category: '',
    notes: '', selections: [], analysisStatus: 'disabled', createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z', contentVersion: 1, ...patch,
  };
}
let items: Item[];
let settings: Settings;
let active: ReturnType<typeof vi.fn>;
function service(dependencies: Partial<RetrievalDependencies> = {}) {
  return new LocalRetrievalService(structuredClone(settings), active, {
    loadItems: async () => structuredClone(items),
    getItem: async id => structuredClone(items.find(entry => entry.id === id)),
    getSettings: async () => structuredClone(settings),
    ...dependencies,
  });
}
const references = (itemId: string, quote: string) => [{ itemId, quote, reason: '符合查询条件' }];
beforeEach(() => {
  items = [];
  settings = { ...DEFAULT_SETTINGS, queryEnabled: true, revision: 1 };
  active = vi.fn(async () => undefined);
});

describe('source-only retrieval', () => {
  it('never indexes or exposes notes, selections, and manual overrides', async () => {
    items = [item('public', {
      description: 'A local document knowledge base', notes: 'NOTESECRET', selections: ['SELECTIONSECRET'],
      summaryOverride: 'SUMMARYSECRET', tagsOverride: ['TAGSECRET'], categoryOverride: 'CATEGORYSECRET',
    })];
    const retrieval = service();
    for (const query of ['NOTESECRET', 'SELECTIONSECRET', 'SUMMARYSECRET', 'TAGSECRET', 'CATEGORYSECRET']) {
      expect((await retrieval.search({ queries: [query] })).items).toEqual([]);
    }
    const result = await retrieval.search({ queries: ['knowledge'] });
    expect(result.items.map(entry => entry.itemId)).toEqual(['public']);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|notes|selections|Override/);
    expect((await retrieval.search({ queries: ['knowledge'], tag: 'TAGSECRET' })).items).toEqual([]);
    expect(JSON.stringify(await retrieval.facets())).not.toContain('SECRET');
  });

  it('excludes blocked domains and private or unverified GitHub sources even when mislabeled', async () => {
    settings.blockedDomains = ['BLOCKED.example.'];
    items = [
      item('blocked', { url: 'https://sub.blocked.example./a', content: 'vector database' }),
      item('private', { url: 'https://github.com/org/private', githubVisibility: 'private', content: 'vector database' }),
      item('unverified', { url: 'https://github.com/org/unverified', source: 'docs', content: 'vector database' }),
      item('source-github', { source: 'github', content: 'vector database' }),
      item('private-other', { githubVisibility: 'private', content: 'vector database' }),
      item('public', { url: 'https://github.com/org/public', source: 'github', githubVisibility: 'public', content: 'vector database' }),
    ];
    const retrieval = service();
    expect((await retrieval.search({ queries: ['vector database'] })).items.map(entry => entry.itemId)).toEqual(['public']);
    expect(await retrieval.facets()).toMatchObject({ total: 1, sources: [{ value: 'github', count: 1 }] });
    await expect(retrieval.read({ itemId: 'private', query: 'vector' })).rejects.toThrow('只能读取');
  });

  it('uses Chinese segmentation, OR recall, technical token distinctions, and English typo tolerance', async () => {
    items = [
      item('zh', { title: '本地知识库和数据库检索' }),
      item('english', { title: 'TypeScript document knowledge base' }),
      item('cpp', { title: 'C++ tooling' }), item('csharp', { title: 'C# tooling' }), item('cee', { title: 'C tooling' }),
      item('node', { title: 'Node.js vector-search' }),
    ];
    const retrieval = service();
    for (const [query, expected] of [
      ['知识库 不存在术语', 'zh'], ['document doesnotexist', 'english'], ['typescrpt', 'english'],
      ['C++', 'cpp'], ['C#', 'csharp'], ['C', 'cee'], ['Ｎｏｄｅ.js', 'node'],
    ]) {
      expect((await retrieval.search({ queries: [query!] })).items.map(entry => entry.itemId)).toEqual([expected]);
    }
  });

  it('fuses independently ranked model queries and applies source filters', async () => {
    items = [
      item('both', { title: 'document knowledge search', tags: ['RAG'], source: 'docs' }),
      item('document', { title: 'document editor' }), item('knowledge', { title: 'knowledge graph' }),
    ];
    expect((await service().search({ queries: ['document', 'knowledge'] })).items[0]?.itemId).toBe('both');
    expect((await service().search({ queries: ['document', 'knowledge'], source: 'docs', tag: 'rag', after: '2026-08-01', before: '2026-10-01' })).items.map(entry => entry.itemId)).toEqual(['both']);
    await expect(service().search({ queries: ['x'], after: 'invalid' })).rejects.toThrow('日期');
    await expect(service().search({ queries: ['x'], after: '2026-10-01', before: '2026-08-01' })).rejects.toThrow('开始日期');
  });
});

describe('evidence scope and freshness', () => {
  it('resolves returned evidence IDs to original text without asking the model to copy it', async () => {
    items = [item('one', { title: 'Agent UI', description: 'Components for agent interfaces.', content: 'Build streaming chat interfaces.' }), item('two', { content: 'Unrelated source.' })];
    const retrieval = service();
    const overview = await retrieval.browse();
    const brief = overview.items.find(entry => entry.itemId === 'one')!;
    const citation = { itemId: 'one', evidenceId: brief.descriptionId!, reason: '支持 Agent 界面' };
    expect(brief.descriptionId).toBeTruthy();
    expect(await retrieval.validate([citation])).toMatchObject([{ quote: 'Components for agent interfaces.', kind: 'capability' }]);
    await expect(retrieval.validate([{ ...citation, itemId: 'two' }])).rejects.toThrow('引用校验');
    await expect(retrieval.validate([{ ...citation, quote: 'Translated or invented claim' }])).rejects.toThrow('引用校验');
    await expect(retrieval.validate([{ ...citation, evidenceId: brief.titleId, kind: 'capability' }])).rejects.toThrow('引用校验');
    expect(await retrieval.validate([{ ...citation, evidenceId: brief.titleId, kind: 'identity' }])).toMatchObject([{ quote: 'Agent UI', kind: 'identity' }]);
    const read = await retrieval.read({ itemId: 'one', query: 'streaming' });
    expect(read.item.snippetIds).toHaveLength(read.item.snippets.length);
    expect(await retrieval.validate([{ ...citation, evidenceId: read.item.snippetIds![0] }])).toMatchObject([{ quote: read.item.snippets[0] }]);
    items[0] = { ...items[0]!, content: 'Updated source', contentVersion: 2 };
    await expect(retrieval.validate([citation])).rejects.toThrow(/更新/);
  });

  it('locates relevant content deep in long bodies and only validates evidence actually returned', async () => {
    items = [item('long', {
      title: 'Document project', description: 'Document project introduction',
      content: `${'Unrelated introductory material. '.repeat(1000)}Tencent supports hybrid retrieval and reranking. ${'More examples. '.repeat(150)}Unseen footer proof.`,
    })];
    const retrieval = service();
    const initial = await retrieval.search({ queries: ['document'] });
    expect(JSON.stringify(initial)).not.toContain('Tencent');
    await expect(retrieval.validate(references('long', 'Tencent supports hybrid retrieval'))).rejects.toThrow('实际返回');
    const result = await retrieval.read({ itemId: 'long', query: 'hybrid retrieval reranking' });
    expect(result.item.snippets.join(' ')).toContain('Tencent supports hybrid retrieval and reranking.');
    expect(result.item.snippets.every(text => text.length <= RETRIEVAL_LIMITS.snippet)).toBe(true);
    expect((await retrieval.validate(references('long', 'Tencent\n supports   hybrid retrieval')))[0]?.quote).toBe('Tencent supports hybrid retrieval');
    await expect(retrieval.validate(references('long', 'Unseen footer proof.'))).rejects.toThrow('实际返回');
    await expect(retrieval.validate(references('invented', 'Document'))).rejects.toThrow('引用校验');
    await expect(retrieval.validate(references('long', 'tencent supports hybrid retrieval'))).rejects.toThrow('引用校验');
  });

  it('revalidates explicit filters even when a source was exposed by history', async () => {
    items = [item('one', { description: 'source proof', source: 'article' })];
    const retrieval = service();
    await retrieval.history([{ question: 'source', answer: '', itemIds: ['one'] }]);
    await expect(retrieval.validate(references('one', 'source proof'), { source: 'github' })).rejects.toThrow('不符合');
    await expect(retrieval.validate(references('one', 'source proof'), { language: 'TypeScript' })).rejects.toThrow('不符合');
    await expect(retrieval.validate(references('one', 'source proof'), { excludeIds: ['one'] })).rejects.toThrow('不符合');
    expect(await retrieval.validate(references('one', 'source proof'), { source: 'article' })).toHaveLength(1);
  });

  it('rejects arbitrary IDs, duplicate recommendations, and private-note quotes', async () => {
    items = [item('one', { description: 'source proof', notes: 'private proof' }), item('other', { title: 'Unrelated' })];
    const retrieval = service();
    await retrieval.search({ queries: ['source'] });
    await expect(retrieval.read({ itemId: 'other', query: 'Unrelated' })).rejects.toThrow('只能读取');
    await expect(retrieval.validate(references('one', 'private proof'))).rejects.toThrow('引用校验');
    await expect(retrieval.validate([...references('one', 'source proof'), ...references('one', 'source proof')])).rejects.toThrow('重复');
  });

  it.each(['delete', 'content', 'title', 'visibility', 'blocked', 'settings', 'disabled'])(
    'invalidates previously exposed evidence after %s', async change => {
      items = [item('one', { description: 'source proof' })];
      const retrieval = service();
      await retrieval.search({ queries: ['proof'] });
      if (change === 'delete') items = [];
      if (change === 'content') items[0] = { ...items[0]!, content: 'new content', contentVersion: 2 };
      if (change === 'title') items[0] = { ...items[0]!, title: 'edited title' };
      if (change === 'visibility') items[0] = { ...items[0]!, githubVisibility: 'private' };
      if (change === 'blocked') settings.blockedDomains = ['example.com'];
      if (change === 'settings') settings = { ...settings, model: 'changed', revision: 2 };
      if (change === 'disabled') settings.queryEnabled = false;
      await expect(retrieval.validate(references('one', 'source proof'))).rejects.toThrow(/变更|已关闭|已删除|更新/);
      await expect(retrieval.assertFresh()).rejects.toThrow();
    },
  );

  it('rehydrates at most six history turns and never replays old assistant answers', async () => {
    settings.blockedDomains = ['blocked.example'];
    items = [item('current', { title: 'Current title', description: 'current source context' }),
      item('blocked', { url: 'https://blocked.example/a', title: 'BLOCKEDSECRET' })];
    const retrieval = service();
    const history = await retrieval.history(Array.from({ length: 8 }, (_, index) => ({
      question: `question ${index}`, answer: 'OLDASSISTANTSECRET', itemIds: ['deleted', 'blocked', 'current'],
    })));
    expect(history).toHaveLength(6);
    expect(history[0]?.question).toBe('question 2');
    expect(history[0]?.sources.map(source => source.itemId)).toEqual(['current']);
    expect(JSON.stringify(history)).not.toMatch(/OLDASSISTANTSECRET|BLOCKEDSECRET|deleted/);
    expect((await retrieval.validate(references('current', 'current source context')))[0]?.title).toBe('Current title');
  });

  it('preserves final result positions when a prior source is deleted, including the fourth result', async () => {
    items = ['second', 'third', 'fourth'].map(id => item(id, { description: 'source proof' }));
    const retrieval = service();
    const history = await retrieval.history([{ question: '列出结果', answer: '', itemIds: ['deleted', 'second', 'third', 'fourth'] }]);
    expect(history[0]?.selectedIds).toEqual(['', 'second', 'third', 'fourth']);
    expect(history[0]?.sources.map(source => source.itemId)).toContain('fourth');
    expect(JSON.stringify(history)).not.toContain('deleted');
    expect((await retrieval.read({ itemId: 'fourth', query: 'source' })).item.itemId).toBe('fourth');
  });

  it('rechecks candidates after the local search snapshot was taken', async () => {
    items = [item('one', { description: 'source proof' })];
    const retrieval = new LocalRetrievalService(settings, active, {
      getSettings: async () => settings,
      loadItems: async () => { const snapshot = structuredClone(items); items = []; return snapshot; },
      getItem: async id => items.find(entry => entry.id === id),
    });
    expect((await retrieval.search({ queries: ['proof'] })).items).toEqual([]);
  });
});

describe('catalog and source evidence', () => {
  it('paginates the complete metadata catalog without the twenty evidence-candidate cap', async () => {
    items = Array.from({ length: 25 }, (_, index) => item(`catalog-${String(index).padStart(2, '0')}`, { content: 'body evidence' }));
    const retrieval = service();
    expect(await retrieval.brief()).toEqual({ total: 25, tinyLibrary: false, withBody: 25 });
    const first = await retrieval.browse({ limit: 50 });
    expect(first.items).toHaveLength(12);
    expect(first.nextOffset).toBe(12);
    const second = await retrieval.browse({ offset: first.nextOffset });
    const third = await retrieval.browse({ offset: second.nextOffset });
    expect([...first.items, ...second.items, ...third.items]).toHaveLength(25);
    expect(third.nextOffset).toBeUndefined();
    expect(first.items.every(entry => entry.evidenceKind === 'metadata' && entry.hasBody && !entry.snippets.length)).toBe(true);
    await expect(retrieval.validate(references(first.items[0]!.itemId, 'body evidence'))).rejects.toThrow('实际返回');
    expect((await retrieval.read({ itemId: first.items[0]!.itemId, query: 'evidence' })).item.evidenceKind).toBe('body');
    await expect(retrieval.browse({ offset: -1 })).rejects.toThrow('分页');
  });

  it('allows identity citations for titles but rejects title and generated-metadata capability claims', async () => {
    items = [item('metadata', { title: 'Offline encryption', tags: ['encryption'], ai: {
      summary: 'AI says it supports encryption', tags: ['security'], keywords: [], category: 'Privacy',
      stack: [], useCases: [], provider: 'test', model: 'test', analyzedAt: '2026-09-01T00:00:00.000Z',
    } })];
    const retrieval = service();
    const result = await retrieval.search({ queries: ['encryption'] });
    expect(result.items[0]).toMatchObject({ evidenceKind: 'metadata', snippets: [], hasBody: false });
    await expect(retrieval.validate(references('metadata', 'Offline encryption'))).rejects.toThrow('不能证明能力');
    await expect(retrieval.validate(references('metadata', 'supports encryption'))).rejects.toThrow('实际返回');
    expect(await retrieval.validate([{ itemId: 'metadata', quote: 'Offline encryption', reason: '仅标识收藏', kind: 'identity' }])).toHaveLength(1);
  });

  it('returns up to three distinct relevant sections with a total text budget', async () => {
    items = [item('sections', { title: 'Engine', content: '# Retrieval\nHybrid retrieval joins rankings.\n\n'
      + '# Encryption\nEncryption protects documents.\n\n# Export\nExport saves documents offline.\n\n'
      + '# Irrelevant\nBananas grow on plants.' })];
    const retrieval = service();
    const initial = (await retrieval.search({ queries: ['retrieval encryption export'] })).items[0]!;
    expect(initial.sections).toHaveLength(3);
    expect(new Set(initial.sections!.map(section => section.heading)).size).toBe(3);
    expect(initial.snippets.join('').length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.searchSnippet);
    expect(initial.snippets.join(' ')).not.toContain('Bananas');
    const read = (await retrieval.read({ itemId: 'sections', query: 'retrieval encryption export' })).item;
    expect(read.snippets.join('').length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.snippet);
    expect(read.evidenceKind).toBe('body');
  });

  it('keeps body evidence available for a follow-up through browse, read, and restricted reranking', async () => {
    items = [item('first', { content: 'Keyword retrieval only.' }), item('second', { content: 'Hybrid retrieval supports reranking.' })];
    const retrieval = service();
    await retrieval.browse({});
    const reranked = await retrieval.rerank({ query: 'hybrid reranking', itemIds: ['first', 'second'] });
    expect(reranked.items[0]!.itemId).toBe('second');
    expect(await retrieval.validate(references('second', 'Hybrid retrieval supports reranking.'))).toHaveLength(1);
    await expect(retrieval.rerank({ query: 'x', itemIds: ['invented'] })).rejects.toThrow('只能重排');
  });
});

describe('aliases, local notes, and index reuse', () => {
  it.each([['ts', 'TypeScript'], ['js', 'JavaScript'], ['py', 'Python'], ['golang', 'Go'], ['csharp', 'C#'], ['cpp', 'C++']])(
    'normalizes %s in queries and filters in both directions', async (alias, language) => {
      const github = { owner: 'org', repo: 'repo', language, license: '', stars: 0, topics: [], fetchedAt: '' };
      items = [item('target', { title: `${language} tooling`, github })];
      expect((await service().search({ queries: [alias], language: alias })).items.map(entry => entry.itemId)).toEqual(['target']);
      items = [item('target', { title: `${alias} tooling`, github: { ...github, language: alias } })];
      expect((await service().search({ queries: [language], language })).items.map(entry => entry.itemId)).toEqual(['target']);
      expect((await service().search({ queries: [language], language: 'unknown' })).items.map(entry => entry.itemId)).toEqual(['target']);
    },
  );

  it('applies exclusion/category before candidate truncation and filters catalog pages', async () => {
    items = Array.from({ length: 40 }, (_, index) => item(`item-${index}`, { title: 'document', category: index === 39 ? 'Special' : 'General' }));
    const result = await service().search({ queries: ['document'], category: 'Special' });
    expect(result.items.map(entry => entry.itemId)).toEqual(['item-39']);
    expect((await service().search({ queries: ['document'], excludeIds: ['item-39'], category: 'Special' })).items).toEqual([]);
    const catalog = await service().browse({ excludeIds: ['item-39'], source: 'article' });
    expect(catalog.total).toBe(39);
    expect(catalog.items.some(entry => entry.itemId === 'item-39')).toBe(false);
  });

  it('recalls opted-in notes only locally without leaking private fields or allowing note citations', async () => {
    settings.localNotesSearch = true;
    settings.blockedDomains = ['blocked.example'];
    items = [item('public', { notes: 'NEEDLEPRIVATE', selections: ['SELECTIONSECRET'], summaryOverride: 'SUMMARYSECRET' }),
      item('blocked', { url: 'https://blocked.example/a', notes: 'NEEDLEPRIVATE' }),
      item('private', { githubVisibility: 'private', notes: 'NEEDLEPRIVATE' })];
    const retrieval = service();
    const result = await retrieval.search({ queries: ['NEEDLEPRIVATE'] });
    expect(result.items.map(entry => entry.itemId)).toEqual(['public']);
    expect(result.items[0]!.matchedBy).toContain('local-note');
    expect(JSON.stringify(result)).not.toMatch(/NEEDLEPRIVATE|SELECTIONSECRET|SUMMARYSECRET/);
    await expect(retrieval.validate(references('public', 'NEEDLEPRIVATE'))).rejects.toThrow('实际返回');
    const byOverride = await retrieval.search({ queries: ['SUMMARYSECRET'] });
    expect(byOverride.items.map(entry => entry.itemId)).toEqual(['public']);
    expect(JSON.stringify(byOverride)).not.toContain('SUMMARYSECRET');
    settings.localNotesSearch = false;
    await expect(retrieval.assertFresh()).rejects.toThrow('设置已变更');
    expect((await service().search({ queries: ['NEEDLEPRIVATE'] })).items).toEqual([]);
  });

  it('never reuses cached old text when a previously unexposed item is updated before browsing or history', async () => {
    items = [item('first', { content: 'alpha public source' }), item('second', { content: 'Old unsupported claim' })];
    const retrieval = service();
    await retrieval.search({ queries: ['alpha'] });
    items[1] = { ...items[1]!, content: 'New verified source', contentVersion: 2 };
    await retrieval.browse({});
    const read = await retrieval.read({ itemId: 'second', query: 'source' });
    expect(read.item.snippets.join(' ')).toContain('New verified source');
    expect(JSON.stringify(read)).not.toContain('Old unsupported claim');
    const history = await retrieval.history([{ question: 'source', answer: '', itemIds: ['second'] }]);
    expect(JSON.stringify(history)).toContain('New verified source');
    await expect(retrieval.validate(references('second', 'Old unsupported claim'))).rejects.toThrow('实际返回');
  });

  it('reuses the chunk lexical index across queries and filters, then rebuilds on unexposed source changes', async () => {
    items = [item('first', { content: 'alpha public source' }), item('second', { content: 'unrelated source' })];
    const add = vi.spyOn(MiniSearch.prototype, 'add');
    const retrieval = service();
    await retrieval.search({ queries: ['alpha'] });
    const count = add.mock.calls.length;
    await retrieval.search({ queries: ['alpha'], source: 'article' });
    expect(add.mock.calls.length).toBe(count);
    items[1] = { ...items[1]!, content: 'beta changed source', contentVersion: 2 };
    expect((await retrieval.search({ queries: ['beta'] })).items.map(entry => entry.itemId)).toEqual(['second']);
    expect(add.mock.calls.length).toBeGreaterThan(count);
  });
});

function vectorSnapshot(): RetrievalIndexSnapshot {
  const chunks = items.flatMap(entry => chunkItem(entry));
  return {
    chunks,
    indexes: items.map(entry => ({ itemId: entry.id, sourceHash: sourceHash(entry), contentVersion: entry.contentVersion,
      updatedAt: entry.updatedAt, status: 'ready', chunkCount: chunks.filter(chunk => chunk.itemId === entry.id).length,
      contentState: 'body', embeddingKey: 'fixture-model', vectorCount: 1 })),
    vectors: chunks.map(chunk => ({ id: chunk.id, itemId: chunk.itemId, chunkId: chunk.id,
      sourceHash: chunk.sourceHash, embeddingKey: 'fixture-model', dimensions: 2, values: [1, 0] })),
  };
}

describe('semantic fusion and fallback', () => {
  beforeEach(() => {
    settings.semanticEnabled = true;
    items = [item('cross-language', { content: 'Document retrieval with vector similarity.' })];
  });

  it('uses injected deterministic vectors for cross-language fusion and normalized cosine', async () => {
    const snapshot = vectorSnapshot();
    snapshot.vectors[0]!.values = [12, 0];
    const semanticQuery = vi.fn(async () => [5, 0]);
    const retrieval = service({ loadIndex: async () => snapshot, embeddingKey: () => 'fixture-model', semanticQuery });
    const result = await retrieval.search({ queries: ['知识库'], question: '中文查文档' });
    expect(result.items[0]).toMatchObject({ itemId: 'cross-language', evidenceKind: 'body', matchedBy: ['semantic'] });
    expect(result.diagnostics?.mode).toBe('hybrid');
    expect(semanticQuery).toHaveBeenCalledWith('中文查文档', expect.objectContaining({ semanticEnabled: true }), undefined);
  });

  it.each(['missing', 'hash', 'model', 'dimensions', 'zero', 'nan', 'failure'])(
    'reports an explicit lexical fallback for %s vectors', async failure => {
      const snapshot = vectorSnapshot();
      if (failure === 'missing') snapshot.vectors = [];
      if (failure === 'hash') snapshot.indexes[0]!.sourceHash = 'stale';
      if (failure === 'model') snapshot.vectors[0]!.embeddingKey = 'old-model';
      if (failure === 'dimensions') snapshot.vectors[0]!.dimensions = 3;
      if (failure === 'zero') snapshot.vectors[0]!.values = [0, 0];
      if (failure === 'nan') snapshot.vectors[0]!.values = [Number.NaN, 0];
      const semanticQuery = vi.fn(async () => { if (failure === 'failure') throw new Error('SECRET endpoint or credential'); return [1, 0]; });
      const result = await service({ loadIndex: async () => snapshot, embeddingKey: () => 'fixture-model', semanticQuery })
        .search({ queries: ['retrieval'] });
      expect(result.items.map(entry => entry.itemId)).toEqual(['cross-language']);
      expect(result.diagnostics).toMatchObject({ mode: 'fallback', warning: expect.any(String) });
      expect(JSON.stringify(result)).not.toContain('SECRET');
      if (['missing', 'hash', 'model', 'dimensions'].includes(failure)) expect(semanticQuery).not.toHaveBeenCalled();
    },
  );

  it('rejects stale source hashes even when contentVersion was not incremented', async () => {
    const snapshot = vectorSnapshot();
    items[0]!.content = 'Replacement body';
    const semanticQuery = vi.fn(async () => [1, 0]);
    const result = await service({ loadIndex: async () => snapshot, embeddingKey: () => 'fixture-model', semanticQuery })
      .search({ queries: ['知识库'] });
    expect(result.items).toEqual([]);
    expect(result.diagnostics?.mode).toBe('fallback');
    expect(semanticQuery).not.toHaveBeenCalled();
  });

  it('rechecks privacy after embedding completes and propagates cancellation', async () => {
    const snapshot = vectorSnapshot();
    const retrieval = service({ loadIndex: async () => snapshot, embeddingKey: () => 'fixture-model',
      semanticQuery: async () => { items[0]!.githubVisibility = 'private'; return [1, 0]; } });
    expect((await retrieval.search({ queries: ['知识库'] })).items).toEqual([]);
    items[0]!.githubVisibility = undefined;
    await expect(service({ loadIndex: async () => snapshot, embeddingKey: () => 'fixture-model',
      semanticQuery: async () => { throw new DOMException('Stopped', 'AbortError'); } }).search({ queries: ['知识库'] }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('loads persisted chunks and vectors through the default production dependencies', async () => {
    settings.embeddingModel = 'persisted-fixture';
    settings.embeddingEndpoint = 'https://example.com/v1';
    storageGet.mockResolvedValue({ settings });
    await db.items.clear();
    await db.items.bulkPut(items);
    try {
      const semanticQuery = vi.fn(async () => [1, 0]);
      const retrieval = new LocalRetrievalService(structuredClone(settings), active, { semanticQuery });
      const first = await retrieval.search({ queries: ['retrieval'] });
      expect(first.diagnostics?.mode).toBe('fallback');
      expect(semanticQuery).not.toHaveBeenCalled();
      const chunks = await db.sourceChunks.toArray();
      expect(chunks.length).toBeGreaterThan(0);
      await db.chunkVectors.bulkPut(chunks.map(chunk => ({ id: chunk.id, itemId: chunk.itemId,
        chunkId: chunk.id, sourceHash: chunk.sourceHash, embeddingKey: embeddingKey(settings), dimensions: 2, values: [1, 0] })));
      const second = await retrieval.search({ queries: ['知识库'] });
      expect(second.diagnostics?.mode).toBe('hybrid');
      expect(second.items[0]!.itemId).toBe('cross-language');
      expect(semanticQuery).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([db.items.clear(), db.sourceIndexes.clear(), db.sourceChunks.clear(), db.chunkVectors.clear()]);
    }
  });

  it('retains the matched deep semantic passage when reading in another language', async () => {
    items = [item('deep', { content: `${'Administrative introduction. '.repeat(500)}\n# Feature\nSpecialproof confirms archival recovery.` })];
    const snapshot = vectorSnapshot();
    snapshot.vectors.forEach(vector => {
      vector.values = snapshot.chunks.find(chunk => chunk.id === vector.chunkId)!.text.includes('Specialproof') ? [1, 0] : [0, 1];
    });
    const semanticQuery = vi.fn(async () => [1, 0]);
    const retrieval = service({ loadIndex: async () => snapshot, embeddingKey: () => 'fixture-model', semanticQuery });
    expect((await retrieval.search({ queries: ['恢复旧档案'] })).items[0]!.snippets.join(' ')).toContain('Specialproof');
    expect((await retrieval.read({ itemId: 'deep', query: '恢复旧档案' })).item.snippets.join(' ')).toContain('Specialproof');
    expect(semanticQuery).toHaveBeenCalledTimes(1);
    expect((await retrieval.read({ itemId: 'deep', query: '找回历史版本' })).item.snippets.join(' ')).toContain('Specialproof');
    expect(semanticQuery).toHaveBeenCalledTimes(2);
  });

  it('reports partial vector coverage while preserving lexical recall for unindexed items', async () => {
    const snapshot = vectorSnapshot();
    items.push(item('pending', { content: 'Unique pending feature' }));
    const result = await service({ loadIndex: async () => snapshot, embeddingKey: () => 'fixture-model',
      semanticQuery: async () => [1, 0] }).search({ queries: ['pending feature'] });
    expect(result.items.some(entry => entry.itemId === 'pending')).toBe(true);
    expect(result.diagnostics).toMatchObject({ mode: 'hybrid', warning: expect.stringContaining('部分收藏') });
  });

  it('checks changed settings immediately before a remote query and forwards its abort signal', async () => {
    const snapshot = vectorSnapshot();
    const semanticQuery = vi.fn(async () => [1, 0]);
    const controller = new AbortController();
    await service({ loadIndex: async () => snapshot, embeddingKey: () => 'fixture-model', semanticQuery, signal: controller.signal })
      .search({ queries: ['知识库'] });
    expect(semanticQuery.mock.calls[0]).toEqual(['知识库', settings, controller.signal]);
    semanticQuery.mockClear();
    const retrieval = service({ loadIndex: async () => snapshot, embeddingKey: () => 'fixture-model', semanticQuery,
      sourceHash: entry => { settings.semanticEnabled = false; return sourceHash(entry); } });
    await expect(retrieval.search({ queries: ['知识库'] })).rejects.toThrow('设置已变更');
    expect(semanticQuery).not.toHaveBeenCalled();
  });

  it('passes only the question to the embedding client even when private notes caused recall', async () => {
    settings.localNotesSearch = true;
    items[0]!.notes = 'needle NOTESECRET';
    items[0]!.summaryOverride = 'SUMMARYSECRET';
    const snapshot = vectorSnapshot();
    const semanticQuery = vi.fn(async () => [1, 0]);
    const result = await service({ loadIndex: async () => snapshot, embeddingKey: () => 'fixture-model', semanticQuery })
      .search({ queries: ['needle'] });
    expect(JSON.stringify(semanticQuery.mock.calls)).not.toMatch(/NOTESECRET|SUMMARYSECRET/);
    expect(JSON.stringify(result)).not.toMatch(/NOTESECRET|SUMMARYSECRET/);
    expect(result.items[0]!.matchedBy).toContain('local-note');
  });
});

describe('retrieval budgets', () => {
  it('stops before exposing more than twenty distinct candidates', async () => {
    items = Array.from({ length: 24 }, (_, index) => item(`item-${index}`, { title: `group${Math.floor(index / 8)} project` }));
    const retrieval = service();
    await retrieval.search({ queries: ['group0'] });
    await retrieval.search({ queries: ['group1'] });
    await expect(retrieval.search({ queries: ['group2'] })).rejects.toThrow('20 条候选');
  });

  it('enforces a cumulative serialized tool-output budget', async () => {
    const retrieval = service();
    retrieval.accountOutput('x'.repeat(RETRIEVAL_LIMITS.outputChars - 2));
    expect(() => retrieval.accountOutput({ extra: true })).toThrow('32000');
  });

  it('does not authorize evidence from a tool output rejected by the budget', async () => {
    items = [item('one', { description: 'source proof' })];
    const retrieval = service();
    retrieval.accountOutput('x'.repeat(RETRIEVAL_LIMITS.outputChars - 2));
    await expect(retrieval.search({ queries: ['proof'] })).rejects.toThrow('32000');
    await expect(retrieval.validate(references('one', 'source proof'))).rejects.toThrow('引用校验');
  });

  it('checks run cancellation during local retrieval', async () => {
    active.mockRejectedValue(new DOMException('Stopped', 'AbortError'));
    await expect(service().search({ queries: ['anything'] })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
