import { useEffect, useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Database, RefreshCw } from 'lucide-react';
import { t } from '../lib/i18n';
import { request } from '../lib/client';
import { db } from '../lib/library';
import type { IndexOverview, SourceIndex } from '../lib/index-types';
import type { Item } from '../lib/types';
import { Feedback, Modal, Spinner, useFeedback } from './components';
import './index-status.css';

export function indexErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/401|403|unauthori|forbidden|密钥|权限|授权/i.test(message)) return t('无法访问 Embedding 服务，请检查访问权限和 API Key 后重试。');
  if (/timeout|timed out|超时/i.test(message)) return t('Embedding 服务请求超时，请检查本地服务或网络后重试。');
  if (/429|rate.limit|限流/i.test(message)) return t('Embedding 服务暂时限流，请稍后重试。');
  return t('索引操作未完成，请检查已保存的 Embedding 配置、服务连接和访问权限后重试。');
}

function contentState(item: Item) {
  return item.content.trim() ? 'body' : item.description.trim() || item.excerpt.trim() ? 'summary' : 'link';
}

function currentIndex(item: Item, index?: SourceIndex) {
  return index?.contentVersion === item.contentVersion ? index : undefined;
}

function indexLabel(index?: SourceIndex) {
  if (!index) return t('待索引');
  if (index.status === 'failed') return t('索引失败 · 可重试');
  if (index.status === 'pending') return t('待索引');
  if (index.status === 'indexing') return t('正在索引');
  if (index.status === 'excluded') return t('已排除语义索引');
  if (index.status === 'disabled') return t('语义检索未启用');
  return index.vectorCount > 0 && index.vectorCount >= index.chunkCount ? t('向量就绪') : t('本地索引就绪');
}

export function SourceIndexBadges({ item, index, loading = false }: { item: Item; index?: SourceIndex; loading?: boolean }) {
  const current = currentIndex(item, index);
  return <span className="source-index-badges">
    <Chip size="sm" variant="soft">{contentState(item) === 'body' ? t('正文已保存') : contentState(item) === 'summary' ? t('仅简介') : t('仅链接')}</Chip>
    <Chip size="sm" variant="soft" color={current?.status === 'failed' ? 'danger' : 'default'}>{loading ? t('读取索引…') : indexLabel(current)}</Chip>
  </span>;
}

export function IndexOverviewPanel({ semanticEnabled, disabled = false }: { semanticEnabled: boolean; disabled?: boolean }) {
  const [overview, setOverview] = useState<IndexOverview | null>(null);
  const [reading, setReading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const feedback = useFeedback();
  const snapshot = useLiveQuery(async () => {
    try {
      const [items, indexes, chunks, vectors] = await Promise.all([
        db.items.toArray(), db.sourceIndexes.toArray(), db.sourceChunks.count(), db.chunkVectors.count(),
      ]);
      const byItem = new Map(indexes.map(index => [index.itemId, index]));
      const current = items.map(item => currentIndex(item, byItem.get(item.id)));
      return {
        body: items.filter(item => contentState(item) === 'body').length,
        summary: items.filter(item => contentState(item) === 'summary').length,
        linkOnly: items.filter(item => contentState(item) === 'link').length,
        total: items.length, chunks, vectors,
        ready: current.filter(index => index?.status === 'ready' && index.vectorCount > 0 && index.vectorCount >= index.chunkCount).length,
        pending: current.filter(index => !index || index.status === 'pending' || index.status === 'indexing').length,
        failed: current.filter(index => index?.status === 'failed').length,
        excluded: current.filter(index => index?.status === 'excluded').length,
        running: current.some(index => index?.status === 'indexing'),
      };
    } catch { return null; }
  }, []);

  useEffect(() => {
    let active = true;
    void request<IndexOverview>({ type: 'getIndexOverview' }).then(value => {
      if (active) setOverview(value);
    }).catch(() => {
      if (active) feedback.notify(t('暂时无法读取索引概况，可点击刷新重试。'), 'error');
    }).finally(() => { if (active) setReading(false); });
    return () => { active = false; };
  }, []);

  async function refresh() {
    if (reading) return;
    setReading(true); feedback.dismiss();
    try { setOverview(await request<IndexOverview>({ type: 'getIndexOverview' })); }
    catch { feedback.notify(t('暂时无法读取索引概况，可点击刷新重试。'), 'error'); }
    finally { setReading(false); }
  }
  async function rebuild() {
    if (disabled || rebuilding) return;
    setRebuilding(true); feedback.dismiss();
    try {
      await request<void>({ type: 'rebuildIndexes' });
      setConfirmRebuild(false);
      feedback.notify(t('重建任务已排队，索引状态会随实际处理更新。现有笔记、划词和对话已保留。'));
    } catch (error) { feedback.notify(indexErrorMessage(error), 'error'); }
    finally { setRebuilding(false); }
  }

  const stats = snapshot || overview;
  return <section className="index-overview" aria-label={t('检索索引概况')}>
    <div className="index-section-heading"><h3><Database size={15} aria-hidden="true" />{t('索引状态')}</h3><Button type="button" size="sm" variant="ghost" aria-label={t('刷新索引状态')} isDisabled={reading || rebuilding || disabled} onPress={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />{t('刷新状态')}</Button></div>
    {!stats ? <p className="field-hint" role="status">{reading ? t('正在读取索引…') : t('索引概况暂不可用，请刷新重试。')}</p> : <>
      <dl className="index-statistics" aria-live="polite">
        <div><dt>{t('正文可用')}</dt><dd>{snapshot ? snapshot.body : '—'}</dd></div>
        <div><dt>{t('仅简介')}</dt><dd>{snapshot ? snapshot.summary : '—'}</dd></div>
        <div><dt>{t('仅链接')}</dt><dd>{stats.linkOnly}</dd></div>
        <div><dt>{t('待索引')}</dt><dd>{stats.pending}</dd></div>
        <div><dt>{t('向量就绪')}</dt><dd>{stats.ready}</dd></div>
        <div><dt>{t('失败待重试')}</dt><dd>{stats.failed}</dd></div>
      </dl>
      <p className="field-hint">{t('共 {total} 条来源 · {chunks} 个片段 · {vectors} 个向量 · {excluded} 条已排除。', { total: stats.total, chunks: stats.chunks, vectors: stats.vectors, excluded: stats.excluded })}{stats.running ? t('后台正在索引。') : t('状态来自已保存的索引记录。')}</p>
      {stats.failed > 0 && <p className="field-hint">{t('失败来源仍可本地查找；检查服务配置后，点击“重建检索索引”重试。')}</p>}
    </>}
    <p className="field-hint">{semanticEnabled ? t('已保存的语义检索开关已启用：重建时会将允许索引的公开来源标题、描述和正文发送给 Embedding 服务。') : t('语义检索未启用：重建仅更新本地检索索引，不调用 Embedding 服务。')}{t('私人笔记、划词及人工覆盖字段绝不发送给 Embedding 服务。')}</p>
    <div className="index-actions"><Button type="button" size="sm" variant="secondary" isDisabled={disabled || rebuilding} onPress={() => setConfirmRebuild(true)}>{rebuilding ? <Spinner label={t('正在排队…')} /> : <><RefreshCw size={14} aria-hidden="true" />{t('重建检索索引')}</>}</Button></div>
    {disabled && <p className="field-hint">{t('请先保存设置修改，等待连接测试结束后再管理索引。')}</p>}
    <Feedback notice={feedback.notice} onDismiss={feedback.dismiss} />
    {confirmRebuild && <Modal title={t('重建检索索引？')} busy={rebuilding} onClose={() => setConfirmRebuild(false)}>
      <div className="index-confirm">
        <p>{semanticEnabled ? t('将按已保存的配置重建索引，并把允许索引的公开来源标题、描述和正文发送到 Embedding 服务，可能产生费用。') : t('将重新生成本地检索索引。语义检索未启用，不会调用 Embedding 服务。')}</p>
        <p className="field-hint">{t('不会发送私人笔记、划词或人工覆盖字段，也不会删除现有收藏、笔记或对话。任务排队后可继续浏览，排队成功不代表向量已就绪。')}</p>
        <Feedback notice={feedback.notice} />
        <div className="modal-actions"><Button type="button" size="sm" variant="secondary" isDisabled={rebuilding} onPress={() => setConfirmRebuild(false)}>{t('取消')}</Button><Button type="button" size="sm" isDisabled={rebuilding || disabled} onPress={() => void rebuild()}>{rebuilding ? <Spinner label={t('正在排队…')} /> : t('确认重建')}</Button></div>
      </div>
    </Modal>}
  </section>;
}

export function ItemIndexStatus({ item, onSettings }: { item: Item; onSettings: () => void }) {
  const snapshot = useLiveQuery(async () => {
    try {
      const index = await db.sourceIndexes.get(item.id);
      const current = currentIndex(item, index);
      const [chunks, vectors] = current ? await Promise.all([
        db.sourceChunks.where('itemId').equals(item.id).filter(chunk => chunk.sourceHash === current.sourceHash).count(),
        db.chunkVectors.where('itemId').equals(item.id).filter(vector => vector.sourceHash === current.sourceHash && vector.embeddingKey === current.embeddingKey).count(),
      ]) : [0, 0];
      return { index: current, chunks, vectors };
    } catch { return null; }
  }, [item.id, item.contentVersion]);
  return <section className="item-index-status" aria-label={t('来源索引状态')}>
    <div className="index-section-heading"><h3 className="section-label"><Database size={14} aria-hidden="true" />{t('检索索引')}</h3></div>
    <SourceIndexBadges item={item} index={snapshot?.index} loading={snapshot === undefined} />
    {snapshot === null ? <p className="field-hint">{t('暂时无法读取此来源的索引，请在设置中刷新索引状态。')}</p> : <dl className="index-statistics index-item-counts"><div><dt>{t('片段数')}</dt><dd>{snapshot?.chunks ?? '—'}</dd></div><div><dt>{t('向量数')}</dt><dd>{snapshot?.vectors ?? '—'}</dd></div></dl>}
    {contentState(item) !== 'body' && <p className="field-hint">{t('来源内容不足，检索仅使用已有标题与简介。')}{item.source === 'github' ? t('可点击下方“刷新仓库”补充 README，并检查设置中的正文留存选项。') : t('请手动打开原网页，再点击侧栏“保存当前页”刷新正文，并检查设置中的正文留存选项。')}</p>}
    {snapshot?.index?.status === 'failed' && <p className="inline-error">{indexErrorMessage(snapshot.index.error)}</p>}
    <p className="field-hint">{t('索引仅使用来源内容；私人笔记、划词和人工覆盖字段不会发送给 Embedding 服务。')}</p>
    <Button type="button" size="sm" variant="ghost" onPress={onSettings}>{snapshot?.index?.status === 'failed' ? t('前往设置重试索引') : t('管理检索索引')}</Button>
  </section>;
}
