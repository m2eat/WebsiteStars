import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { Button } from '@heroui/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUp, History, MessageSquare, Plus, RotateCcw, ShieldCheck, Square, Trash2 } from 'lucide-react';
import { getLocale, t, translateError } from '../lib/i18n';
import { browser } from 'wxt/browser';
import { createChatTransport } from '../lib/chat-client';
import type { ChatMessage, ChatRun, ChatSession, ChatStatus } from '../lib/chat-types';
import { openOptions, request } from '../lib/client';
import { db } from '../lib/library';
import type { Item, Settings } from '../lib/types';
import { Feedback, Modal, Spinner, errorMessage, formatDate, useFeedback } from './components';
import { SOURCES } from './Navigation';
import { ChatComposer, ContextCards, LoadingState, StreamText, ToolChips, type ContextChunk } from './beautiful/primitives';
import './chat.css';

const SESSION_KEY = 'starts-chat-session';
const DRAFT_KEY = 'starts-chat-draft:';
const STATUS: Record<ChatStatus, string> = { idle: '未开始', running: '查询中', completed: '已完成', stopped: '已停止', failed: '查询失败', interrupted: '查询中断' };
const RETRYABLE: ChatStatus[] = ['failed', 'interrupted', 'stopped'];

function readLocal(key: string) {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}
function writeLocal(key: string, value: string) {
  try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
}
function toUIMessages(messages: ChatMessage[]): UIMessage[] {
  return messages.map(({ id, role, text }) => ({ id, role, parts: [{ type: 'text', text }] }));
}
function useDraft(sessionId: string | null) {
  const key = `${DRAFT_KEY}${sessionId ?? 'new'}`;
  const [draft, setDraft] = useState(() => readLocal(key));
  function update(value: string) { setDraft(value); writeLocal(key, value); }
  return [draft, update] as const;
}

export function ChatPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const sessions = useLiveQuery(() => db.chatSessions.orderBy('updatedAt').reverse().toArray());
  const items = useLiveQuery(() => db.items.toArray());
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() => readLocal(SESSION_KEY) || null);
  const [initialized, setInitialized] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChatSession | null>(null);
  const [queued, setQueued] = useState<{ sessionId: string; text: string } | null>(null);
  const creatingRef = useRef(false);
  const settingsRefresh = useRef<() => void>(() => undefined);
  const feedback = useFeedback();

  useEffect(() => {
    let current = true;
    let revision = 0;
    function refresh() {
      const requested = ++revision;
      void request<Settings>({ type: 'getSettings' }).then(value => {
        if (current && requested === revision) { setSettings(value); setSettingsError(''); }
      }).catch(error => {
        if (current && requested === revision) { setSettings(null); setSettingsError(errorMessage(error)); }
      });
    }
    function changed(changes: Record<string, unknown>, area: string) { if (area === 'local' && changes.settings) refresh(); }
    settingsRefresh.current = refresh;
    refresh();
    window.addEventListener('focus', refresh);
    browser.storage.onChanged.addListener(changed);
    return () => { current = false; window.removeEventListener('focus', refresh); browser.storage.onChanged.removeListener(changed); };
  }, []);

  useEffect(() => {
    if (!sessions || initialized) return;
    const id = sessions.find(session => session.id === selectedId)?.id ?? sessions[0]?.id ?? null;
    setSelectedId(id); writeLocal(SESSION_KEY, id ?? ''); setInitialized(true);
  }, [sessions, initialized, selectedId]);

  function select(id: string | null) { setSelectedId(id); writeLocal(SESSION_KEY, id ?? ''); feedback.dismiss(); }
  async function create(text?: string) {
    if (creatingRef.current || (text && (!settings?.queryEnabled || !items?.length))) return;
    creatingRef.current = true; setCreating(true); feedback.dismiss();
    try {
      const session = await request<ChatSession>({ type: 'createChat' });
      if (text) {
        writeLocal(`${DRAFT_KEY}${session.id}`, text);
        writeLocal(`${DRAFT_KEY}new`, '');
        setQueued({ sessionId: session.id, text });
      }
      select(session.id);
    } catch (error) { feedback.notify(errorMessage(error), 'error'); }
    finally { creatingRef.current = false; setCreating(false); }
  }
  async function remove() {
    if (!deleteTarget || deleting) return;
    setDeleting(true); feedback.dismiss();
    try {
      await request<void>({ type: 'deleteChat', id: deleteTarget.id });
      writeLocal(`${DRAFT_KEY}${deleteTarget.id}`, '');
      if (selectedId === deleteTarget.id) select(sessions?.find(session => session.id !== deleteTarget.id)?.id ?? null);
      setDeleteTarget(null);
    } catch (error) { feedback.notify(errorMessage(error), 'error'); }
    finally { setDeleting(false); }
  }
  async function options() {
    try { await openOptions(); } catch (error) { feedback.notify(errorMessage(error), 'error'); }
  }
  const selected = sessions?.find(session => session.id === selectedId);
  const enabled = settings?.queryEnabled === true;
  const ready = enabled && Boolean(items?.length);

  const guidance = <>
    <Feedback notice={feedback.notice} onDismiss={feedback.dismiss} />
    {settingsError ? <div className="chat-gate"><p role="alert">{settingsError}</p><Button size="sm" variant="secondary" onPress={() => settingsRefresh.current()}>{t('重新读取设置')}</Button></div> : settings && !enabled ? <div className="chat-gate"><div><strong>{t('启用对话查询')}</strong><p>{t('在模型连接设置中单独启用。仅在你发送问题后查询收藏。')}</p></div><Button size="sm" variant="secondary" onPress={() => void options()}>{t('打开设置')}</Button></div> : null}
    {items?.length === 0 && <p className="chat-library-empty" role="status">{t('资料库还是空的。请先在「资料库」保存页面或添加链接，再来提问。')}</p>}
  </>;

  return <section className="chat-panel" aria-label={t('对话查询')}>
    <div className="chat-toolbar">
      <label className="chat-session-picker"><History size={15} aria-hidden="true" /><span className="sr-only">{t('选择对话')}</span><select aria-label={t('选择对话')} value={selectedId ?? ''} disabled={!initialized || creating || deleting} onChange={event => select(event.target.value || null)}>
        {!selectedId && <option value="">{sessions?.length ? t('选择对话') : t('还没有对话')}</option>}
        {selectedId && !selected && <option value={selectedId}>{t('正在读取对话…')}</option>}
        {sessions?.map(session => <option key={session.id} value={session.id}>{session.status === 'idle' && session.title === '新对话' ? t('新对话') : session.title || t('新对话')}{session.status === 'running' ? t(' · 查询中') : ''}</option>)}
      </select></label>
      <Button size="sm" variant="secondary" isDisabled={!initialized || creating || deleting} onPress={() => void create()}><Plus size={15} aria-hidden="true" />{t('新对话')}</Button>
      <Button size="sm" variant="ghost" isIconOnly aria-label={t('删除对话')} isDisabled={!selected || creating || deleting} onPress={() => setDeleteTarget(selected ?? null)}><Trash2 size={15} aria-hidden="true" /></Button>
    </div>

    {!initialized || !items ? <div className="chat-loading"><Spinner label={t('正在读取本地对话…')} /></div> : selectedId ? <SessionLoader key={selectedId} sessionId={selectedId} items={items} enabled={ready} guidance={guidance} queuedText={queued?.sessionId === selectedId ? queued.text : undefined} onQueued={() => setQueued(null)} onSelect={onSelect} onMissing={() => select(null)} /> : <EmptyConversation key="new" guidance={guidance} enabled={ready} busy={creating} onSend={text => void create(text)} />}
    {deleteTarget && <Modal title={t('删除对话')} onClose={() => setDeleteTarget(null)} busy={deleting}>
      <p className="confirm-title">{deleteTarget.status === 'idle' && deleteTarget.title === '新对话' ? t('新对话') : deleteTarget.title || t('新对话')}</p><p className="muted small">{t('将删除此对话的本地消息和运行记录，无法撤销。收藏和笔记会保留。')}{deleteTarget.status === 'running' && t('正在进行的查询也会停止。')}</p>
      <div className="modal-actions"><Button size="sm" variant="secondary" isDisabled={deleting} onPress={() => setDeleteTarget(null)}>{t('取消')}</Button><Button size="sm" variant="danger" isDisabled={deleting} onPress={() => void remove()}>{deleting ? t('正在删除…') : t('确认删除')}</Button></div>
    </Modal>}
  </section>;
}

function SessionLoader({ sessionId, items, enabled, guidance, queuedText, onQueued, onSelect, onMissing }: {
  sessionId: string; items: Item[]; enabled: boolean; guidance: ReactNode; queuedText?: string; onQueued: () => void; onSelect: (id: string) => void; onMissing: () => void;
}) {
  const data = useLiveQuery(async () => {
    const [session, messages, runs] = await Promise.all([
      db.chatSessions.get(sessionId),
      db.chatMessages.where('sessionId').equals(sessionId).sortBy('sequence'),
      db.chatRuns.where('sessionId').equals(sessionId).sortBy('startedAt'),
    ]);
    return { session, messages, runs };
  }, [sessionId]);
  if (!data) return <div className="chat-loading"><Spinner label={t('正在读取消息…')} /></div>;
  if (!data.session) return <div className="chat-loading"><p>{t('此对话已被删除。')}</p><Button size="sm" variant="secondary" onPress={onMissing}>{t('返回对话')}</Button></div>;
  return <SessionConversation session={data.session} messages={data.messages} runs={data.runs} items={items} enabled={enabled} guidance={guidance} queuedText={queuedText} onQueued={onQueued} onSelect={onSelect} />;
}

function resultChunks(citations: ChatMessage['citations'], items: Map<string, Item>): ContextChunk[] {
  return citations.map(citation => {
    const id = citation.itemId;
    const item = items.get(id);
    const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
    const quote = normalize(citation.quote);
    const verified = Boolean(item && citation.contentVersion === item.contentVersion && quote
      && [item.content, item.description, item.excerpt, ...(citation.kind === 'identity' ? [item.title] : [])]
        .some(source => normalize(source).includes(quote)));
    return {
      id, title: item?.title || item?.url || '', source: item?.url || '',
      badge: citation.kind === 'identity' ? t('收藏条目') : t(SOURCES.find(source => source.value === item?.source)?.label ?? item?.source ?? ''),
      body: verified ? citation.quote : item?.description || item?.excerpt || '', missing: !item,
      reason: verified ? citation.kind === 'identity' ? t('仅用于标识收藏，不作为功能依据。') : citation.reason : '', verified, identity: citation.kind === 'identity',
    };
  });
}

function SessionConversation({ session, messages, runs, items, enabled, guidance, queuedText, onQueued, onSelect }: {
  session: ChatSession; messages: ChatMessage[]; runs: ChatRun[]; items: Item[]; enabled: boolean; guidance: ReactNode;
  queuedText?: string; onQueued: () => void; onSelect: (id: string) => void;
}) {
  const transport = useMemo(() => createChatTransport(session.id), [session.id]);
  const [initialMessages] = useState(() => toUIMessages(messages));
  const chat = useChat({ id: session.id, transport, messages: initialMessages });
  const [draft, setDraft] = useDraft(session.id);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const sending = useRef(false);
  const queuedStarted = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const positionedRun = useRef<string | undefined>(undefined);
  const initializedScroll = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const feedback = useFeedback();
  const streaming = chat.status === 'submitted' || chat.status === 'streaming';
  const pending = session.status === 'running' || streaming || submitting;
  const latestRun = runs.at(-1);
  const itemMap = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  const liveAssistant = streaming ? chat.messages.filter(message => message.role === 'assistant').at(-1) : undefined;
  const liveText = liveAssistant?.parts.filter(part => part.type === 'text').map(part => part.text).join('') ?? '';
  const pendingUser = streaming ? chat.messages.filter(message => message.role === 'user').at(-1) : undefined;
  const unsavedUser = pendingUser && !messages.some(message => message.id === pendingUser.id) ? pendingUser : undefined;
  const unsavedAssistant = liveAssistant && !messages.some(message => message.id === liveAssistant.id) ? liveAssistant : undefined;
  const persistedErrors = new Set([session.error, ...messages.map(message => message.error), ...runs.map(run => run.error)].filter(Boolean));

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (!initializedScroll.current) {
      element.scrollTop = element.scrollHeight;
      initializedScroll.current = true;
    }
    if (latestRun && positionedRun.current !== latestRun.id) {
      const message = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(node => node.dataset.messageId === latestRun.assistantMessageId);
      if (message) {
        element.scrollTop += message.getBoundingClientRect().top - element.getBoundingClientRect().top - 12;
        positionedRun.current = latestRun.id;
      }
    }
    setShowLatest(element.scrollHeight - element.scrollTop - element.clientHeight > 80);
  }, [messages, liveText, latestRun?.id, latestRun?.phase]);

  function scrollToLatest() {
    const element = scroll.current;
    if (element) { element.scrollTop = element.scrollHeight; setShowLatest(false); }
  }

  useEffect(() => {
    if (!chat.error || draft) return;
    const unsaved = chat.messages.filter(message => message.role === 'user').at(-1);
    if (unsaved && !messages.some(message => message.id === unsaved.id)) setDraft(unsaved.parts.filter(part => part.type === 'text').map(part => part.text).join(''));
  }, [chat.error, messages]);

  async function send(text: string) {
    if (!enabled || pending || sending.current || !text.trim()) return;
    sending.current = true; setSubmitting(true); feedback.dismiss(); chat.clearError(); setDraft('');
    try { await chat.sendMessage({ text: text.trim() }); }
    catch (error) { feedback.notify(errorMessage(error), 'error'); setDraft(text); }
    finally { sending.current = false; setSubmitting(false); }
  }
  useEffect(() => {
    if (!queuedText || queuedStarted.current) return;
    queuedStarted.current = true; onQueued();
    void send(queuedText);
  }, [queuedText]);

  async function retry(userMessageId: string) {
    if (!enabled || pending || sending.current) return;
    sending.current = true; setSubmitting(true); feedback.dismiss(); chat.clearError();
    try {
      chat.setMessages(toUIMessages(messages));
      await chat.regenerate({ messageId: userMessageId });
    } catch (error) { feedback.notify(errorMessage(error), 'error'); }
    finally { sending.current = false; setSubmitting(false); }
  }
  async function stop() {
    if (stopping) return;
    setStopping(true); feedback.dismiss();
    const results = await Promise.allSettled([chat.stop(), ...(session.activeRunId
      ? [request<void>({ type: 'stopChat', id: session.id, target: { runId: session.activeRunId } })] : [])]);
    for (const result of results) if (result.status === 'rejected') feedback.notify(errorMessage(result.reason), 'error');
    setStopping(false);
  }

  return <>
    <div className="chat-messages" ref={scroll} role="region" aria-label={t('对话消息')} tabIndex={0} onScroll={event => { const element = event.currentTarget; setShowLatest(element.scrollHeight - element.scrollTop - element.clientHeight > 80); }}>
      {guidance}
      {messages.length === 0 && !pending && <ChatWelcome />}
      {messages.map(message => {
        const messageRuns = runs.filter(value => value.assistantMessageId === message.id);
        const run = messageRuns.find(value => value.id === message.runId) ?? messageRuns.at(-1);
        const chunks = message.role === 'assistant' && message.status === 'completed' && (!run || run.status === 'completed') ? resultChunks(message.citations, itemMap) : [];
        const text = message.role === 'assistant' && message.status === 'running' && message.id === liveAssistant?.id && liveText.length >= message.text.length ? liveText : message.text;
        return <article key={message.id} data-message-id={message.id} className={`chat-message chat-message-${message.role}`} aria-label={message.role === 'user' ? t('我的问题') : t('查询回答')}>
          <div className="chat-message-heading"><span>{message.role === 'user' ? t('你') : 'WebsiteStars'}</span>{message.role === 'assistant' && <span className="chat-status" data-status={message.status}>{t(STATUS[message.status])}</span>}</div>
          {text ? <div className="chat-message-text">{message.role === 'assistant' ? <StreamText text={text} streaming={message.status === 'running'} /> : text}</div> : message.status === 'running' ? <p className="chat-message-placeholder">{t('正在查询收藏…')}</p> : <p className="chat-message-placeholder">{t('尚未生成回答。')}</p>}
          {chunks.length > 0 && <ContextCards chunks={chunks} onSelect={onSelect} />}
          {(message.error || run?.error) && <p className="chat-error" role="status">{translateError(message.error || run?.error)}</p>}
          {run?.steps.some(step => step.warning) && <p className="chat-retrieval-note" role="status">{[...new Set(run.steps.flatMap(step => step.warning ? [translateError(step.warning)] : []))].join(' ')}</p>}
          {messageRuns.map(value => <RunDetails key={value.id} run={value} />)}
          {message.role === 'assistant' && RETRYABLE.includes(message.status) && run?.id === latestRun?.id && message.id === messages.at(-1)?.id && run && <Button size="sm" variant="secondary" className="chat-retry" isDisabled={!enabled || pending} onPress={() => void retry(run.userMessageId)}><RotateCcw size={14} aria-hidden="true" />{t('重试')}</Button>}
        </article>;
      })}
      {unsavedUser && <article className="chat-message chat-message-user"><div className="chat-message-heading">{t('你')}</div><p className="chat-message-text">{unsavedUser.parts.filter(part => part.type === 'text').map(part => part.text).join('')}</p></article>}
      {unsavedAssistant && liveText && <article className="chat-message chat-message-assistant"><div className="chat-message-heading">WebsiteStars</div><div className="chat-message-text"><StreamText text={liveText} streaming /></div></article>}
      {pending && <div className="chat-progress"><LoadingState label={latestRun?.status === 'running' ? latestRun.phase ? t(latestRun.phase) : t('正在查询收藏…') : t('正在提交问题…')} startedAt={latestRun?.status === 'running' ? latestRun.startedAt : undefined} /></div>}
      {latestRun && !messages.some(message => message.id === latestRun.assistantMessageId) && <>
        {latestRun.error && <p className="chat-error" role="status">{translateError(latestRun.error)}</p>}
        <RunDetails run={latestRun} />
      </>}
      {session.error && !messages.some(message => message.error === session.error) && !runs.some(run => run.error === session.error) && <p className="chat-error" role="status">{translateError(session.error)}</p>}
      {chat.error && !persistedErrors.has(chat.error.message) && <p className="chat-error" role="alert">{errorMessage(chat.error)}</p>}
      {latestRun && RETRYABLE.includes(latestRun.status) && !messages.some(message => message.role === 'assistant' && message.runId === latestRun.id && RETRYABLE.includes(message.status)) && <Button size="sm" variant="secondary" isDisabled={!enabled || pending} onPress={() => void retry(latestRun.userMessageId)}><RotateCcw size={14} aria-hidden="true" />{t('重试')}</Button>}
      <Feedback notice={feedback.notice} onDismiss={feedback.dismiss} />
    </div>
    {showLatest && <Button size="sm" variant="secondary" className="chat-latest" onPress={scrollToLatest}>{t('查看最新内容')}</Button>}
    <Composer draft={draft} onChange={setDraft} enabled={enabled} pending={pending} stopping={stopping} onSend={() => void send(draft)} onStop={() => void stop()} />
  </>;
}

function RunDetails({ run }: { run: ChatRun }) {
  return <details className="chat-run"><summary><History size={13} aria-hidden="true" />{t('运行记录 · {status}', { status: t(STATUS[run.status]) })}{run.steps.length > 0 ? t(' · {count} 步', { count: run.steps.length.toLocaleString(getLocale()) }) : ''}</summary><div className="chat-run-body">
    <p>{run.phase ? t(run.phase) : t(STATUS[run.status])}</p>
    {run.steps.some(step => step.retrievalMode) && <p>{t('检索方式：{modes}', { modes: [...new Set(run.steps.flatMap(step => step.retrievalMode ? [{ lexical: t('关键词'), hybrid: t('关键词 + 语义向量'), fallback: t('关键词（语义暂不可用）') }[step.retrievalMode]] : []))].join(getLocale() === 'zh-CN' ? '、' : ', ') })}</p>}
    {run.steps.length > 0 && <ToolChips steps={run.steps.map((step, index) => ({ id: `${step.at}-${index}`, tool: step.tool, label: step.label ? t(step.label) : step.tool, durationMs: step.durationMs, resultCount: step.resultIds.length }))} />}
    <p className="chat-run-meta">{run.model} · {formatDate(run.startedAt)}{run.inputTokens !== undefined ? t(' · 输入 {count} tokens', { count: run.inputTokens.toLocaleString(getLocale()) }) : ''}{run.outputTokens !== undefined ? t(' · 输出 {count} tokens', { count: run.outputTokens.toLocaleString(getLocale()) }) : ''}</p>
    <p className="chat-run-meta">{t('对话与运行记录仅保存在此浏览器。')}</p>
  </div></details>;
}

function ChatWelcome() {
  return <div className="chat-welcome"><span className="chat-welcome-icon"><MessageSquare size={25} strokeWidth={1.5} aria-hidden="true" /></span><div className="chat-welcome-eyebrow">{t('WebsiteStars · 你的收藏助手')}</div><h2>{t('从收藏里，找回你需要的资料')}</h2><p>{t('描述用途、主题或记得的细节，')}<br />{t('回答会附上资料库中的引用。')}</p><div className="chat-example"><span>{t('试着问')}</span><p>{t('我收藏过哪些适合做知识库的开源项目？')}</p></div><p className="chat-local-note">{t('对话和运行记录仅保存在此浏览器。')}</p></div>;
}

function EmptyConversation({ enabled, busy, guidance, onSend }: { enabled: boolean; busy: boolean; guidance: ReactNode; onSend: (text: string) => void }) {
  const [draft, setDraft] = useDraft(null);
  return <><div className="chat-messages">{guidance}<ChatWelcome /></div><Composer draft={draft} onChange={setDraft} enabled={enabled} pending={false} submitting={busy} onSend={() => onSend(draft)} /></>;
}

function Composer({ draft, onChange, enabled, pending, stopping = false, submitting = false, onSend, onStop }: {
  draft: string; onChange: (value: string) => void; enabled: boolean; pending: boolean; stopping?: boolean; submitting?: boolean; onSend: () => void; onStop?: () => void;
}) {
  const composing = useRef(false);
  function submit(event: FormEvent) { event.preventDefault(); if (enabled && !pending && !submitting && draft.trim()) onSend(); }
  return <form className="chat-composer" onSubmit={submit}>
    <p className="chat-privacy" id="chat-send-disclosure"><ShieldCheck size={14} aria-hidden="true" /><span>{t('发送后，问题、近期问题和候选来源片段会发送到你配置的模型服务。私人笔记和单独保存的划词不会发送；正文片段可能包含相同文字。')}</span></p>
    <ChatComposer input={{ rows: 3, 'aria-label': t('描述你想找的资料'), 'aria-describedby': 'chat-send-disclosure', placeholder: t('描述你想找的资料…'), value: draft, onChange: event => onChange(event.target.value), maxLength: 4000, onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; }, onKeyDown: event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
    } }} actions={<><span>{t('Enter 发送 · Shift + Enter 换行')}</span>{pending ? <button className="beautiful-send beautiful-stop" type="button" aria-label={t('停止查询')} disabled={stopping} onClick={onStop}><Square size={13} aria-hidden="true" />{stopping ? t('正在停止…') : t('停止查询')}</button> : <button className="beautiful-send" type="submit" aria-label={t('发送')} disabled={!enabled || submitting || !draft.trim()}><ArrowUp size={15} aria-hidden="true" />{submitting ? t('正在创建…') : t('发送')}</button>}</>} />
  </form>;
}
