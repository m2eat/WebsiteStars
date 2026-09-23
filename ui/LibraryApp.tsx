import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, Card, Chip, Input, Tabs, TextArea, Tooltip } from '@heroui/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDownWideNarrow, BookmarkPlus, ChevronRight, FolderOpen, Library, Link2, Maximize2, MessageSquare, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, Star, X } from 'lucide-react';
import { getLocale, t } from '../lib/i18n';
import { openLibrary, openOptions, request } from '../lib/client';
import { db, displayCategory, displaySummary, displayTags } from '../lib/library';
import { searchItems } from '../lib/search';
import type { IndexOverview, SourceIndex } from '../lib/index-types';
import type { Filters, Item, Source } from '../lib/types';
import { Brand, Feedback, Field, Modal, Spinner, errorMessage, formatDate, safeUrl, useFeedback } from './components';
import { ItemDetail } from './ItemDetail';
import { Navigation, SOURCES } from './Navigation';
import { ChatPanel } from './ChatPanel';
import { SourceIndexBadges } from './IndexStatus';

const INITIAL_FILTERS: Filters = { query: '', source: 'all', tag: '', category: '', language: '', sort: 'recent' };
const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, getLocale()));

export function LibraryApp({ mode }: { mode: 'library' | 'sidepanel' }) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const snapshot = useLiveQuery(async () => ({ items: await db.items.toArray(), version: refreshVersion }), [refreshVersion]);
  const items = snapshot?.items;
  const indexes = useLiveQuery(() => db.sourceIndexes.toArray(), []);
  const indexByItem = useMemo(() => new Map(indexes?.map(index => [index.itemId, index])), [indexes]);
  const [indexRefreshing, setIndexRefreshing] = useState(false);
  const refreshing = indexRefreshing || (refreshVersion > 0 && snapshot?.version !== refreshVersion);
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [view, setView] = useState<'library' | 'chat'>('library');
  const [chatOpened, setChatOpened] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const feedback = useFeedback();
  const results = useMemo(() => items ? searchItems(items, filters) : [], [items, filters]);
  const facets = useMemo(() => ({
    tags: unique((items ?? []).flatMap(displayTags)),
    categories: unique((items ?? []).map(displayCategory)),
    languages: unique((items ?? []).map(item => item.github?.language ?? '')),
  }), [items]);
  const counts = useMemo(() => items ? {
    all: items.length, github: items.filter(item => item.source === 'github').length,
    article: items.filter(item => item.source === 'article').length, docs: items.filter(item => item.source === 'docs').length,
  } : undefined, [items]);
  const selected = items?.find(item => item.id === selectedId);
  const activeFilters = [filters.tag, filters.category, filters.language].filter(Boolean).length;
  const hasFilters = Boolean(filters.query || activeFilters || filters.source !== 'all');

  useEffect(() => {
    function handleKey(event: globalThis.KeyboardEvent) {
      if (view !== 'library' || document.querySelector('[role="dialog"]')) return;
      const target = event.target as HTMLElement;
      const editing = target.closest('input, textarea, select, [contenteditable="true"]');
      if ((event.key === '/' && !editing && !event.metaKey && !event.ctrlKey && !event.altKey) || (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey))) {
        event.preventDefault(); searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [view]);

  function changeView(next: 'library' | 'chat') {
    setView(next); if (next === 'chat') setChatOpened(true);
  }
  function changeSource(source: 'all' | Source) {
    setView('library');
    setFilters(current => ({ ...current, source, sort: source !== 'github' && current.sort === 'stars' ? 'recent' : current.sort }));
  }
  async function navigate(destination: 'library' | 'options') {
    try { await (destination === 'library' ? openLibrary() : openOptions()); }
    catch (error) { feedback.notify(errorMessage(error), 'error'); }
  }
  async function refreshLibrary() {
    if (refreshing) return;
    setRefreshVersion(version => version + 1); setIndexRefreshing(true);
    try { await request<IndexOverview>({ type: 'getIndexOverview' }); }
    catch { feedback.notify(t('本地收藏已重新读取，索引状态暂时无法更新，请稍后重试。'), 'info'); }
    finally { setIndexRefreshing(false); }
  }
  async function capture() {
    setCapturing(true); feedback.dismiss();
    try {
      const result = await request<{ item: Item; created: boolean }>({ type: 'captureTab' });
      feedback.notify(result.created ? t('当前页面已收藏。') : t('此页面已在资料库中，已保留你的笔记。'));
    } catch (error) { feedback.notify(errorMessage(error), 'error'); }
    finally { setCapturing(false); }
  }

  return <div className={`app-shell ${mode === 'sidepanel' ? 'sidepanel-mode' : ''} ${view === 'chat' ? 'chat-active' : ''}`}>
    <Navigation active={view === 'chat' ? 'chat' : filters.source} counts={counts} tags={facets.tags} selectedTag={filters.tag} onSource={changeSource} onTag={tag => { setView('library'); setFilters(current => ({ ...current, tag })); }} onChat={() => changeView('chat')} onOptions={() => void navigate('options')} />
    <main className="library-main" id="main-content">
      <header className="mobile-bar library-header"><Brand />
        <div className="library-view-switch" role="group" aria-label={t('浏览模式')}>
          <Tooltip delay={300}><Button isIconOnly size="sm" variant={view === 'library' ? 'secondary' : 'ghost'} aria-label={t('资料库')} aria-pressed={view === 'library'} onPress={() => changeView('library')}><Library size={18} aria-hidden="true" /></Button><Tooltip.Content>{t('资料库')}</Tooltip.Content></Tooltip>
          <Tooltip delay={300}><Button isIconOnly size="sm" variant={view === 'chat' ? 'secondary' : 'ghost'} aria-label={t('对话查询')} aria-pressed={view === 'chat'} onPress={() => changeView('chat')}><MessageSquare size={18} aria-hidden="true" /></Button><Tooltip.Content>{t('对话查询')}</Tooltip.Content></Tooltip>
        </div>
        <div className="mobile-actions">
          {mode === 'sidepanel' && <Button isIconOnly size="sm" variant="ghost" onPress={() => void navigate('library')} aria-label={t('在完整资料库中打开')}><Maximize2 size={18} /></Button>}
          <Button isIconOnly size="sm" variant="ghost" onPress={() => void navigate('options')} aria-label={t('打开设置与数据')}><Settings2 size={18} /></Button>
        </div>
      </header>
      <header className="page-heading">
        <div className="page-intro"><h1>{view === 'chat' ? t('对话查询') : t('我的资料库')}</h1><p className="page-description">{view === 'chat' ? t('用自然语言查找收藏，回答附上可核对的来源') : t('收藏的项目、文章与文档')}</p></div>
        {view === 'library' && <div className="heading-actions">
          <Button size="sm" variant="secondary" isDisabled={capturing} onPress={() => void capture()}>{capturing ? <Spinner label={t('收藏中…')} /> : <><BookmarkPlus size={16} aria-hidden="true" />{t('保存当前页')}</>}</Button>
          <Button size="sm" onPress={() => setAdding(true)}><Plus size={16} aria-hidden="true" />{t('添加链接')}</Button>
        </div>}
      </header>
      <Feedback notice={feedback.notice} onDismiss={feedback.dismiss} />
      <div className="library-mode-content" hidden={view !== 'library'}>
        <div className="search-row">
          <div className="search-box">
            <Search size={17} className="search-icon" aria-hidden="true" />
            <Input fullWidth ref={searchRef} type="search" aria-label={t('搜索收藏')} placeholder={t('搜索标题、标签、笔记或正文…')} value={filters.query} onChange={event => setFilters(current => ({ ...current, query: event.target.value }))} className="collection-search" />
            {filters.query ? <Button className="search-clear" isIconOnly size="sm" variant="ghost" aria-label={t('清空搜索')} onPress={() => setFilters(current => ({ ...current, query: '' }))}><X size={15} /></Button> : <kbd className="search-shortcut">/</kbd>}
          </div>
          <Button size="sm" variant={showFilters || activeFilters ? 'secondary' : 'outline'} className="filter-toggle" aria-label={t('展开筛选条件')} aria-expanded={showFilters} aria-controls="filter-controls" onPress={() => setShowFilters(value => !value)}><SlidersHorizontal size={16} aria-hidden="true" /><span>{activeFilters > 0 ? t('筛选 {count}', { count: activeFilters.toLocaleString(getLocale()) }) : t('筛选')}</span></Button>
        </div>
        <Tabs selectedKey={filters.source} onSelectionChange={key => changeSource(key as 'all' | Source)} className="collection-tabs" variant="secondary">
          <Tabs.ListContainer className="source-tab-container"><Tabs.List aria-label={t('收藏来源')}>
              {SOURCES.map(({ value, label }) => <Tabs.Tab key={value} id={value} className="source-tab">
                {value === 'all' ? t('全部') : t(label)}{counts && <span className="tab-count">{counts[value].toLocaleString(getLocale())}</span>}<Tabs.Indicator />
              </Tabs.Tab>)}
            </Tabs.List></Tabs.ListContainer>
          {showFilters && <section id="filter-controls" className="filter-controls" aria-label={t('筛选条件')}>
            <label><span>{t('标签')}</span><select aria-label={t('按标签筛选')} value={filters.tag} onChange={event => setFilters(current => ({ ...current, tag: event.target.value }))}><option value="">{t('全部标签')}</option>{facets.tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select></label>
            <label><span>{t('分类')}</span><select aria-label={t('按分类筛选')} value={filters.category} onChange={event => setFilters(current => ({ ...current, category: event.target.value }))}><option value="">{t('全部分类')}</option>{facets.categories.map(category => <option key={category} value={category}>{category}</option>)}</select></label>
            <label><span>{t('编程语言')}</span><select aria-label={t('按编程语言筛选')} value={filters.language} onChange={event => setFilters(current => ({ ...current, language: event.target.value }))}><option value="">{t('全部语言')}</option>{facets.languages.map(language => <option key={language} value={language}>{language}</option>)}</select></label>
            {hasFilters && <Button size="sm" variant="ghost" onPress={() => setFilters(INITIAL_FILTERS)}>{t('清除筛选')}</Button>}
          </section>}
          <Tabs.Panel id={filters.source} className="results" aria-busy={items === undefined}>
            <div className="results-heading"><span aria-live="polite">{items === undefined ? t('正在读取资料库') : hasFilters ? t('找到 {count} 条收藏', { count: results.length.toLocaleString(getLocale()) }) : t('{count} 条收藏', { count: items.length.toLocaleString(getLocale()) })}</span><div className="results-actions"><label className="sort-control"><ArrowDownWideNarrow size={14} aria-hidden="true" /><span className="sr-only">{t('排序方式')}</span>
              <select aria-label={t('排序方式')} value={filters.sort} onChange={event => setFilters(current => ({ ...current, sort: event.target.value as Filters['sort'] }))}>
                <option value="recent">{t('最近收藏')}</option><option value="name">{t('名称排序')}</option><option value="stars" disabled={filters.source !== 'github'}>{filters.source !== 'github' ? t('Stars 最多（仅 GitHub）') : t('Stars 最多')}</option>
              </select>
            </label><span className="refresh-status" role="status" aria-live="polite">{refreshing ? t('正在刷新…') : refreshVersion > 0 ? t('已刷新') : t('本地资料库')}</span><Button size="sm" variant="ghost" aria-label={t('刷新资料库')} isDisabled={refreshing} onPress={() => void refreshLibrary()}><RefreshCw size={14} className={refreshing ? 'spin' : undefined} aria-hidden="true" />{t('刷新')}</Button></div></div>
            <div className="results-content">{items === undefined ? <div className="loading-state"><Spinner label={t('正在读取本地收藏…')} /></div> : items.length === 0 ? <EmptyLibrary onAdd={() => setAdding(true)} onCapture={() => void capture()} capturing={capturing} /> : results.length === 0 ? <Card className="empty-state">
              <Search size={26} aria-hidden="true" /><h2>{t('暂时没有找到')}</h2><p>{t('尝试其他关键词，或清除筛选条件。')}</p><Button size="sm" variant="secondary" onPress={() => setFilters(INITIAL_FILTERS)}>{t('清除搜索与筛选')}</Button>
            </Card> : <ul className="item-list">{results.map(item => <li key={item.id}><ItemRow item={item} index={indexByItem.get(item.id)} indexesLoading={indexes === undefined} onSelect={() => setSelectedId(item.id)} /></li>)}</ul>}</div>
          </Tabs.Panel>
        </Tabs>
        <footer className="library-footer"><span>{t('共 {count} 条收藏', { count: items?.length.toLocaleString(getLocale()) ?? '—' })}</span><span>{t('按 {key} 搜索', { key: '{key}' }).split('{key}').map((part, index) => index === 0 ? part : <Fragment key={index}><kbd>/</kbd>{part}</Fragment>)}</span></footer>
      </div>
      {chatOpened && <div className="chat-mode-content" hidden={view !== 'chat'}><ChatPanel onSelect={setSelectedId} /></div>}
    </main>
    {adding && <AddLink onClose={() => setAdding(false)} onSaved={result => { setAdding(false); feedback.notify(result.created ? t('链接已添加到资料库。') : t('链接已存在，未重复添加。')); setSelectedId(result.item.id); }} />}
    {selected && <ItemDetail key={selected.id} item={selected} onClose={() => setSelectedId(null)} onDeleted={() => { setSelectedId(null); feedback.notify(t('已从资料库删除。')); }} />}
  </div>;
}

function ItemRow({ item, index, indexesLoading, onSelect }: { item: Item; index?: SourceIndex; indexesLoading: boolean; onSelect: () => void }) {
  const SourceIcon = SOURCES.find(source => source.value === item.source)!.icon;
  const tags = displayTags(item);
  const summary = displaySummary(item);
  return <Button variant="ghost" className="collection-row" onPress={onSelect} aria-label={t('查看详情：{title}', { title: item.title || item.url })}>
    <span className="source-icon"><SourceIcon size={18} strokeWidth={1.7} aria-hidden="true" /></span>
    <span className="item-content">
      <span className="item-title" title={item.title || item.url}>{item.title || item.url}</span>
      <span className="item-domain">{item.github ? `${item.github.owner}/${item.github.repo}` : item.domain}{displayCategory(item) && <><span className="separator">·</span>{displayCategory(item)}</>}</span>
      {summary && <span className="item-summary">{summary}</span>}
      <SourceIndexBadges item={item} index={index} loading={indexesLoading} />
      <span className="item-bottom">
        {tags.length > 0 && <span className="item-tags">{tags.slice(0, 3).map(tag => <Chip size="sm" variant="soft" key={tag} title={tag}>{tag}</Chip>)}{tags.length > 3 && <Chip size="sm" variant="soft">+{(tags.length - 3).toLocaleString(getLocale())}</Chip>}</span>}
        <span className="item-metadata">{item.github?.language && <span>{item.github.language}</span>}{item.github && <span><Star size={12} aria-hidden="true" />{new Intl.NumberFormat(getLocale(), { notation: 'compact' }).format(item.github.stars)}</span>}<span>{formatDate(item.createdAt)}</span></span>
      </span>
      {['pending', 'running', 'failed'].includes(item.analysisStatus) && <span className={`analysis-mini ${item.analysisStatus}`}>{item.analysisStatus === 'failed' ? t('分析未完成 · 收藏已保留') : item.analysisStatus === 'running' ? t('正在分析') : t('等待分析')}</span>}
    </span>
    <ChevronRight className="row-chevron" size={16} aria-hidden="true" />
  </Button>;
}

function EmptyLibrary({ onAdd, onCapture, capturing }: { onAdd: () => void; onCapture: () => void; capturing: boolean }) {
  return <Card className="empty-state">
    <FolderOpen size={30} strokeWidth={1.5} aria-hidden="true" />
    <Card.Header><Card.Title>{t('还没有收藏')}</Card.Title><Card.Description>{t('添加链接，或保存当前浏览的页面。')}</Card.Description></Card.Header>
    <Card.Footer className="empty-actions"><Button size="sm" onPress={onAdd}><Plus size={16} aria-hidden="true" />{t('添加第一个链接')}</Button><Button size="sm" variant="secondary" isDisabled={capturing} onPress={onCapture}>{t('保存当前页面')}</Button></Card.Footer>
  </Card>;
}

function AddLink({ onClose, onSaved }: { onClose: () => void; onSaved: (result: { item: Item; created: boolean }) => void }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const feedback = useFeedback();
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; feedback.dismiss();
    const input = url.trim();
    const normalized = /^[\w.-]+\/[\w.-]+\/?$/.test(input) ? `https://github.com/${input}` : input;
    if (!safeUrl(normalized)) { feedback.notify(t('请输入完整的 http(s) 链接，或 GitHub 的 owner/repo。'), 'error'); return; }
    setBusy(true);
    try { onSaved(await request<{ item: Item; created: boolean }>({ type: 'saveUrl', url: normalized, title: title.trim() || undefined, notes: notes || undefined })); }
    catch (error) { feedback.notify(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  }
  return <Modal title={t('添加到资料库')} onClose={onClose} busy={busy}>
    <form onSubmit={event => void submit(event)} className="form-stack">
      <Feedback notice={feedback.notice} />
      <Field label={t('链接')} hint={t('支持网页地址或 GitHub 的 owner/repo。')}><Input fullWidth disabled={busy} autoFocus required value={url} onChange={event => setUrl(event.target.value)} placeholder={t('https://… 或 owner/repo')} autoCapitalize="none" autoComplete="url" spellCheck={false} /></Field>
      <Field label={t('标题（可选）')}><Input fullWidth disabled={busy} value={title} onChange={event => setTitle(event.target.value)} placeholder={t('填写收藏标题')} /></Field>
      <Field label={t('收藏笔记（可选）')}><TextArea fullWidth disabled={busy} rows={3} value={notes} onChange={event => setNotes(event.target.value)} placeholder={t('记录收藏理由或使用场景')} /></Field>
      <p className="field-hint"><Link2 size={14} aria-hidden="true" />{t('手动添加网页会保存链接；在原网页点击悬浮收藏，或在侧栏点击“保存当前页”可提取正文。')}</p>
      <div className="modal-actions"><Button size="sm" variant="secondary" isDisabled={busy} onPress={onClose}>{t('取消')}</Button><Button size="sm" type="submit" isDisabled={busy}>{busy ? <Spinner label={t('正在收藏…')} /> : t('添加收藏')}</Button></div>
    </form>
  </Modal>;
}
