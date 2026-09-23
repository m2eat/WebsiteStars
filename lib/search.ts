import MiniSearch from 'minisearch';
import { tokenize, languageName } from './search-language';
import { displayCategory, displaySummary, displayTags } from './library';
import type { Filters, Item } from './types';

const exactTechnicalWord = /(?:\+\+|#)$/u;

interface SearchDocument {
  id: string; title: string; repo: string; tags: string; notes: string; summary: string;
  category: string; keywords: string; useCases: string; stack: string; description: string;
  excerpt: string; selections: string; content: string; url: string; source: string;
  domain: string; language: string; author: string;
}

const boosts = {
  title: 12, repo: 12, tags: 9, notes: 8, summary: 5, category: 4, keywords: 5,
  useCases: 4, stack: 4, description: 3, excerpt: 2, selections: 3, content: 1,
  url: 0.5, source: 1, domain: 1, language: 4, author: 1,
};
const fields = Object.keys(boosts) as (keyof typeof boosts)[];
interface CachedIndex {
  index: MiniSearch<SearchDocument>;
  documents: Map<string, SearchDocument>;
}
const indexes = new WeakMap<Item[], CachedIndex>();

function documentFor(item: Item): SearchDocument {
  return {
    id: item.id, title: item.title,
    repo: item.github ? `${item.github.owner}/${item.github.repo}` : '',
    tags: displayTags(item).join(' '), notes: item.notes, summary: displaySummary(item),
    category: displayCategory(item), keywords: [...item.keywords, ...(item.ai?.keywords ?? [])].join(' '),
    useCases: item.ai?.useCases.join(' ') ?? '', stack: item.ai?.stack.join(' ') ?? '',
    description: item.description, excerpt: item.excerpt, selections: item.selections.join(' '),
    content: item.content, url: item.url,
    source: `${item.source} ${{ github: '仓库', article: '文章', docs: '文档' }[item.source]}`,
    domain: item.domain, language: item.github?.language ?? '', author: item.author,
  };
}

function indexFor(items: Item[]): MiniSearch<SearchDocument> {
  let cached = indexes.get(items);
  if (!cached) {
    cached = {
      index: new MiniSearch<SearchDocument>({
        fields, tokenize, processTerm: (term) => term,
        searchOptions: {
          boost: boosts, combineWith: 'AND', fuzzy: false,
          prefix: (term) => !exactTechnicalWord.test(term) && term.length > 1,
        },
      }),
      documents: new Map(),
    };
    indexes.set(items, cached);
  }
  const present = new Set<string>();
  for (const item of items) {
    present.add(item.id);
    const document = documentFor(item);
    const previous = cached.documents.get(item.id);
    if (!previous) cached.index.add(document);
    else if (fields.some((field) => document[field] !== previous[field])) cached.index.replace(document);
    else continue;
    cached.documents.set(item.id, document);
  }
  for (const id of cached.documents.keys()) {
    if (present.has(id)) continue;
    cached.index.discard(id);
    cached.documents.delete(id);
  }
  return cached.index;
}

const collator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' });
const folded = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const same = (first: string, second: string) => folded(first) === folded(second);

function recent(first: Item, second: Item): number {
  return Date.parse(second.createdAt) - Date.parse(first.createdAt)
    || first.id.localeCompare(second.id);
}

export function searchItems(items: Item[], filters: Filters): Item[] {
  const query = filters.query.trim();
  const scores = query
    ? new Map(indexFor(items).search(query).map((result) => [String(result.id), result.score]))
    : undefined;
  const results = items.filter((item) => {
    if (scores && !scores.has(item.id)) return false;
    if (filters.source !== 'all' && item.source !== filters.source) return false;
    if (filters.tag && !displayTags(item).some((tag) => same(tag, filters.tag))) return false;
    if (filters.category && !same(displayCategory(item), filters.category)) return false;
    if (filters.language && languageName(item.github?.language ?? '') !== languageName(filters.language)) return false;
    return true;
  });
  return results.sort((first, second) => {
    if (filters.sort === 'name') return collator.compare(first.title, second.title) || recent(first, second);
    if (filters.sort === 'stars') {
      const stars = (item: Item) => item.source === 'github' ? item.github?.stars ?? -1 : -1;
      return stars(second) - stars(first) || recent(first, second);
    }
    return (scores ? scores.get(second.id)! - scores.get(first.id)! : 0) || recent(first, second);
  });
}
