import { cloneElement, Component, useId, useState, type ReactElement, type ReactNode } from 'react';
import { Button, Description, Modal as HeroModal, Switch } from '@heroui/react';
import { AlertCircle, CheckCircle2, Info, LoaderCircle, X } from 'lucide-react';
import { getLocale, t, translateError } from '../lib/i18n';

export function errorMessage(error: unknown) {
  return translateError(error);
}

export function Brand() {
  return <div className="brand"><img className="brand-mark" src="/icon/icon.svg" width="30" height="30" alt="WebsiteStars" /><span aria-hidden="true">WebsiteStars</span></div>;
}

export function Spinner({ label = t('正在加载…') }: { label?: string }) {
  return <span className="loading-inline" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" />{label}</span>;
}

export type Notice = { tone: 'success' | 'error' | 'info'; text: string } | null;

export function Feedback({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
  const Icon = notice?.tone === 'error' ? AlertCircle : notice?.tone === 'info' ? Info : CheckCircle2;
  return <div className="feedback-region" aria-live="polite" aria-atomic="true">{notice && <div className={`feedback feedback-${notice.tone}`}>
    <Icon size={17} aria-hidden="true" /><span>{notice.text}</span>
    {onDismiss && <Button isIconOnly size="sm" variant="ghost" aria-label={t('关闭提示')} onPress={onDismiss}><X size={15} /></Button>}
  </div>}</div>;
}

export function useFeedback() {
  const [notice, setNotice] = useState<Notice>(null);
  return { notice, dismiss: () => setNotice(null), notify: (text: string, tone: 'success' | 'error' | 'info' = 'success') => setNotice({ text, tone }) };
}

export function Modal({ title, children, onClose, variant = '', busy = false }: {
  title: string; children: ReactNode; onClose: () => void; variant?: string; busy?: boolean;
}) {
  return <HeroModal.Backdrop isOpen isDismissable={!busy} isKeyboardDismissDisabled={busy} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <HeroModal.Container size={variant === 'detail-drawer' ? 'lg' : 'sm'} placement="center" scroll="inside">
      <HeroModal.Dialog className={`app-dialog ${variant}`}>
        <HeroModal.Header className="app-dialog-heading">
          <HeroModal.Heading>{title}</HeroModal.Heading>
          <Button isIconOnly size="sm" variant="ghost" isDisabled={busy} onPress={onClose} aria-label={t('关闭弹窗')}><X size={18} /></Button>
        </HeroModal.Header>
        <HeroModal.Body className="app-dialog-body">{children}</HeroModal.Body>
      </HeroModal.Dialog>
    </HeroModal.Container>
  </HeroModal.Backdrop>;
}

export function Field({ label, hint, children, className = '' }: {
  label: string; hint?: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string }>; className?: string;
}) {
  const id = useId();
  return <div className={`app-field ${className}`}><label className="field-label" htmlFor={id}>{label}</label>{cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}{hint && <span id={`${id}-hint`} className="field-hint">{hint}</span>}</div>;
}

export function PreferenceSwitch({ label, hint, selected, disabled, onChange }: {
  label: string; hint: string; selected: boolean; disabled?: boolean; onChange: (selected: boolean) => void;
}) {
  return <Switch className="preference-switch" aria-label={label} isSelected={selected} isDisabled={disabled} onChange={onChange}>
    <Switch.Content className="preference-content"><span>{label}</span><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
    <Description className="preference-description">{hint}</Description>
  </Switch>;
}

export function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t('日期未知') : new Intl.DateTimeFormat(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

export function safeUrl(value: string) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}

export class AppBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: errorMessage(error) }; }
  override render() {
    if (this.state.error) return <main className="fatal-state"><Brand /><AlertCircle size={32} aria-hidden="true" /><h1>{t('暂时无法载入页面')}</h1><p role="alert">{this.state.error}</p><Button onPress={() => window.location.reload()}>{t('重新加载')}</Button></main>;
    return this.props.children;
  }
}
