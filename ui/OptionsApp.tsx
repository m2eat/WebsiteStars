import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button, Card, Chip, Input, Radio, RadioGroup, TextArea } from '@heroui/react';
import { ArrowLeft, Bot, Check, Database, Download, FileJson, HardDrive, KeyRound, LockKeyhole, Save, ShieldCheck, Upload } from 'lucide-react';
import { z } from 'zod';
import type { browser } from 'wxt/browser';
import { t } from '../lib/i18n';
import { openLibrary, request } from '../lib/client';
import { parseBackup } from '../lib/library';
import type { Item, Settings, AvailableModel, ModelList } from '../lib/types';
import { Brand, Feedback, Field, Modal, PreferenceSwitch, Spinner, errorMessage, useFeedback } from './components';
import { Navigation } from './Navigation';
import { IndexOverviewPanel, indexErrorMessage } from './IndexStatus';

declare const chrome: Pick<typeof browser, 'permissions'>;

type ImportPreview = { text: string; name: string; items: Item[] };

function endpointOrigin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(t('请输入完整的 AI 服务地址，例如 https://api.x.ai/v1。')); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error(t('AI 服务地址须使用 HTTPS；仅本机 loopback 地址允许 HTTP。'));
  if (url.username || url.password || url.search || url.hash) throw new Error(t('服务地址不能包含用户名、密码、查询参数或锚点。'));
  return `${url.origin}/*`;
}

export function OptionsApp() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [baseline, setBaseline] = useState('');
  const [domains, setDomains] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [embeddingTesting, setEmbeddingTesting] = useState(false);
  const [savedSemanticEnabled, setSavedSemanticEnabled] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [modelFilter, setModelFilter] = useState('');
  const modelRequest = useRef(0);
  const modelFeedback = useFeedback();
  const [dataBusy, setDataBusy] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const feedback = useFeedback();
  const connectionFeedback = useFeedback();
  const embeddingFeedback = useFeedback();
  const dataFeedback = useFeedback();
  const importFeedback = useFeedback();
  const currentSettings = settings ? { ...settings, blockedDomains: [...new Set(domains.split(/\r?\n/).map(domain => domain.trim().toLowerCase()).filter(Boolean))] } : null;
  const dirty = currentSettings !== null && JSON.stringify(currentSettings) !== baseline;
  const connectionKey = settings ? JSON.stringify([settings.provider, settings.endpoint, settings.apiKey, settings.accountId]) : '';
  const visibleModels = models.filter(model => `${model.id} ${model.name}`.toLowerCase().includes(modelFilter.toLowerCase()));

  useEffect(() => {
    modelRequest.current++;
    setModels([]); setModelFilter(''); setModelsLoading(false); modelFeedback.dismiss();
  }, [connectionKey]);
  useEffect(() => () => { modelRequest.current++; }, []);

  useEffect(() => {
    let current = true;
    void request<Settings>({ type: 'getSettings' }).then(value => {
      if (!current) return;
      setSettings(value); setSavedSemanticEnabled(value.semanticEnabled); setDomains(value.blockedDomains.join('\n')); setBaseline(JSON.stringify(value));
    }).catch(error => { if (current) feedback.notify(errorMessage(error), 'error'); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!dirty) return;
    function confirmLeave(event: BeforeUnloadEvent) { event.preventDefault(); }
    window.addEventListener('beforeunload', confirmLeave);
    return () => window.removeEventListener('beforeunload', confirmLeave);
  }, [dirty]);

  async function reload() {
    setLoading(true); feedback.dismiss();
    try { const value = await request<Settings>({ type: 'getSettings' }); setSettings(value); setSavedSemanticEnabled(value.semanticEnabled); setDomains(value.blockedDomains.join('\n')); setBaseline(JSON.stringify(value)); }
    catch (error) { feedback.notify(errorMessage(error), 'error'); }
    finally { setLoading(false); }
  }
  function update<K extends keyof Settings>(key: K, value: Settings[K]) { setSettings(current => current ? { ...current, [key]: value } : current); }
  async function library() {
    try { await openLibrary(); }
    catch (error) { feedback.notify(errorMessage(error), 'error'); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!currentSettings || saving || testing || embeddingTesting) return;
    feedback.dismiss();
    const next = { ...currentSettings, endpoint: currentSettings.endpoint.trim(), model: currentSettings.model.trim(), accountId: currentSettings.accountId.trim(), apiKey: currentSettings.apiKey.trim(), githubToken: currentSettings.githubToken.trim(), embeddingEndpoint: currentSettings.embeddingEndpoint.trim(), embeddingModel: currentSettings.embeddingModel.trim(), embeddingApiKey: currentSettings.embeddingApiKey.trim() };
    try {
      if (!Number.isInteger(next.modelTimeoutSeconds) || next.modelTimeoutSeconds < 30 || next.modelTimeoutSeconds > 1800) throw new Error(t('单次模型请求超时需为 30–1800 秒的整数。'));
      if (!Number.isInteger(next.queryTimeoutSeconds) || next.queryTimeoutSeconds < 60 || next.queryTimeoutSeconds > 3600) throw new Error(t('整轮查询超时需为 60–3600 秒的整数。'));
      if (next.queryTimeoutSeconds < next.modelTimeoutSeconds) throw new Error(t('整轮查询超时不能小于单次模型请求超时。'));
      let origin = 'https://api.cloudflare.com/*';
      if (next.provider === 'compatible' && next.endpoint) origin = endpointOrigin(next.endpoint);
      if (next.aiEnabled || next.queryEnabled) {
        if (!next.apiKey || !next.model || (next.provider === 'workers-ai' ? !next.accountId : !next.endpoint)) throw new Error(t('启用 AI 分析或对话查询前，请填写 API Key、模型及对应的服务地址或 Account ID。'));
      }
      const embeddingOrigin = next.embeddingEndpoint ? endpointOrigin(next.embeddingEndpoint) : '';
      if (next.semanticEnabled && (!next.embeddingModel || !embeddingOrigin)) throw new Error(t('启用语义检索前，请填写 Embedding 服务地址和 Embedding 模型。'));
      const origins = [...new Set([...(next.aiEnabled || next.queryEnabled ? [origin] : []), ...(next.semanticEnabled ? [embeddingOrigin] : [])])];
      setSaving(true);
      if (origins.length) {
        const granted = await chrome.permissions.request({ origins });
        if (!granted) throw new Error(t('未获得服务域名访问权限，设置尚未保存。请再次授权，或关闭对应的 AI 分析、对话查询或语义检索开关后保存。'));
      }
      const saved = await request<Settings>({ type: 'saveSettings', settings: next });
      setSettings(saved); setSavedSemanticEnabled(saved.semanticEnabled); setDomains(saved.blockedDomains.join('\n')); setBaseline(JSON.stringify(saved));
      feedback.notify(saved.queryEnabled ? t('设置已保存，对话查询已启用。发送问题会调用模型，收藏分析由独立开关控制；保存不会发送测试内容。') : saved.aiEnabled ? t('设置已保存。仅在收藏或主动分析时使用 AI，未发送测试内容。') : saved.semanticEnabled ? t('设置已保存，语义检索已启用。允许索引的来源内容将发送给 Embedding 服务；聊天与收藏分析仍关闭。') : t('设置已保存，AI 已关闭。本地收藏与搜索照常可用。'));
      connectionFeedback.dismiss(); embeddingFeedback.dismiss();
    } catch (error) { feedback.notify(errorMessage(error), 'error'); }
    finally { setSaving(false); }
  }
  async function fetchModels() {
    if (!settings || modelsLoading) return;
    const sequence = ++modelRequest.current;
    setModelsLoading(true); modelFeedback.dismiss();
    try {
      const origin = settings.provider === 'workers-ai' ? 'https://api.cloudflare.com/*' : endpointOrigin(settings.endpoint);
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error(t('未获得模型服务访问权限，仍可手动填写模型。'));
      if (sequence !== modelRequest.current) return;
      const result = await request<ModelList>({ type: 'listModels', connection: {
        provider: settings.provider, endpoint: settings.endpoint.trim(), apiKey: settings.apiKey.trim(),
        accountId: settings.accountId.trim(), modelTimeoutSeconds: settings.modelTimeoutSeconds,
      } });
      if (sequence !== modelRequest.current) return;
      setModels(result.models); setModelFilter('');
      modelFeedback.notify(result.models.length ? result.truncated ? t('已获取 {count} 个模型（仅显示部分结果），选择后请保存设置。', { count: result.models.length }) : t('已获取 {count} 个模型，选择后请保存设置。', { count: result.models.length }) : t('服务返回了空模型列表，仍可手动填写模型。'), result.models.length ? 'success' : 'info');
    } catch (error) { if (sequence === modelRequest.current) modelFeedback.notify(errorMessage(error), 'error'); }
    finally { if (sequence === modelRequest.current) setModelsLoading(false); }
  }
  async function testConnection() {
    if (dirty || !settings?.queryEnabled || saving || testing || embeddingTesting) return;
    setTesting(true); connectionFeedback.dismiss();
    try {
      const result = await request<{ ok: true; model: string }>({ type: 'testQueryConnection' });
      connectionFeedback.notify(t('Agent 连接可用，模型 {model} 已通过工具调用测试。', { model: result.model }));
    } catch (error) { connectionFeedback.notify(errorMessage(error), 'error'); }
    finally { setTesting(false); }
  }
  async function testEmbedding() {
    if (dirty || !settings?.semanticEnabled || saving || testing || embeddingTesting) return;
    setEmbeddingTesting(true); embeddingFeedback.dismiss();
    try {
      await request({ type: 'testEmbeddingConnection' });
      embeddingFeedback.notify(t('Embedding 连接测试成功，已保存的服务与模型可生成向量。'));
    } catch (error) { embeddingFeedback.notify(indexErrorMessage(error), 'error'); }
    finally { setEmbeddingTesting(false); }
  }
  async function exportData() {
    setDataBusy('export'); dataFeedback.dismiss();
    try {
      const text = await request<string>({ type: 'exportBackup' });
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = `websitestars-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      dataFeedback.notify(t('已开始下载 JSON 备份。备份不包含 API Key 或 GitHub Token。'));
    } catch (error) { dataFeedback.notify(errorMessage(error), 'error'); }
    finally { setDataBusy(''); }
  }
  async function chooseImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setDataBusy('read'); dataFeedback.dismiss(); importFeedback.dismiss();
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error(t('备份超过 50 MiB 大小限制。'));
      const text = await file.text(); const items = parseBackup(text); setPreview({ text, name: file.name, items });
    }
    catch (error) {
      const reason = error instanceof z.ZodError ? t('备份格式无效，或包含不安全的链接。请使用 WebsiteStars 导出的完整 JSON 文件。') : error instanceof SyntaxError ? t('文件不是有效的 JSON，请重新选择备份文件。') : errorMessage(error);
      dataFeedback.notify(t('无法读取备份：{reason}', { reason }), 'error');
    }
    finally { setDataBusy(''); }
  }
  async function importData() {
    if (!preview) return;
    setDataBusy('import'); importFeedback.dismiss();
    try {
      const result = await request<{ added: number; skipped: number }>({ type: 'importBackup', text: preview.text });
      setPreview(null); dataFeedback.notify(t('导入完成：新增 {added} 条，跳过 {skipped} 条重复收藏。', { added: result.added, skipped: result.skipped }));
    } catch (error) { importFeedback.notify(errorMessage(error), 'error'); }
    finally { setDataBusy(''); }
  }

  return <div className="app-shell options-shell">
    <Navigation active="settings" onSource={() => void library()} onOptions={() => document.getElementById('settings-title')?.scrollIntoView({ behavior: 'smooth' })} />
    <main className="options-main" id="main-content">
      <div className="mobile-bar"><Brand /><Button isIconOnly size="sm" variant="ghost" onPress={() => void library()} aria-label={t('打开资料库')}><ArrowLeft size={18} /></Button></div>
      <header className="page-heading"><div><h1 id="settings-title">{t('设置与数据')}</h1><p className="page-description">{t('管理收藏偏好、AI 连接与备份')}</p></div><Chip size="sm" variant="soft">{t('本地存储')}</Chip></header>
      <Feedback notice={feedback.notice} onDismiss={feedback.dismiss} />
      {loading ? <div className="loading-state"><Spinner label={t('正在读取设置…')} /></div> : !settings ? <Card className="settings-error"><Card.Title>{t('暂时无法读取设置')}</Card.Title><Card.Description>{t('连接恢复后重试，已保存的设置不会被覆盖。')}</Card.Description><Card.Footer><Button size="sm" variant="secondary" onPress={() => void reload()}>{t('重新读取')}</Button></Card.Footer></Card> : <form onSubmit={event => void save(event)} className="settings-form">
        <fieldset disabled={saving || testing || embeddingTesting} className="settings-fields">
          <Card className="settings-card" aria-labelledby="storage-heading">
            <Card.Header className="settings-card-heading"><HardDrive size={19} aria-hidden="true" /><div><Card.Title id="storage-heading">{t('收藏偏好')}</Card.Title><Card.Description>{t('网页入口、正文快照与 GitHub 访问')}</Card.Description></div></Card.Header>
            <Card.Content className="settings-card-body">
              <PreferenceSwitch label={t('网页悬浮收藏按钮')} hint={t('在普通网页显示收藏入口，仅点击时提取内容。')} selected={settings.floatingEnabled} disabled={saving || testing || embeddingTesting} onChange={selected => update('floatingEnabled', selected)} />
              <PreferenceSwitch label={t('保留正文 / README')} hint={t('收藏时保存纯文本快照，方便离线阅读和检索。简介、笔记和划词独立保留。')} selected={settings.retainContent} disabled={saving || testing || embeddingTesting} onChange={selected => update('retainContent', selected)} />
              <Field label={t('GitHub Token（可选）')} hint={t('公开仓库无需 Token 也能收藏；配置后可使用相应的 API 请求额度。')}><Input fullWidth type="password" autoComplete="new-password" spellCheck={false} value={settings.githubToken} onChange={event => update('githubToken', event.target.value)} placeholder={t('可留空')} /></Field>
              <p className="credential-note"><LockKeyhole size={14} aria-hidden="true" />{t('密钥保存在此浏览器，不随 JSON 备份导出。清空输入框并保存即可移除。')}</p>
            </Card.Content>
          </Card>
          <Card className="settings-card" aria-label={t('AI 服务连接')}>
            <Card.Header className="settings-card-heading"><Bot size={19} aria-hidden="true" /><div><Card.Title id="ai-heading">{t('模型连接')}</Card.Title><Card.Description>{t('用于收藏分析和对话查询，可分别启用')}</Card.Description></div><Chip size="sm" variant="soft">{t('可选')}</Chip></Card.Header>
            <Card.Content className="settings-card-body">
              <PreferenceSwitch label={t('启用 AI 分析')} hint={t('关闭时仍可正常收藏、阅读和搜索。')} selected={settings.aiEnabled} disabled={saving || testing || embeddingTesting} onChange={selected => update('aiEnabled', selected)} />
              <PreferenceSwitch label={t('启用对话查询')} hint={t('仅在发送问题后查询本地收藏；关闭不影响普通搜索和已保存对话。')} selected={settings.queryEnabled} disabled={saving || testing || embeddingTesting} onChange={selected => update('queryEnabled', selected)} />
              <div className="privacy-callout"><ShieldCheck size={17} aria-hidden="true" /><p>{t('收藏分析会发送标题、描述和正文 / README；对话查询会发送问题、近期问题和候选来源片段。私人笔记和单独保存的划词字段不会发送；正文仍可能包含选中的内容。两个用途分别启用，保存设置不会发送聊天测试请求。')}</p></div>
              <RadioGroup aria-label={t('AI 提供方')} value={settings.provider} isDisabled={saving || testing || embeddingTesting} onChange={value => setSettings(current => current ? { ...current, provider: value as Settings['provider'], model: value === 'workers-ai' && current.model === 'grok-4.5' ? '@cf/meta/llama-3.1-8b-instruct' : value === 'compatible' && current.model.startsWith('@cf/') ? 'grok-4.5' : current.model } : current)} orientation="horizontal" className="provider-group">
                <span className="field-label">{t('AI 提供方')}</span>
                <div className="provider-options">
                  <Radio value="compatible"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control><span>{t('兼容端点')}<small>{t('OpenAI 兼容 API')}</small></span></Radio.Content></Radio>
                  <Radio value="workers-ai"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control><span>{t('Workers AI')}<small>{t('Cloudflare REST API')}</small></span></Radio.Content></Radio>
                </div>
              </RadioGroup>
              {settings.provider === 'compatible' ? <Field label={t('服务地址')} hint={t('使用 HTTPS；本机地址允许 HTTP。保存时申请此域名访问权限。')}><Input fullWidth type="url" autoComplete="off" autoCapitalize="none" spellCheck={false} value={settings.endpoint} onChange={event => update('endpoint', event.target.value)} placeholder="https://api.x.ai/v1" required={settings.aiEnabled || settings.queryEnabled} /></Field> : <Field label={t('Cloudflare Account ID')} hint={t('通过 api.cloudflare.com 调用；保存时申请该域名访问权限。')}><Input fullWidth autoComplete="off" autoCapitalize="none" spellCheck={false} value={settings.accountId} onChange={event => update('accountId', event.target.value)} placeholder={t('Cloudflare 账户 ID')} required={settings.aiEnabled || settings.queryEnabled} /></Field>}
              <div className="form-grid">
                <Field label={t('模型')} hint={settings.provider === 'workers-ai' ? t('使用完整模型名称，包括 @cf/ 前缀。') : t('填写服务提供方支持的模型名称。')}><Input fullWidth autoComplete="off" autoCapitalize="none" spellCheck={false} value={settings.model} onChange={event => update('model', event.target.value)} placeholder={settings.provider === 'workers-ai' ? '@cf/meta/llama-3.1-8b-instruct' : 'grok-4.5'} required={settings.aiEnabled || settings.queryEnabled} /></Field>
                <Field label={settings.provider === 'workers-ai' ? t('API Token') : t('API Key')} hint={t('仅保存在此浏览器的本地扩展设置中。')}><Input fullWidth type="password" autoComplete="new-password" spellCheck={false} value={settings.apiKey} onChange={event => update('apiKey', event.target.value)} placeholder={t('输入密钥')} required={settings.aiEnabled || settings.queryEnabled} /></Field>
              </div>
              <div className="model-discovery">
                <Button type="button" size="sm" variant="secondary" isDisabled={modelsLoading || saving || testing || embeddingTesting} onPress={() => void fetchModels()}>{modelsLoading ? <Spinner label={t('正在获取模型列表…')} /> : t('获取模型列表')}</Button>
                <p className="field-hint">{t('使用当前填写的服务地址和密钥，不必先保存；仅读取模型目录，不发送收藏或生成内容。模型是否支持 Agent 工具调用，仍需连接测试；此列表不代表模型具备 Embedding 能力。')}</p>
                <Feedback notice={modelFeedback.notice} onDismiss={modelFeedback.dismiss} />
                {models.length > 0 && <div className="form-grid">
                  <Field label={t('筛选模型')}><Input fullWidth value={modelFilter} onChange={event => setModelFilter(event.target.value)} placeholder={t('输入名称筛选模型')} /></Field>
                  <Field label={t('选择已获取的模型')}><select value={visibleModels.some(model => model.id === settings.model) ? settings.model : ''} onChange={event => { if (event.target.value) update('model', event.target.value); }}><option value="">{visibleModels.length ? t('请选择（{count} 个）', { count: visibleModels.length }) : t('没有匹配的模型')}</option>{visibleModels.map(model => <option key={model.id} value={model.id}>{model.name === model.id ? model.id : `${model.id} · ${model.name}`}</option>)}</select></Field>
                </div>}
              </div>
              <div className="form-grid">
                <Field label={t('单次模型请求超时（秒）')} hint={t('默认 180 秒；范围 30–1800 秒。应用于模型响应、连接测试与模型列表。')}><Input fullWidth type="number" min={30} max={1800} step={1} required value={Number.isFinite(settings.modelTimeoutSeconds) ? String(settings.modelTimeoutSeconds) : ''} onChange={event => update('modelTimeoutSeconds', event.target.value === '' ? Number.NaN : Number(event.target.value))} /></Field>
                <Field label={t('整轮查询超时（秒）')} hint={t('默认 900 秒；范围 60–3600 秒，需不小于单次请求超时。到达时限后可手动重试。')}><Input fullWidth type="number" min={Math.max(60, settings.modelTimeoutSeconds || 60)} max={3600} step={1} required value={Number.isFinite(settings.queryTimeoutSeconds) ? String(settings.queryTimeoutSeconds) : ''} onChange={event => update('queryTimeoutSeconds', event.target.value === '' ? Number.NaN : Number(event.target.value))} /></Field>
              </div>
              <div className="form-stack"><p className="field-hint">{t('对话查询需要模型支持工具调用（tool calling）。测试只使用已保存配置，可能消耗少量 token，不读取收藏。')}</p><Button type="button" size="sm" variant="secondary" isDisabled={dirty || !settings.queryEnabled || saving || testing || embeddingTesting} onPress={() => void testConnection()}>{testing ? <Spinner label={t('正在测试 Agent 连接…')} /> : t('测试 Agent 连接')}</Button><p className="field-hint">{dirty ? t('请先保存修改，再测试 Agent 连接。') : !settings.queryEnabled ? t('请启用对话查询并保存后测试。') : t('仅在点击测试时向已保存的模型发送测试请求。')}</p><Feedback notice={connectionFeedback.notice} onDismiss={connectionFeedback.dismiss} /></div>
              <Field label={t('禁止分析的域名')} hint={t('每行一个域名。匹配的站点及其子域名不会发送给 AI；仍可正常收藏。')}><TextArea fullWidth rows={3} value={domains} onChange={event => setDomains(event.target.value)} placeholder={'intranet.example.com\nprivate.example.org'} autoCapitalize="none" spellCheck={false} /></Field>
            </Card.Content>
          </Card>
          <Card className="settings-card semantic-settings-card" aria-labelledby="semantic-heading">
            <Card.Header className="settings-card-heading"><Database size={19} aria-hidden="true" /><div><Card.Title id="semantic-heading">{t('语义检索与索引')}</Card.Title><Card.Description>{t('独立的 Embedding 服务配置，与聊天模型配置不同')}</Card.Description></div></Card.Header>
            <Card.Content className="settings-card-body">
              <PreferenceSwitch label={t('启用语义检索')} hint={t('默认关闭。仅在显式开启、授权并保存后，才向 Embedding 服务发送允许索引的来源内容。')} selected={settings.semanticEnabled} disabled={saving || testing || embeddingTesting} onChange={selected => update('semanticEnabled', selected)} />
              <div className="privacy-callout"><ShieldCheck size={17} aria-hidden="true" /><p>{t('Embedding 服务将接收来源标题、描述和正文 / README，用于生成检索向量。私人笔记、划词及人工覆盖内容绝不发送给该服务。Embedding 服务地址、模型和密钥独立配置，不会沿用聊天模型设置。')}</p></div>
              <Field label={t('Embedding 服务地址')} hint={t('支持 HTTPS；localhost、127.0.0.1、[::1] 本机服务可使用 HTTP。启用并保存时申请此服务域名的访问权限。')}><Input fullWidth type="url" autoComplete="off" autoCapitalize="none" spellCheck={false} value={settings.embeddingEndpoint} onChange={event => update('embeddingEndpoint', event.target.value)} placeholder="http://localhost:11434/v1" required={settings.semanticEnabled} /></Field>
              <div className="form-grid">
                <Field label={t('Embedding 模型')} hint={t('填写服务支持的向量模型名称；聊天模型不一定支持 Embedding。')}><Input fullWidth autoComplete="off" autoCapitalize="none" spellCheck={false} value={settings.embeddingModel} onChange={event => update('embeddingModel', event.target.value)} placeholder={t('例如 nomic-embed-text')} required={settings.semanticEnabled} /></Field>
                <Field label={t('Embedding API Key')} hint={t('可留空。本机服务或支持无密钥访问的远程兼容服务均不强制填写。')}><Input fullWidth type="password" autoComplete="new-password" spellCheck={false} value={settings.embeddingApiKey} onChange={event => update('embeddingApiKey', event.target.value)} placeholder={t('可留空')} /></Field>
              </div>
              <p className="field-hint">{t('可连接你自行运行的 localhost / Ollama OpenAI-compatible Embedding 服务。请自行启动服务并准备向量模型，扩展不会自动安装模型。')}</p>
              <p className="credential-note"><LockKeyhole size={14} aria-hidden="true" />{t('Embedding API Key 仅保存在此浏览器，不随 JSON 备份导出；清空并保存即可移除。')}</p>
              <PreferenceSwitch label={t('允许本地笔记辅助查找')} hint={t('默认关闭。开启后笔记、人工标签和人工简介仅在本地辅助召回，不发送这些字段；召回后关联的来源内容可能发送给模型。')} selected={settings.localNotesSearch} disabled={saving || testing || embeddingTesting} onChange={selected => update('localNotesSearch', selected)} />
              <div className="form-stack">
                <Button type="button" size="sm" variant="secondary" isDisabled={dirty || !settings.semanticEnabled || saving || testing || embeddingTesting} onPress={() => void testEmbedding()}>{embeddingTesting ? <Spinner label={t('正在测试 Embedding 连接…')} /> : t('测试 Embedding 连接')}</Button>
                <p className="field-hint">{dirty ? t('请先保存修改，再测试 Embedding 连接。') : !settings.semanticEnabled ? t('请启用语义检索并保存后测试。') : t('仅在点击时使用已保存的配置发送少量测试文本；不读取收藏，可能产生服务费用。')}</p>
                <Feedback notice={embeddingFeedback.notice} onDismiss={embeddingFeedback.dismiss} />
              </div>
              <IndexOverviewPanel semanticEnabled={savedSemanticEnabled} disabled={dirty || saving || testing || embeddingTesting} />
            </Card.Content>
          </Card>
        </fieldset>
        <div className="settings-save"><span aria-live="polite">{saving ? t('正在保存设置…') : dirty ? t('有尚未保存的修改') : <><Check size={14} aria-hidden="true" />{t('所有设置已保存')}</>}</span><Button type="submit" size="sm" isDisabled={saving || testing || embeddingTesting}>{saving ? <Spinner label={t('正在保存…')} /> : <><Save size={15} aria-hidden="true" />{t('保存设置')}</>}</Button></div>
      </form>}
      <Card className="settings-card backup-card" aria-labelledby="backup-heading">
        <Card.Header className="settings-card-heading"><FileJson size={19} aria-hidden="true" /><div><Card.Title id="backup-heading">{t('导入与导出')}</Card.Title><Card.Description>{t('通过 JSON 文件备份或恢复资料库')}</Card.Description></div></Card.Header>
        <Card.Content className="settings-card-body">
          <Feedback notice={dataFeedback.notice} onDismiss={dataFeedback.dismiss} />
          <p className="backup-description">{t('包含收藏、人工编辑、笔记、划词及已保存的正文。导入前会校验并预览，重复条目将跳过。')}</p>
          <div className="backup-actions">
            <Button size="sm" variant="secondary" isDisabled={Boolean(dataBusy)} onPress={() => void exportData()}>{dataBusy === 'export' ? <Spinner label={t('正在导出…')} /> : <><Download size={16} aria-hidden="true" />{t('导出 JSON')}</>}</Button>
            <Button size="sm" variant="secondary" isDisabled={Boolean(dataBusy)} onPress={() => importInput.current?.click()}>{dataBusy === 'read' ? <Spinner label={t('正在校验…')} /> : <><Upload size={16} aria-hidden="true" />{t('导入备份')}</>}</Button>
            <input ref={importInput} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-label={t('选择 JSON 备份文件')} onChange={event => void chooseImport(event)} />
          </div>
          <p className="field-hint"><KeyRound size={14} aria-hidden="true" />{t('不包含 API Key、GitHub Token 或连接设置。')}</p>
        </Card.Content>
      </Card>
      <footer className="options-footer">{t('建议定期备份。卸载扩展会移除此浏览器中的本地数据。')}</footer>
    </main>
    {preview && <Modal title={t('确认导入备份')} onClose={() => setPreview(null)} busy={dataBusy === 'import'}>
      <Feedback notice={importFeedback.notice} />
      <div className="import-file"><FileJson size={24} aria-hidden="true" /><div><strong>{preview.name}</strong><span>{t('文件已通过格式校验')}</span></div></div>
      <p className="import-total"><strong>{t('{count} 条收藏待导入', { count: preview.items.length })}</strong></p>
      <dl className="import-counts"><div><dt>{t('GitHub')}</dt><dd>{preview.items.filter(item => item.source === 'github').length}</dd></div><div><dt>{t('文章')}</dt><dd>{preview.items.filter(item => item.source === 'article').length}</dd></div><div><dt>{t('文档')}</dt><dd>{preview.items.filter(item => item.source === 'docs').length}</dd></div></dl>
      <p className="muted small">{t('重复条目会跳过，不覆盖现有收藏。连接设置和密钥不会改变。')}</p>
      {preview.items.length === 0 && <p className="inline-info">{t('此备份没有可导入的收藏。')}</p>}
      <div className="modal-actions"><Button size="sm" variant="secondary" isDisabled={dataBusy === 'import'} onPress={() => setPreview(null)}>{t('取消')}</Button><Button size="sm" isDisabled={dataBusy === 'import' || preview.items.length === 0} onPress={() => void importData()}>{dataBusy === 'import' ? <Spinner label={t('正在导入…')} /> : <><Upload size={15} aria-hidden="true" />{t('确认导入 {count} 条', { count: preview.items.length })}</>}</Button></div>
    </Modal>}
  </div>;
}
