// Adapted from Beautiful UI (MIT), Copyright (c) 2026 Shane Levine.
// Sources and local changes: ../../THIRD_PARTY_NOTICES.md.
import { useEffect, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { BookOpen, Check, ChevronDown, ChevronRight, ExternalLink, Search } from 'lucide-react';
import { getLocale, t } from '../../lib/i18n';
import { Markdown } from '../Markdown';

// components/primitives/LoadingState.tsx: Drive grid and elapsed label.
const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3), c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

export function LoadingState({ label, startedAt }: { label: string; startedAt?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const elapsed = seconds < 60 ? t('{seconds} 秒', { seconds: seconds.toLocaleString(getLocale()) }) : t('{minutes} 分 {seconds} 秒', { minutes: Math.floor(seconds / 60).toLocaleString(getLocale()), seconds: (seconds % 60).toLocaleString(getLocale()) });
  return <div className="beautiful-loading">
    <span aria-hidden="true" className="beautiful-loader-grid">{chevron.map((delay, index) => <span key={index} style={{ animationDelay: `${delay}ms` }} />)}</span>
    <span className="beautiful-loading-label" role="status">{label}</span>
    {Number.isFinite(start) && <span className="beautiful-elapsed" role="timer" aria-label={t('已耗时 {elapsed}', { elapsed })}>{elapsed}</span>}
  </div>;
}

// components/atoms/StreamText.tsx: accumulated Markdown and a separate streaming caret.
export function StreamText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <div className="beautiful-stream-text">
    <Markdown text={text} mode="chat" />
    {streaming && <span aria-hidden="true" className="beautiful-stream-caret" />}
  </div>;
}

// components/primitives/ChatComposer.tsx: controlled input and inset action bar.
export function ChatComposer({ input, actions }: { input: TextareaHTMLAttributes<HTMLTextAreaElement>; actions: ReactNode }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  return <div className="beautiful-composer-field" onClick={event => { if (event.target === event.currentTarget) inputRef.current?.focus(); }}>
    <textarea {...input} ref={inputRef} />
    <div className="chat-composer-actions">{actions}</div>
  </div>;
}

export interface ContextChunk {
  id: string; title: string; body: string; source: string; badge: string; reason?: string; verified: boolean; identity?: boolean; missing?: boolean;
}

function sourceUrl(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}

// components/primitives/ContextCards.tsx: selected citation header, body, and source chip.
export function ContextCards({ chunks, onSelect }: { chunks: ContextChunk[]; onSelect: (id: string) => void }) {
  return <section className="beautiful-context" aria-label={t('本次结果 · {count} 条', { count: chunks.length.toLocaleString(getLocale()) })}>
    <div className="beautiful-context-heading"><span>{t('本次结果')}</span><span className="beautiful-count">{chunks.length.toLocaleString(getLocale())}</span></div>
    {chunks.some(chunk => !chunk.verified && !chunk.missing) && <p className="chat-context-note">{t('部分来源已变更，显示当前收藏内容，可打开收藏重新确认。')}</p>}
    <div className="chat-citations">{chunks.map((chunk, index) => {
      const href = sourceUrl(chunk.source);
      return chunk.missing
        ? <p key={chunk.id} className="chat-citation-missing">{t('收藏 {number} 已删除或不可用', { number: (index + 1).toLocaleString(getLocale()) })}</p>
        : <div key={chunk.id} className="chat-result-card" data-verification={chunk.verified ? 'verified' : 'changed'}>
          <button type="button" className="chat-citation" aria-label={chunk.verified ? t('查看引用：{title}', { title: chunk.title }) : t('查看收藏：{title}', { title: chunk.title })} onClick={() => onSelect(chunk.id)}>
            <span className="beautiful-context-bar"><BookOpen size={13} aria-hidden="true" /><strong>{chunk.title}</strong><ChevronRight size={13} aria-hidden="true" /></span>
            <span className="chat-citation-content">
              <span className="chat-evidence-status">{!chunk.verified ? t('来源已变更') : chunk.identity ? t('仅确认收藏身份') : t('已核验引用')}</span>
              {chunk.body && <span className="chat-citation-quote">{chunk.body}</span>}
              {chunk.reason && <span>{chunk.reason}</span>}
              <span className="beautiful-source-chip"><span>{chunk.badge}</span><span>{chunk.source}</span></span>
            </span>
          </button>
          {href && <a className="chat-source-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={t('打开原网页：{title}', { title: chunk.title })}>{t('打开原网页')}<ExternalLink size={12} aria-hidden="true" /></a>}
        </div>;
    })}</div>
  </section>;
}

export interface ToolStep {
  id: string; tool: string; label: string; durationMs: number; resultCount: number;
}

// components/primitives/ToolChips.tsx: expandable rows and tool chips, without timed demo reveals.
export function ToolChips({ steps }: { steps: ToolStep[] }) {
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const toggleRow = (id: string) => setOpenRows(current => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  return <div className="beautiful-tool-chips">{steps.map(row => {
    const rowOpen = openRows.has(row.id);
    return <div key={row.id} className="beautiful-tool-row">
      <button type="button" aria-expanded={rowOpen} onClick={() => toggleRow(row.id)}>
        {row.tool === 'search_library' ? <Search size={13} aria-hidden="true" /> : row.tool === 'read_item' ? <BookOpen size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
        <span className="beautiful-tool-label">{row.label}</span><span className="beautiful-tool-chip">{t('{duration} ms', { duration: row.durationMs.toLocaleString(getLocale()) })}</span><ChevronDown className={rowOpen ? 'is-open' : ''} size={12} aria-hidden="true" />
      </button>
      {rowOpen && <div className="beautiful-tool-detail"><span>{row.tool}</span>{row.resultCount > 0 && <span>{t('{count} 条资料', { count: row.resultCount.toLocaleString(getLocale()) })}</span>}</div>}
    </div>;
  })}</div>;
}
