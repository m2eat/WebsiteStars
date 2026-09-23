import MiniSearch from 'minisearch';
import { describe, expect, it, vi } from 'vitest';
import { searchItems } from '../lib/search';
import type { Filters, Item } from '../lib/types';

const defaultFilters: Filters = { query: '', source: 'all', tag: '', category: '', language: '', sort: 'recent' };
function item(id: string, patch: Partial<Item> = {}): Item {
  return {
    id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`,
    title: id, description: '', excerpt: '', content: '', truncated: false, source: 'article',
    domain: 'example.com', author: '', publishedAt: '', tags: [], keywords: [], category: '',
    notes: '', selections: [], analysisStatus: 'disabled', createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z', contentVersion: 1, ...patch,
  };
}
function search(items: Item[], query: string, filters: Partial<Filters> = {}): string[] {
  return searchItems(items, { ...defaultFilters, query, ...filters }).map((entry) => entry.id);
}

describe('Chinese and technical search', () => {
  it('finds Chinese text across titles, manual notes, excerpts, and selections', () => {
    const items = [
      item('title', { title: '终端界面开发工具' }),
      item('notes', { notes: '支持中文分词和本地搜索' }),
      item('excerpt', { excerpt: '用于数据库迁移' }),
      item('selection', { selections: ['离线运行，无需联网'] }),
      item('unrelated', { title: 'Image editor' }),
    ];
    expect(search(items, '终端界面')).toEqual(['title']);
    expect(search(items, '中文 分词')).toEqual(['notes']);
    expect(search(items, '数据库')).toEqual(['excerpt']);
    expect(search(items, '离线')).toEqual(['selection']);
    expect(search(items, 'doesnotexist')).toEqual([]);
    expect(search(items, '!!!')).toEqual([]);
  });

  it('keeps C, C++, and C# distinct and preserves dotted and hyphenated technology names', () => {
    const items = [
      item('cpp', { title: 'C++ tooling' }), item('csharp', { title: 'C# tooling' }),
      item('cee', { title: 'C tooling' }), item('node', { title: 'Node.js with vector-search' }),
    ];
    expect(search(items, 'C++')).toEqual(['cpp']);
    expect(search(items, 'c#')).toEqual(['csharp']);
    expect(search(items, 'C')).toEqual(['cee']);
    expect(search(items, 'Ｎｏｄｅ.js')).toEqual(['node']);
    expect(search(items, 'node')).toEqual(['node']);
    expect(search(items, 'vector-search')).toEqual(['node']);
  });

  it('supports mixed Chinese and English, prefixes, and requires all query terms', () => {
    const items = [
      item('target', { title: 'SQLite 本地数据库', notes: '支持 TypeScript' }),
      item('partial', { title: 'SQLite database', notes: 'Python' }),
    ];
    expect(search(items, 'sqlite 本地')).toEqual(['target']);
    expect(search(items, 'typescr')).toEqual(['target']);
    expect(search(items, 'sqlite missing')).toEqual([]);
  });

  it('searches source labels, repository metadata, summaries, AI use cases, and keywords', () => {
    const items = [item('repo', {
      source: 'github', summaryOverride: '人工摘要里的编译器', keywords: ['离线'],
      github: {
        owner: 'alice', repo: 'toolkit', language: 'Rust', license: 'MIT', stars: 10,
        topics: [], fetchedAt: '2026-09-01T00:00:00.000Z',
      },
      ai: {
        summary: 'summary', category: '开发工具', tags: ['terminal'], keywords: ['索引'],
        stack: ['WebAssembly'], useCases: ['构建终端界面'], provider: 'compatible', model: 'model',
        analyzedAt: '2026-09-01T00:00:00.000Z',
      },
    })];
    for (const query of ['github', '仓库', 'alice', 'toolkit', 'rust', '编译器', '终端', '索引', '离线', 'WebAssembly']) {
      expect(search(items, query), query).toEqual(['repo']);
    }
  });

  it('ranks title and manual notes ahead of incidental body matches', () => {
    const items = [
      item('body', { content: 'SQLite' }),
      item('title', { title: 'SQLite' }),
      item('note', { notes: 'SQLite' }),
    ];
    const results = search(items, 'SQLite');
    expect(results[0]).toBe('title');
    expect(results.indexOf('note')).toBeLessThan(results.indexOf('body'));
  });
});

describe('filters and ordering', () => {
  const github = { owner: 'example', repo: 'repo', language: 'TypeScript', license: 'MIT', stars: 0, topics: [], fetchedAt: '2026-09-01T00:00:00.000Z' };

  it('combines source, effective tag, effective category, and language filters', () => {
    const items = [
      item('target', { source: 'github', tags: ['old'], tagsOverride: ['CLI'], category: 'old', categoryOverride: '工具', github }),
      item('wrong-source', { source: 'docs', tags: ['CLI'], category: '工具' }),
      item('wrong-tag', { source: 'github', tags: ['other'], category: '工具', github }),
      item('wrong-language', { source: 'github', tags: ['CLI'], category: '工具', github: { ...github, language: 'Rust' } }),
    ];
    const filters: Partial<Filters> = { source: 'github', tag: 'cli', category: '工具', language: 'typescript' };
    expect(search(items, '', filters)).toEqual(['target']);
    expect(search(items, 'CLI', filters)).toEqual(['target']);
    expect(search(items, '', { tag: 'old' })).toEqual([]);
    expect(search(items, 'old')).toEqual([]);
  });

  it('sorts empty queries by saved date and supports explicit name and stars ordering without mutating input', () => {
    const items = [
      item('zero', { title: 'Beta', source: 'github', github, createdAt: '2026-09-02T00:00:00.000Z' }),
      item('article', { title: 'Alpha', createdAt: '2026-09-03T00:00:00.000Z' }),
      item('popular', { title: 'Gamma', source: 'github', github: { ...github, stars: 50 } }),
    ];
    expect(search(items, '   ')).toEqual(['article', 'zero', 'popular']);
    expect(search(items, '', { sort: 'name' })).toEqual(['article', 'zero', 'popular']);
    expect(search(items, '', { sort: 'stars' })).toEqual(['popular', 'zero', 'article']);
    expect(search(items, 'github', { sort: 'name' })).toEqual(['zero', 'popular']);
    expect(search(items, 'github', { sort: 'stars' })).toEqual(['popular', 'zero']);
    expect(items.map((entry) => entry.id)).toEqual(['zero', 'article', 'popular']);
  });
});

describe('index cache and updates', () => {
  it('reuses indexed documents for repeated keystrokes against the same items reference', () => {
    const add = vi.spyOn(MiniSearch.prototype, 'add');
    const items = [item('one', { title: 'TypeScript' }), item('two', { title: 'SQLite' })];
    expect(search(items, 'type')).toEqual(['one']);
    const added = add.mock.calls.length;
    expect(added).toBe(2);
    expect(search(items, 'types')).toEqual(['one']);
    expect(search(items, 'sqlite')).toEqual(['two']);
    expect(add.mock.calls.length).toBe(added);
  });

  it('reflects immutable snapshots, edits, additions, and deletions immediately', () => {
    const first = item('one', { notes: 'oldword' });
    const initial = [first];
    expect(search(initial, 'oldword')).toEqual(['one']);
    const edited = [{ ...first, notes: 'newword' }];
    expect(search(edited, 'oldword')).toEqual([]);
    expect(search(edited, 'newword')).toEqual(['one']);
    expect(search([...edited, item('two', { title: 'newword' })], 'newword')).toHaveLength(2);
    expect(search([], 'newword')).toEqual([]);
    expect(search(initial, 'oldword')).toEqual(['one']);
  });

  it('also invalidates changed fields and removals when a caller reuses the array', () => {
    const items = [item('one', { notes: 'oldword', tagsOverride: ['initialtag'] })];
    expect(search(items, 'oldword')).toEqual(['one']);
    items[0]!.notes = 'newword';
    items[0]!.tagsOverride!.push('addedtag');
    expect(search(items, 'oldword')).toEqual([]);
    expect(search(items, 'newword')).toEqual(['one']);
    expect(search(items, 'addedtag')).toEqual(['one']);
    items.push(item('two', { excerpt: 'newword' }));
    expect(search(items, 'newword')).toHaveLength(2);
    items.splice(0, 1);
    expect(search(items, 'newword')).toEqual(['two']);
    items.length = 0;
    expect(search(items, 'newword')).toEqual([]);
  });
});
