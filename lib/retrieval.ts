import MiniSearch from 'minisearch';
import { tokenize, languageName, unknownLanguage } from './search-language';
import { db } from './library';
import { chunkItem, sourceBody, sourceHash } from './chunking';
import { assertAllowed, getSettings } from './settings';
import { parseGithubRepo } from './urls';
import type { AgentHistoryTurn, ChatCitation } from './chat-types';
import type { ChunkVector, SourceChunk, SourceIndex } from './index-types';
import type { Item, Settings, Source } from './types';

export const RETRIEVAL_LIMITS = {
  candidates: 20, perSearch: 12, snippet: 1200, searchSnippet: 300,
  outputChars: 32000, history: 6, queries: 6, fusionCandidates: 32,
} as const;

export class QueryError extends Error {
  constructor(message: string) { super(message); this.name = 'QueryError'; }
}

export class CitationError extends QueryError {}

export interface LibrarySearchInput {
  queries: string[]; question?: string; source?: Source; language?: string; tag?: string;
  category?: string; excludeIds?: string[]; after?: string; before?: string;
}
export interface LibraryBrowseInput {
  source?: Source; language?: string; excludeIds?: string[]; offset?: number; limit?: number;
}
export interface SourceEvidence {
  itemId: string; title: string; url: string; source: Source; language: string;
  snippets: string[]; snippetIds?: string[]; titleId?: string; descriptionId?: string; contentVersion: number; evidenceKind: 'body' | 'description' | 'metadata';
  sections?: { heading: string; text: string }[]; matchedBy?: string[]; hasBody: boolean; description?: string;
}
export interface ResultReference {
  itemId: string; quote?: string; evidenceId?: string; reason: string; kind?: 'identity' | 'capability';
}
export interface SearchDiagnostics { mode: 'lexical' | 'hybrid' | 'fallback'; warning?: string }
export interface LibrarySearchResult { items: SourceEvidence[]; diagnostics?: SearchDiagnostics }
export interface LibraryFacets {
  total: number; sources: { value: string; count: number }[];
  languages: { value: string; count: number }[];
  tags: { value: string; count: number }[];
  categories: { value: string; count: number }[];
}
export interface LibraryBrief { total: number; tinyLibrary: boolean; withBody: number }
export interface RetrievalService {
  search(input: LibrarySearchInput): Promise<LibrarySearchResult>;
  browse(input: LibraryBrowseInput): Promise<{ items: SourceEvidence[]; total: number; nextOffset?: number }>;
  brief(query?: string): Promise<LibraryBrief>;
  rerank(input: { query: string; itemIds: string[] }): Promise<LibrarySearchResult>;
  read(input: { itemId: string; query: string }): Promise<{ item: SourceEvidence }>;
  facets(): Promise<LibraryFacets>;
  history(turns: AgentHistoryTurn[]): Promise<{ question: string; sources: SourceEvidence[]; selectedIds: string[] }[]>;
  validate(results: ResultReference[], filters?: LibraryBrowseInput): Promise<ChatCitation[]>;
  assertFresh(): Promise<void>;
  accountOutput(value: unknown): void;
}
export interface RetrievalIndexSnapshot {
  chunks: SourceChunk[]; indexes: SourceIndex[]; vectors: ChunkVector[];
}
export interface RetrievalDependencies {
  loadItems: () => Promise<Item[]>;
  getItem: (id: string) => Promise<Item | undefined>;
  getSettings: () => Promise<Settings>;
  loadIndex: (items: Item[]) => Promise<RetrievalIndexSnapshot>;
  sourceHash: (item: Item) => string | Promise<string>;
  semanticQuery: (query: string, settings: Settings, signal?: AbortSignal) => Promise<number[]>;
  embeddingKey: (settings: Settings) => string | Promise<string>;
  signal?: AbortSignal;
}

export function assertQuerySettings(expected: Settings, current: Settings): void {
  if (!current.queryEnabled) throw new QueryError('对话查询已关闭，请先在设置中启用。');
  const keys = ['revision', 'provider', 'endpoint', 'model', 'apiKey', 'accountId',
    'semanticEnabled', 'embeddingEndpoint', 'embeddingModel', 'embeddingApiKey', 'localNotesSearch'] as const;
  if (keys.some(key => current[key] !== expected[key])
    || JSON.stringify(current.blockedDomains) !== JSON.stringify(expected.blockedDomains)) {
    throw new QueryError('查询设置已变更，请重新提问。');
  }
}

export function canQueryItem(item: Item, settings: Settings): boolean {
  if (item.githubVisibility === 'private'
    || ((item.source === 'github' || parseGithubRepo(item.url)) && item.githubVisibility !== 'public')) return false;
  try { assertAllowed(item.url, settings); return true; } catch { return false; }
}

const exactTechnical = /(?:\+\+|#)$/u;
const folded = (text: string) => text.normalize('NFKC').toLowerCase().trim();
export const normalizeQuote = (text: string) => text.replace(/\s+/gu, ' ').trim();

interface SourceDocument {
  id: string; title: string; url: string; source: Source; language: string;
  repo: string; tags: string; keywords: string; category: string; summary: string;
  useCases: string; stack: string; description: string; excerpt: string; content: string;
}

// Display helpers include private overrides and must not feed retrieval evidence.
function sourceDocument(item: Item): SourceDocument {
  return {
    id: item.id, title: item.title, url: item.url, source: item.source,
    language: item.github?.language ?? '',
    repo: item.github ? `${item.github.owner}/${item.github.repo}` : '',
    tags: [...item.tags, ...(item.github?.topics ?? []), ...(item.ai?.tags ?? [])].join(' '),
    keywords: [...item.keywords, ...(item.ai?.keywords ?? [])].join(' '),
    category: item.ai?.category || item.category,
    summary: item.ai?.summary ?? '', useCases: item.ai?.useCases.join('\n') ?? '',
    stack: item.ai?.stack.join(' ') ?? '', description: item.description,
    excerpt: item.excerpt, content: item.content,
  };
}
const boosts = {
  title: 12, repo: 12, tags: 7, keywords: 5, category: 3, summary: 3,
  useCases: 3, stack: 4, description: 3, excerpt: 2, content: 2, language: 4, source: 1, heading: 3,
};
interface Passage { id: string; heading: string; text: string; kind: 'body' | 'description'; position: number }
interface LexicalDocument extends SourceDocument { itemId: string; heading: string }
interface LexicalCache {
  fingerprint: string; index: MiniSearch<LexicalDocument>; owners: Map<string, string>;
  passages: Map<string, Passage[]>; documents: Map<string, string>;
}

function splitText(text: string, prefix: string, kind: Passage['kind']): Passage[] {
  const sections = text.split(/(?=^#{1,6}\s+.+$)/mu);
  const result: Passage[] = [];
  for (const section of sections) {
    const heading = section.match(/^#{1,6}\s+(.+)$/mu)?.[1]?.trim() ?? '';
    const value = normalizeQuote(section);
    for (let start = 0; start < value.length; start += 700) {
      result.push({ id: `${prefix}:${result.length}`, heading, text: value.slice(start, start + 800), kind, position: result.length });
      if (start + 800 >= value.length) break;
    }
  }
  return result;
}

function passagesFor(item: Item, chunks: SourceChunk[] = []): Passage[] {
  const body = normalizeQuote(sourceBody(item));
  const indexed = (chunks.length ? chunks : chunkItem(item)).filter(chunk => chunk.kind === 'body' && normalizeQuote(chunk.text)
    && body.includes(normalizeQuote(chunk.text))).map(chunk => ({
    id: chunk.id, heading: body.includes(normalizeQuote(chunk.heading)) ? chunk.heading : '',
    text: normalizeQuote(chunk.text), kind: (normalizeQuote(item.content).includes(normalizeQuote(chunk.text))
      ? 'body' : 'description') as Passage['kind'], position: chunk.position,
  }));
  return [
    ...splitText(item.description, `${item.id}:description`, 'description'),
    ...indexed,
  ];
}

function coverage(text: string, query: string): number {
  const terms = tokenize(query);
  if (!terms.length) return 0;
  const tokens = new Set(tokenize(text));
  const covered = terms.filter(term => tokens.has(term)).length / terms.length;
  return covered + (folded(text).includes(folded(query)) ? 0.5 : 0);
}

function bestWindow(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const starts = new Set([0]);
  const lower = folded(text);
  for (const term of tokenize(query)) {
    let position = lower.indexOf(term);
    for (let count = 0; position >= 0 && count < 40; count++) {
      starts.add(Math.max(0, position - Math.floor(maxChars / 4)));
      position = lower.indexOf(term, position + term.length);
    }
  }
  return [...starts].map(start => text.slice(start, start + maxChars))
    .sort((a, b) => coverage(b, query) - coverage(a, query))[0]!;
}

function selectPassages(passages: Passage[], query: string, maxChars: number, semantic = new Map<string, number>()): Passage[] {
  const ranked = passages.map(passage => ({ passage, score: coverage(passage.text, query)
    + (semantic.has(passage.id) ? (semantic.get(passage.id)! + 1) / 4 : 0) }))
    .sort((a, b) => b.score - a.score || (a.passage.kind === b.passage.kind ? 0 : a.passage.kind === 'body' ? -1 : 1)
      || a.passage.position - b.passage.position);
  const selected: Passage[] = [];
  const relevant = ranked.filter(entry => entry.score > 0);
  const candidates = relevant.length ? relevant : ranked.filter(entry => entry.passage.kind === 'description').slice(0, 1);
  if (!candidates.length && ranked[0]) candidates.push(ranked[0]);
  for (const { passage } of candidates) {
    if (selected.some(previous => previous.text === passage.text
      || (previous.heading && previous.heading === passage.heading)
      || previous.text.includes(passage.text) || passage.text.includes(previous.text))) continue;
    selected.push(passage);
    if (selected.length === 3) break;
  }
  const size = Math.floor(maxChars / Math.max(1, selected.length));
  return selected.map(passage => ({ ...passage, text: bestWindow(passage.text, query, size) }));
}

function normalizedVector(values: number[]): number[] | undefined {
  if (!values.length || values.some(value => !Number.isFinite(value))) return undefined;
  const norm = Math.hypot(...values);
  return norm > 0 && Number.isFinite(norm) ? values.map(value => value / norm) : undefined;
}

interface EvidenceRecord {
  updatedAt: string; contentVersion: number; document: string; quotes: Set<string>; titles: Set<string>; references: Map<string, { quote: string; kind: 'identity' | 'capability' }>; candidate: boolean;
}
function matches(record: EvidenceRecord, item: Item): boolean {
  return record.contentVersion === item.contentVersion && record.updatedAt === item.updatedAt
    && record.document === JSON.stringify(sourceDocument(item));
}

export class LocalRetrievalService implements RetrievalService {
  private readonly evidence = new Map<string, EvidenceRecord>();
  private outputChars = 0;
  private readonly dependencies: RetrievalDependencies;
  private cache?: LexicalCache;
  private semanticPassages = new Map<string, number>();
  private semanticQuestion = '';
  private matchKinds = new Map<string, Set<string>>();

  constructor(
    private readonly settings: Settings,
    private readonly assertActive: () => Promise<void>,
    dependencies: Partial<RetrievalDependencies> = {},
  ) {
    this.dependencies = {
      loadItems: () => db.items.toArray(), getItem: id => db.items.get(id), getSettings,
      loadIndex: dependencies.loadItems ? async () => ({ chunks: [], indexes: [], vectors: [] }) : async items => {
        const { ensureContentIndex } = await import('./content-index');
        await ensureContentIndex(items);
        const ids = items.map(item => item.id);
        const [chunks, indexes, vectors] = await Promise.all([
          db.sourceChunks.where('itemId').anyOf(ids).toArray(), db.sourceIndexes.bulkGet(ids),
          this.settings.semanticEnabled ? db.chunkVectors.where('itemId').anyOf(ids).toArray() : Promise.resolve([]),
        ]);
        return { chunks, indexes: indexes.filter((entry): entry is SourceIndex => !!entry), vectors };
      },
      sourceHash,
      semanticQuery: async (query, current, signal) => (await import('./embeddings')).semanticQuery(query, current, signal),
      embeddingKey: async current => (await import('./embeddings')).embeddingKey(current),
      ...dependencies,
    };
  }

  private async checkSettings(): Promise<Settings> {
    await this.assertActive();
    if (this.dependencies.signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const current = await this.dependencies.getSettings();
    assertQuerySettings(this.settings, current);
    await this.assertActive();
    return current;
  }

  async assertFresh(): Promise<void> {
    const settings = await this.checkSettings();
    for (const [id, record] of this.evidence) {
      const item = await this.dependencies.getItem(id);
      if (!item || !canQueryItem(item, settings) || !matches(record, item)) {
        throw new QueryError('引用的收藏已删除、更新或禁止发送，请重新提问。');
      }
    }
    await this.checkSettings();
  }

  accountOutput(value: unknown): void {
    const size = JSON.stringify(value).length;
    if (this.outputChars + size > RETRIEVAL_LIMITS.outputChars) {
      throw new QueryError('查询已达到 32000 字符的工具上下文上限，请缩小问题范围。');
    }
    this.outputChars += size;
  }

  private async allowedItems(): Promise<Item[]> {
    await this.assertFresh();
    const items = await this.dependencies.loadItems();
    const settings = await this.checkSettings();
    return items.filter(item => canQueryItem(item, settings));
  }

  private async expose(
    items: Item[], query: string, maxChars: number, pending: Map<string, EvidenceRecord>, metadataOnly = false,
  ): Promise<SourceEvidence[]> {
    const settings = await this.checkSettings();
    const output: SourceEvidence[] = [];
    for (const snapshot of items) {
      const item = await this.dependencies.getItem(snapshot.id);
      if (!item || !canQueryItem(item, settings) || item.updatedAt !== snapshot.updatedAt
        || item.contentVersion !== snapshot.contentVersion
        || JSON.stringify(sourceDocument(item)) !== JSON.stringify(sourceDocument(snapshot))) continue;
      const previous = pending.get(item.id) ?? this.evidence.get(item.id);
      const candidate = !metadataOnly || !!previous?.candidate;
      const candidates = new Set([...this.evidence, ...pending].filter(([, record]) => record.candidate).map(([id]) => id));
      if (candidate) candidates.add(item.id);
      if (candidates.size > RETRIEVAL_LIMITS.candidates) {
        throw new QueryError('查询已达到 20 条候选收藏上限，请缩小问题范围。');
      }
      const document = sourceDocument(item);
      const cached = this.cache?.documents.get(item.id) === JSON.stringify(document) ? this.cache.passages.get(item.id) : undefined;
      const passages = metadataOnly ? [] : selectPassages(cached ?? passagesFor(item), query, maxChars, this.semanticPassages);
      const value: SourceEvidence = {
        itemId: item.id, title: item.title.slice(0, 300), url: item.url, source: item.source,
        language: document.language.slice(0, 100), snippets: passages.map(passage => passage.text),
        ...(metadataOnly ? { description: (item.description || item.excerpt).slice(0, 300) } : {}),
        contentVersion: item.contentVersion, hasBody: !!item.content.trim(),
        evidenceKind: passages.some(passage => passage.kind === 'body') ? 'body' : passages.length || (metadataOnly && (item.description.trim() || item.excerpt.trim())) ? 'description' : 'metadata',
        sections: passages.map(({ heading, text }) => ({ heading: heading.slice(0, 160), text })),
        matchedBy: metadataOnly ? ['catalog'] : [...(this.matchKinds.get(item.id) ?? [])],
      };
      const record: EvidenceRecord = {
        updatedAt: item.updatedAt, contentVersion: item.contentVersion,
        document: JSON.stringify(document), quotes: new Set(previous?.quotes), titles: new Set(previous?.titles), references: new Map(previous?.references), candidate,
      };
      if (value.title) record.titles.add(normalizeQuote(value.title));
      if (value.description?.trim()) record.quotes.add(normalizeQuote(value.description));
      for (const quote of value.snippets) if (quote) record.quotes.add(normalizeQuote(quote));
      const register = (text: string, kind: 'identity' | 'capability') => {
        const quote = normalizeQuote(text);
        const id = `${item.id}:e${record.references.size + 1}`;
        const previousId = [...record.references].find(([, value]) => value.quote === quote && value.kind === kind)?.[0];
        if (previousId) return previousId;
        record.references.set(id, { quote, kind });
        return id;
      };
      if (value.title) value.titleId = register(value.title, 'identity');
      if (value.description?.trim()) value.descriptionId = register(value.description, 'capability');
      value.snippetIds = value.snippets.map(quote => register(quote, 'capability'));
      pending.set(item.id, record);
      output.push(value);
    }
    await this.assertFresh();
    return output;
  }

  private async publish<T>(output: T, pending: Map<string, EvidenceRecord>): Promise<T> {
    const settings = await this.checkSettings();
    for (const [id, record] of pending) {
      const item = await this.dependencies.getItem(id);
      if (!item || !canQueryItem(item, settings) || !matches(record, item)) {
        throw new QueryError('来源收藏已删除、更新或禁止发送，请重新提问。');
      }
    }
    await this.assertFresh();
    this.accountOutput(output);
    // Evidence becomes usable only after the entire output fits its budget.
    for (const [id, record] of pending) this.evidence.set(id, record);
    return output;
  }

  private matchesFilter(item: Item, input: LibraryBrowseInput & Partial<LibrarySearchInput>): boolean {
    if (input.excludeIds?.includes(item.id)) return false;
    if (input.source && input.source !== item.source) return false;
    if (input.language && !unknownLanguage(input.language)
      && languageName(item.github?.language ?? '') !== languageName(input.language)) return false;
    if (input.tag && ![...item.tags, ...(item.github?.topics ?? []), ...(item.ai?.tags ?? [])]
      .some(tag => folded(tag) === folded(input.tag!))) return false;
    if (input.category && folded(item.ai?.category || item.category) !== folded(input.category)) return false;
    if (input.after && Date.parse(item.createdAt) < Date.parse(input.after)) return false;
    if (input.before && Date.parse(item.createdAt) > Date.parse(input.before)) return false;
    return true;
  }

  private lexicalIndex(items: Item[], chunks: SourceChunk[]): LexicalCache {
    const fingerprint = JSON.stringify([items.map(sourceDocument), chunks]);
    if (this.cache?.fingerprint === fingerprint) return this.cache;
    const index = new MiniSearch<LexicalDocument>({
      fields: Object.keys(boosts), tokenize, processTerm: term => term,
      searchOptions: {
        boost: boosts, combineWith: 'OR', prefix: term => !exactTechnical.test(term) && term.length > 1,
        fuzzy: term => /^[a-z]{5,}$/u.test(term) ? 0.15 : false,
      },
    });
    const owners = new Map<string, string>();
    const passages = new Map<string, Passage[]>();
    const documents = new Map<string, string>();
    const byItem = new Map<string, SourceChunk[]>();
    for (const chunk of chunks) byItem.set(chunk.itemId, [...(byItem.get(chunk.itemId) ?? []), chunk]);
    for (const item of items) {
      const document = sourceDocument(item);
      documents.set(item.id, JSON.stringify(document));
      const id = `${item.id}:metadata`;
      owners.set(id, item.id);
      index.add({ ...document, id, itemId: item.id, content: '', excerpt: '', description: '', heading: '' });
      const itemPassages = passagesFor(item, byItem.get(item.id));
      passages.set(item.id, itemPassages);
      for (const passage of itemPassages) {
        const passageId = `${item.id}:chunk:${passage.id}`;
        owners.set(passageId, item.id);
        index.add({ id: passageId, itemId: item.id, heading: passage.heading, content: passage.text } as LexicalDocument);
      }
    }
    this.cache = { fingerprint, index, owners, passages, documents };
    return this.cache;
  }

  private async rank(items: Item[], queries: string[], question: string, indexItems = items): Promise<{ items: Item[]; diagnostics: SearchDiagnostics }> {
    let snapshot: RetrievalIndexSnapshot = { chunks: [], indexes: [], vectors: [] };
    let indexFailed = false;
    try { snapshot = await this.dependencies.loadIndex(indexItems); } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      indexFailed = true;
    }
    await this.checkSettings();
    const cache = this.lexicalIndex(indexItems, snapshot.chunks);
    const eligible = new Set(items.map(item => item.id));
    const scores = new Map<string, number>();
    this.matchKinds = new Map();
    this.semanticPassages = new Map();
    this.semanticQuestion = question;
    const uniqueQueries = [...new Set(queries)];
    const addRanking = (ranking: string[], kind: string, weight = 1) => {
      [...new Set(ranking)].slice(0, RETRIEVAL_LIMITS.fusionCandidates).forEach((id, rank) => {
        scores.set(id, (scores.get(id) ?? 0) + weight / (60 + rank + 1));
        const kinds = this.matchKinds.get(id) ?? new Set();
        kinds.add(kind);
        this.matchKinds.set(id, kinds);
      });
    };
    for (const query of uniqueQueries) {
      addRanking(cache.index.search(query).map(result => cache.owners.get(String(result.id))!).filter(id => eligible.has(id)), 'lexical', 1 / uniqueQueries.length);
      const exact = items.filter(item => folded(item.title) === folded(query)
        || folded(item.github ? `${item.github.owner}/${item.github.repo}` : '') === folded(query));
      if (exact.length) addRanking(exact.map(item => item.id), 'title');
      if (this.settings.localNotesSearch) {
        addRanking(items.map(item => ({ id: item.id, score: coverage([item.notes, item.summaryOverride ?? '', item.categoryOverride ?? '', ...(item.tagsOverride ?? [])].join('\n'), query) }))
          .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(entry => entry.id), 'local-note', 0.75 / uniqueQueries.length);
      }
    }
    let diagnostics: SearchDiagnostics = { mode: 'lexical' };
    if (this.settings.semanticEnabled) {
      diagnostics = { mode: 'fallback', warning: '语义索引尚未就绪，已使用关键词检索。' };
      try {
        const key = await this.dependencies.embeddingKey(this.settings);
        const validChunks = new Map<string, SourceChunk>();
        const indexed = new Map(snapshot.indexes.map(entry => [entry.itemId, entry]));
        const chunksByItem = new Map<string, SourceChunk[]>();
        for (const chunk of snapshot.chunks) {
          const chunks = chunksByItem.get(chunk.itemId) ?? [];
          chunks.push(chunk);
          chunksByItem.set(chunk.itemId, chunks);
        }
        for (const item of items) {
          const entry = indexed.get(item.id);
          if (!entry || entry.contentVersion !== item.contentVersion || entry.sourceHash !== await this.dependencies.sourceHash(item)) continue;
          for (const chunk of chunksByItem.get(item.id) ?? []) {
            if (chunk.itemId === item.id && chunk.sourceHash === entry.sourceHash) validChunks.set(chunk.id, chunk);
          }
        }
        const vectors: ChunkVector[] = [];
        for (let offset = 0; offset < snapshot.vectors.length; offset++) {
          const vector = snapshot.vectors[offset]!;
          const chunk = validChunks.get(vector.chunkId);
          const values = chunk?.itemId === vector.itemId && chunk.sourceHash === vector.sourceHash
            && vector.embeddingKey === key && vector.dimensions === vector.values.length
            ? normalizedVector(vector.values) : undefined;
          if (values) vectors.push({ ...vector, values });
          if (offset % 256 === 255) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            await this.checkSettings();
          }
        }
        if (vectors.length && !indexFailed) {
          await this.checkSettings();
          const query = normalizedVector(await this.dependencies.semanticQuery(question, this.settings, this.dependencies.signal));
          await this.checkSettings();
          if (!query) throw new Error('Invalid embedding');
          const bestByItem = new Map<string, { id: string; score: number; chunkId: string }>();
          for (let offset = 0; offset < vectors.length; offset++) {
            const vector = vectors[offset]!;
            const values = vector.dimensions === query.length ? vector.values : undefined;
            if (values) {
              const score = values.reduce((sum, value, index) => sum + value * query[index]!, 0);
              if (score > (bestByItem.get(vector.itemId)?.score ?? -Infinity)) {
                bestByItem.set(vector.itemId, { id: vector.itemId, chunkId: vector.chunkId, score });
              }
              this.semanticPassages.set(vector.chunkId, score);
            }
            if (offset % 256 === 255) {
              await new Promise<void>(resolve => setTimeout(resolve, 0));
              await this.checkSettings();
            }
          }
          const ranked = [...bestByItem.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id) || a.chunkId.localeCompare(b.chunkId));
          if (!ranked.length) throw new Error('Incompatible embedding');
          addRanking(ranked.map(entry => entry.id), 'semantic');
          diagnostics = { mode: 'hybrid' };
          if (new Set(ranked.map(entry => entry.id)).size < items.length) {
            diagnostics.warning = '部分收藏尚无有效语义向量，这些收藏仍使用关键词检索。';
          }
        }
      } catch (error) {
        await this.checkSettings();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        diagnostics = { mode: 'fallback', warning: '语义检索暂不可用，已使用关键词检索。' };
      }
    }
    const relevance = (item: Item) => {
      const passages = cache.passages.get(item.id) ?? [];
      const best = Math.max(0, ...passages.map(passage => coverage(passage.text, question)));
      return best + coverage(item.title, question);
    };
    const candidates = items.filter(item => scores.has(item.id));
    const rerankedScores = new Map(candidates.map(item => [item.id, scores.get(item.id)! * (1 + 0.12 * relevance(item))]));
    const ranked = candidates.sort((a, b) => rerankedScores.get(b.id)! - rerankedScores.get(a.id)!
      || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { items: ranked, diagnostics };
  }

  async search(input: LibrarySearchInput): Promise<LibrarySearchResult> {
    const queries = input.queries.map(value => value.trim()).filter(Boolean);
    if (!queries.length || queries.length > RETRIEVAL_LIMITS.queries || queries.some(query => query.length > 200)) {
      throw new QueryError('搜索须提供 1 至 6 组关键词，每组最多 200 字符。');
    }
    for (const date of [input.after, input.before]) {
      if (date && !Number.isFinite(Date.parse(date))) throw new QueryError('搜索日期无效，请使用 ISO 日期。');
    }
    if (input.after && input.before && Date.parse(input.after) > Date.parse(input.before)) {
      throw new QueryError('搜索开始日期不能晚于结束日期。');
    }
    const all = await this.allowedItems();
    const { items, diagnostics } = await this.rank(all.filter(item => this.matchesFilter(item, input)),
      queries, input.question?.trim() || queries.join(' '), all);
    const pending = new Map<string, EvidenceRecord>();
    const result = {
      items: await this.expose(items.slice(0, RETRIEVAL_LIMITS.perSearch),
        input.question?.trim() || queries.join(' '), RETRIEVAL_LIMITS.searchSnippet, pending), diagnostics,
    };
    return this.publish(result, pending);
  }

  async browse(input: LibraryBrowseInput = {}): Promise<{ items: SourceEvidence[]; total: number; nextOffset?: number }> {
    const offset = input.offset ?? 0;
    const limit = Math.min(input.limit ?? RETRIEVAL_LIMITS.perSearch, RETRIEVAL_LIMITS.perSearch);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new QueryError('浏览分页须使用非负偏移和正整数条数。');
    }
    const items = (await this.allowedItems()).filter(item => this.matchesFilter(item, input))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const pending = new Map<string, EvidenceRecord>();
    return this.publish({
      items: await this.expose(items.slice(offset, offset + limit), '', 0, pending, true), total: items.length,
      ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}),
    }, pending);
  }

  async brief(_query?: string): Promise<LibraryBrief> {
    const items = await this.allowedItems();
    const result = { total: items.length, tinyLibrary: items.length <= RETRIEVAL_LIMITS.candidates,
      withBody: items.filter(item => item.content.trim()).length };
    this.accountOutput(result);
    return result;
  }

  async rerank(input: { query: string; itemIds: string[] }): Promise<LibrarySearchResult> {
    await this.assertFresh();
    const ids = [...new Set(input.itemIds)];
    if (ids.some(id => !this.evidence.has(id))) throw new QueryError('只能重排本次已返回的候选收藏。');
    const items = (await this.allowedItems()).filter(item => ids.includes(item.id));
    const ranked = await this.rank(items, [input.query], input.query);
    const remaining = items.filter(item => !ranked.items.some(entry => entry.id === item.id));
    const pending = new Map<string, EvidenceRecord>();
    return this.publish({ items: await this.expose([...ranked.items, ...remaining].slice(0, RETRIEVAL_LIMITS.perSearch),
      input.query, RETRIEVAL_LIMITS.searchSnippet, pending), diagnostics: ranked.diagnostics }, pending);
  }

  async read(input: { itemId: string; query: string }): Promise<{ item: SourceEvidence }> {
    await this.assertFresh();
    if (!this.evidence.has(input.itemId)) throw new QueryError('只能读取本次检索或已重新核验的历史候选收藏。');
    const item = await this.dependencies.getItem(input.itemId);
    if (!item) throw new QueryError('该收藏已删除，请重新提问。');
    if (folded(input.query) !== folded(this.semanticQuestion)) {
      this.semanticPassages.clear();
      if (this.settings.semanticEnabled) await this.rank([item], [], input.query);
    }
    const pending = new Map<string, EvidenceRecord>();
    const sources = await this.expose([item], input.query, RETRIEVAL_LIMITS.snippet, pending);
    if (!sources[0]) throw new QueryError('该收藏已更新或禁止发送，请重新提问。');
    return this.publish({ item: sources[0] }, pending);
  }

  async facets(): Promise<LibraryFacets> {
    const items = await this.allowedItems();
    const count = (values: string[]) => {
      const counts = new Map<string, number>();
      for (const value of values) if (value && value.length <= 100) counts.set(value, (counts.get(value) ?? 0) + 1);
      return [...counts].map(([value, total]) => ({ value, count: total }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, 15);
    };
    const result = {
      total: items.length, sources: count(items.map(item => item.source)),
      languages: count(items.map(item => item.github?.language ?? '')),
      tags: count(items.flatMap(item => [...new Set([...item.tags, ...(item.github?.topics ?? []), ...(item.ai?.tags ?? [])])])),
      categories: count(items.map(item => item.ai?.category || item.category)),
    };
    await this.checkSettings();
    this.accountOutput(result);
    return result;
  }

  async history(turns: AgentHistoryTurn[]): Promise<{ question: string; sources: SourceEvidence[]; selectedIds: string[] }[]> {
    const result: { question: string; sources: SourceEvidence[]; selectedIds: string[] }[] = [];
    const pending = new Map<string, EvidenceRecord>();
    for (const turn of turns.slice(-RETRIEVAL_LIMITS.history)) {
      const settings = await this.checkSettings();
      const items: Item[] = [];
      const selectedIds: string[] = [];
      for (const id of [...new Set(turn.itemIds)].slice(0, RETRIEVAL_LIMITS.candidates)) {
        const item = await this.dependencies.getItem(id);
        const allowed = item && canQueryItem(item, settings);
        selectedIds.push(allowed ? id : '');
        if (allowed) items.push(item);
      }
      const sources = [
        ...await this.expose(items.slice(0, 3), turn.question, 300, pending),
        ...await this.expose(items.slice(3), '', 0, pending, true),
      ];
      result.push({ question: turn.question.slice(0, 2000), sources, selectedIds });
    }
    return this.publish(result, pending);
  }

  async validate(results: ResultReference[], filters: LibraryBrowseInput = {}): Promise<ChatCitation[]> {
    await this.assertFresh();
    const citations: ChatCitation[] = [];
    const seen = new Set<string>();
    for (const result of results) {
      const record = this.evidence.get(result.itemId);
      const selected = result.evidenceId ? record?.references.get(result.evidenceId) : undefined;
      const kind = result.kind ?? selected?.kind ?? 'capability';
      const quote = normalizeQuote(selected?.quote ?? result.quote ?? '');
      const allowed = record ? [...record.quotes, ...(kind === 'identity' ? record.titles : [])] : [];
      if (!record || !quote || quote.length > RETRIEVAL_LIMITS.snippet
        || (result.evidenceId && (!selected || selected.kind !== kind || (result.quote && normalizeQuote(result.quote) !== quote)))
        || !allowed.some(text => text.includes(quote))) {
        throw new CitationError('引用校验失败：引用必须来自本次实际返回的来源片段；标题仅可标识收藏，不能证明能力。');
      }
      if (seen.has(result.itemId)) throw new CitationError('结果不能重复引用同一收藏。');
      const item = await this.dependencies.getItem(result.itemId);
      if (!item || !canQueryItem(item, this.settings) || !matches(record, item)) {
        throw new QueryError('引用的收藏已删除或更新，请重新提问。');
      }
      if (!this.matchesFilter(item, filters)) throw new CitationError('结果不符合用户明确的语言、来源或排除条件，请重新筛选。');
      citations.push({
        itemId: item.id, title: item.title, url: item.url, source: item.source,
        quote, reason: kind === 'identity' ? '仅用于标识收藏，不作为功能依据。' : result.reason, contentVersion: item.contentVersion, kind,
      });
      seen.add(item.id);
    }
    await this.assertFresh();
    return citations;
  }
}
