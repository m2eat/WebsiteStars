import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Chip, Input, Link, Tabs, TextArea } from '@heroui/react';
import { ArrowUpRight, BookOpen, Check, Copy, ExternalLink, FileText, Github, Hash, Pencil, RefreshCw, Save, Settings2, Bot, Star, StickyNote, Trash2 } from 'lucide-react';
import { t, getLocale } from '../lib/i18n';
import { openOptions, request } from '../lib/client';
import { displayCategory, displaySummary, displayTags } from '../lib/library';
import type { Item, ItemPatch, Settings } from '../lib/types';
import { Feedback, Field, Modal, Spinner, errorMessage, formatDate, safeUrl, useFeedback } from './components';
import { Markdown } from './Markdown';
import { ItemIndexStatus } from './IndexStatus';

function aiConfigured(settings: Settings) {
  return settings.aiEnabled && Boolean(settings.apiKey.trim() && settings.model.trim() && (settings.provider === 'workers-ai' ? settings.accountId.trim() : settings.endpoint.trim()));
}
function draftFor(item: Item) {
  return { title: item.title, summary: displaySummary(item), tags: displayTags(item).join(', '), category: displayCategory(item), notes: item.notes };
}

export function ItemDetail({ item, onClose, onDeleted }: { item: Item; onClose: () => void; onDeleted: () => void }) {
  const statusLabels: Record<Item['analysisStatus'], string> = {
    disabled: t('未启用分析'), pending: t('任务等待中'), running: t('正在整理'), succeeded: t('已完成分析'), failed: t('分析失败'),
  };
  const [tab, setTab] = useState<'overview' | 'content' | 'notes'>('overview');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => draftFor(item));
  const [baseline, setBaseline] = useState(() => draftFor(item));
  const [busy, setBusy] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [discardAction, setDiscardAction] = useState<'close' | 'edit' | null>(null);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const feedback = useFeedback();
  const deleteFeedback = useFeedback();
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const sourceUrl = safeUrl(item.url);
  const readmeBaseUrl = item.github ? `https://github.com/${encodeURIComponent(item.github.owner)}/${encodeURIComponent(item.github.repo)}/blob/HEAD/` : undefined;
  const summary = displaySummary(item);
  const SourceIcon = item.source === 'github' ? Github : item.source === 'docs' ? BookOpen : FileText;

  useEffect(() => {
    let current = true;
    const readStatus = () => { void request<Settings>({ type: 'getSettings' }).then(settings => { if (current) setAiReady(aiConfigured(settings)); }).catch(() => { if (current) setAiReady(null); }); };
    readStatus(); window.addEventListener('focus', readStatus);
    return () => { current = false; window.removeEventListener('focus', readStatus); };
  }, []);

  function startEdit() { const next = draftFor(item); setDraft(next); setBaseline(next); setEditing(true); feedback.dismiss(); }
  function close() { if (editing && dirty) setDiscardAction('close'); else onClose(); }
  async function settings() {
    try { await openOptions(); }
    catch (error) { feedback.notify(errorMessage(error), 'error'); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (!draft.title.trim()) { feedback.notify(t('标题不能为空。'), 'error'); return; }
    const patch: ItemPatch = {};
    if (draft.title !== baseline.title) patch.title = draft.title.trim();
    if (draft.summary !== baseline.summary) patch.summaryOverride = draft.summary;
    if (draft.tags !== baseline.tags) patch.tagsOverride = [...new Set(draft.tags.split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
    if (draft.category !== baseline.category) patch.categoryOverride = draft.category.trim();
    if (draft.notes !== baseline.notes) patch.notes = draft.notes;
    if (!Object.keys(patch).length) { setEditing(false); return; }
    setBusy('save'); feedback.dismiss();
    try { await request<Item>({ type: 'updateItem', id: item.id, patch }); setEditing(false); feedback.notify(t('修改已保存。重新分析不会覆盖你的编辑。')); }
    catch (error) { feedback.notify(errorMessage(error), 'error'); }
    finally { setBusy(''); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(item.url); feedback.notify(t('链接已复制。')); }
    catch { feedback.notify(t('无法访问剪贴板，请从原文链接复制地址。'), 'error'); }
  }
  async function analyze() {
    setBusy('analyze'); feedback.dismiss(); setSetupNeeded(false);
    try {
      const current = await request<Settings>({ type: 'getSettings' });
      const configured = aiConfigured(current); setAiReady(configured);
      if (!configured) { setSetupNeeded(true); feedback.notify(t('先在设置中启用 AI，并填写模型连接信息。收藏和搜索无需 AI。'), 'info'); await openOptions(); return; }
      await request<void>({ type: 'analyze', id: item.id });
      feedback.notify(t('已提交分析任务，可继续浏览资料库。'));
    } catch (error) { feedback.notify(errorMessage(error), 'error'); }
    finally { setBusy(''); }
  }
  async function refresh() {
    setBusy('refresh'); feedback.dismiss();
    try { await request<void>({ type: 'refresh', id: item.id }); feedback.notify(t('仓库信息已刷新，私人笔记和人工编辑已保留。')); }
    catch (error) { feedback.notify(errorMessage(error), 'error'); }
    finally { setBusy(''); }
  }
  async function remove() {
    setBusy('delete'); deleteFeedback.dismiss();
    try { await request<void>({ type: 'deleteItem', id: item.id }); onDeleted(); }
    catch (error) { deleteFeedback.notify(errorMessage(error), 'error'); }
    finally { setBusy(''); }
  }

  return <>
    <Modal title={editing ? t('编辑收藏') : t('收藏详情')} variant="detail-drawer" onClose={close} busy={Boolean(busy)}>
      <div className="detail-body">
        <Feedback notice={feedback.notice} onDismiss={feedback.dismiss} />
        {setupNeeded && <Button size="sm" type="button" variant="secondary" className="setup-button" onPress={() => void settings()}><Settings2 size={16} aria-hidden="true" />{t('前往 AI 设置')}<ArrowUpRight size={15} aria-hidden="true" /></Button>}
        {editing ? <form className="form-stack" onSubmit={event => void save(event)}>
          <p className="field-hint">{t('你编辑的简介、标签和分类会优先展示，并在重新分析后保留。')}</p>
          <Field label={t('标题')}><Input fullWidth disabled={Boolean(busy)} autoFocus required value={draft.title} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} /></Field>
          <Field label={t('简介')}><TextArea fullWidth disabled={Boolean(busy)} rows={4} value={draft.summary} onChange={event => setDraft(current => ({ ...current, summary: event.target.value }))} placeholder={t('填写资料简介')} /></Field>
          <Field label={t('标签')} hint={t('使用逗号或换行分隔多个标签。')}><TextArea fullWidth disabled={Boolean(busy)} rows={2} value={draft.tags} onChange={event => setDraft(current => ({ ...current, tags: event.target.value }))} placeholder={t('工具, 前端, 待读')} /></Field>
          <Field label={t('分类')}><Input fullWidth disabled={Boolean(busy)} value={draft.category} onChange={event => setDraft(current => ({ ...current, category: event.target.value }))} placeholder={t('添加一个方便查找的分类')} /></Field>
          <Field label={t('私人笔记')} hint={t('笔记只保存在资料库，不发送给 AI。')}><TextArea fullWidth disabled={Boolean(busy)} rows={7} value={draft.notes} onChange={event => setDraft(current => ({ ...current, notes: event.target.value }))} placeholder={t('记录收藏理由或使用场景')} /></Field>
          <div className="modal-actions sticky-actions"><Button size="sm" type="button" variant="secondary" isDisabled={Boolean(busy)} onPress={() => dirty ? setDiscardAction('edit') : setEditing(false)}>{t('取消')}</Button><Button size="sm" type="submit" variant="primary" isDisabled={Boolean(busy)}>{busy === 'save' ? <Spinner label={t('正在保存…')} /> : <><Save size={16} aria-hidden="true" />{t('保存修改')}</>}</Button></div>
        </form> : <>
          <div className="detail-source"><span className={`source-icon source-${item.source}`}><SourceIcon size={22} aria-hidden="true" /></span><span>{item.source === 'github' ? t('GitHub 仓库') : item.source === 'docs' ? t('技术文档') : t('文章')}<small>{item.domain}</small></span><span className="detail-local"><Check size={13} aria-hidden="true" />{t('已收藏')}</span></div>
          <h2 className="detail-title">{item.title || item.url}</h2>
          <div className="detail-links">{sourceUrl && <Link href={sourceUrl} target="_blank" rel="noopener noreferrer" className="detail-original-link"><ExternalLink size={15} aria-hidden="true" />{t('打开原文')}</Link>}<Button size="sm" type="button" variant="secondary" onPress={() => void copy()}><Copy size={15} aria-hidden="true" />{t('复制链接')}</Button><Button size="sm" type="button" variant="primary" onPress={startEdit}><Pencil size={15} aria-hidden="true" />{t('编辑')}</Button></div>
          <Tabs className="detail-tabs" selectedKey={tab} onSelectionChange={key => setTab(key as typeof tab)} variant="secondary">
            <Tabs.ListContainer><Tabs.List aria-label={t('详情内容')}>{([{ value: 'overview', label: t('概览') }, { value: 'content', label: item.source === 'github' ? t('README') : t('正文') }, { value: 'notes', label: t('笔记与划词') }] as const).map(({ value, label }) => <Tabs.Tab key={value} id={value}>{label}<Tabs.Indicator /></Tabs.Tab>)}</Tabs.List></Tabs.ListContainer>
            <Tabs.Panel id={tab} className="detail-panel">
          {tab === 'overview' && <div className="detail-sections">
            <ItemIndexStatus item={item} onSettings={() => void settings()} />
            <section><h3 className="section-label"><Bot size={14} aria-hidden="true" />{item.summaryOverride !== undefined ? t('手动简介') : item.ai?.summary ? t('AI 简介') : t('来源简介')}</h3><p className={`detail-summary ${summary ? '' : 'muted'}`}>{summary || t('还没有简介。你可以手动补充，或配置 AI 后分析。')}</p>{item.ai && item.summaryOverride === undefined && <p className="field-hint">{t('由 {provider} · {model} 生成，请结合原文核实。', { provider: item.ai.provider, model: item.ai.model })}</p>}</section>
            <section><h3 className="section-label"><Hash size={14} aria-hidden="true" />{t('分类与标签')}</h3><div className="tags">{displayCategory(item) && <Chip size="sm" color="accent" variant="soft">{displayCategory(item)}</Chip>}{displayTags(item).map(tag => <Chip size="sm" variant="soft" key={tag}>{tag}</Chip>)}{!displayCategory(item) && !displayTags(item).length && <p className="muted small">{t('尚未添加分类或标签。')}</p>}</div></section>
            {item.github && <section><h3 className="section-label"><Github size={14} aria-hidden="true" />{t('仓库信息')}</h3><dl className="metadata-grid"><div><dt>{t('仓库')}</dt><dd>{item.github.owner}/{item.github.repo}</dd></div><div><dt>{t('编程语言')}</dt><dd>{item.github.language || t('未提供')}</dd></div><div><dt>{t('Stars 快照')}</dt><dd><Star size={13} aria-hidden="true" />{item.github.stars.toLocaleString(getLocale())}</dd></div><div><dt>{t('许可证')}</dt><dd>{item.github.license || t('未提供')}</dd></div></dl>{item.github.topics.length > 0 && <div className="tags github-topics">{item.github.topics.map(topic => <Chip size="sm" variant="soft" key={topic}>{topic}</Chip>)}</div>}<p className="field-hint">{t('元数据更新于 {date}，Stars 并非实时数值。', { date: formatDate(item.github.fetchedAt) })}</p></section>}
            {item.ai && (item.ai.stack.length > 0 || item.ai.useCases.length > 0 || item.ai.keywords.length > 0) && <section><h3 className="section-label">{t('AI 提取信息')}</h3>{item.ai.stack.length > 0 && <p className="small"><span className="muted">{t('技术栈：')}</span>{item.ai.stack.join(' · ')}</p>}{item.ai.useCases.length > 0 && <ul className="use-cases">{item.ai.useCases.map((useCase, index) => <li key={`${index}-${useCase}`}>{useCase}</li>)}</ul>}{item.ai.keywords.length > 0 && <p className="field-hint">{t('关键词：{keywords}', { keywords: item.ai.keywords.join(getLocale() === 'zh-CN' ? '、' : ', ') })}</p>}</section>}
            <Card className="analysis-section"><Card.Content><div className="section-heading"><h3 className="section-label"><Bot size={14} aria-hidden="true" />{t('AI 分析')}</h3><Chip size="sm" variant="soft" color={item.analysisStatus === 'failed' ? 'danger' : 'default'}>{statusLabels[item.analysisStatus]}</Chip></div>{item.analysisError && <p className={item.analysisStatus === 'failed' ? 'inline-error' : 'inline-info'}>{t(item.analysisError)}</p>}<p className="field-hint">{t('启用后将发送标题、描述和正文 / README，不发送私人笔记或单独保存的划词字段。人工编辑会保留。')}</p><Button size="sm" type="button" variant="secondary" isDisabled={Boolean(busy) || (aiReady !== false && (item.analysisStatus === 'running' || item.analysisStatus === 'pending'))} onPress={() => void analyze()}>{busy === 'analyze' ? <Spinner label={t('正在提交…')} /> : <><Bot size={15} aria-hidden="true" />{aiReady === false ? t('配置 AI 分析') : item.analysisStatus === 'failed' ? t('重试分析') : t('重新分析')}</>}</Button>{aiReady === false && <Button size="sm" type="button" variant="ghost" onPress={() => void settings()}>{t('打开设置')}<ArrowUpRight size={13} aria-hidden="true" /></Button>}</Card.Content></Card>
          </div>}
          {tab === 'content' && <section className="content-section"><h3 className="section-label">{item.source === 'github' ? t('README 快照') : t('已保存的正文快照')}</h3>{item.truncated && <p className="inline-info">{t('内容较长，保存的快照已截断。完整内容请打开原文查看。')}</p>}{item.content ? item.source === 'github' ? <><p className="field-hint">{t('图片需手动加载，HTML 标签按文字显示。')}{readmeBaseUrl && t('相对链接按仓库默认分支根目录解析。')}</p><div className="content-text readme-content"><Markdown text={item.content} mode="readme" baseUrl={readmeBaseUrl} /></div></> : <pre className="content-text">{item.content}</pre> : <div className="detail-empty"><FileText size={29} strokeWidth={1.5} aria-hidden="true" /><h3>{t('没有保存正文')}</h3><p>{t('此收藏仅包含已有信息。打开原网页后，可点击悬浮收藏或侧栏的“保存当前页”；也可在设置中检查正文留存选项。')}</p></div>}{item.excerpt && <div className="excerpt"><h3 className="section-label">{t('原始摘录')}</h3><p>{item.excerpt}</p></div>}</section>}
          {tab === 'notes' && <div className="detail-sections"><section><div className="section-heading"><h3 className="section-label"><StickyNote size={14} aria-hidden="true" />{t('私人笔记')}</h3><Button size="sm" variant="ghost" type="button" onPress={startEdit}><Pencil size={13} aria-hidden="true" />{t('编辑笔记')}</Button></div><p className={`notes-text ${item.notes ? '' : 'muted'}`}>{item.notes || t('还没有笔记。')}</p><p className="field-hint">{t('私人笔记不发送给 AI。')}</p></section><section><h3 className="section-label">{t('保存的划词 · {count}', { count: item.selections.length })}</h3>{item.selections.length ? item.selections.map((selection, index) => <blockquote className="selection" key={`${item.id}-${index}`}>{selection}</blockquote>) : <p className="muted small">{t('在原网页选中文字后收藏，可留下重要片段。')}</p>}</section></div>}
          </Tabs.Panel></Tabs><dl className="detail-dates"><div><dt>{t('收藏于')}</dt><dd>{formatDate(item.createdAt)}</dd></div><div><dt>{t('最近更新')}</dt><dd>{formatDate(item.updatedAt)}</dd></div>{item.author && <div><dt>{t('作者')}</dt><dd>{item.author}</dd></div>}{item.publishedAt && <div><dt>{t('发布于')}</dt><dd>{formatDate(item.publishedAt)}</dd></div>}</dl>
          <div className="detail-footer">{item.source === 'github' && <Button size="sm" type="button" variant="secondary" isDisabled={Boolean(busy)} onPress={() => void refresh()}>{busy === 'refresh' ? <Spinner label={t('正在刷新…')} /> : <><RefreshCw size={15} aria-hidden="true" />{t('刷新仓库')}</>}</Button>}<Button size="sm" type="button" variant="ghost" className="danger-action" isDisabled={Boolean(busy)} onPress={() => { deleteFeedback.dismiss(); setDeleteOpen(true); }}><Trash2 size={15} aria-hidden="true" />{t('删除收藏')}</Button></div>
        </>}
      </div>
    </Modal>
    {deleteOpen && <Modal title={t('删除这条收藏？')} onClose={() => setDeleteOpen(false)} busy={busy === 'delete'}><div className="modal-body"><Feedback notice={deleteFeedback.notice} /><p className="confirm-title">{item.title || item.url}</p><p className="muted">{t('将删除此收藏的正文、笔记和划词，无法撤销。')}{item.source === 'github' ? t('不会取消 GitHub 上的 Star。') : ''}</p><div className="modal-actions"><Button size="sm" type="button" variant="secondary" isDisabled={busy === 'delete'} onPress={() => setDeleteOpen(false)}>{t('保留收藏')}</Button><Button size="sm" type="button" variant="danger" isDisabled={busy === 'delete'} onPress={() => void remove()}>{busy === 'delete' ? <Spinner label={t('删除中…')} /> : t('确认删除')}</Button></div></div></Modal>}
    {discardAction && <Modal title={t('放弃尚未保存的修改？')} onClose={() => setDiscardAction(null)}><div className="modal-body"><p className="muted">{t('关闭后，本次编辑的内容不会保存。')}</p><div className="modal-actions"><Button size="sm" type="button" variant="secondary" onPress={() => setDiscardAction(null)}>{t('继续编辑')}</Button><Button size="sm" type="button" variant="danger" onPress={() => { const action = discardAction; setDiscardAction(null); setEditing(false); if (action === 'close') onClose(); }}>{t('放弃修改')}</Button></div></div></Modal>}
  </>;
}
