import { t } from '../lib/i18n';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './markdown.css';

interface MarkdownProps {
  text: string;
  mode: 'chat' | 'readme';
  baseUrl?: string;
}

function safeMarkdownUrl(value: string, baseUrl?: string, image = false): string | undefined {
  if (!value) return;
  try {
    if (/[\u0000-\u001f\u007f-\u009f]/.test(value) || /[\u0000-\u001f\u007f-\u009f]/.test(decodeURIComponent(value))) return;
    const url = new URL(value, baseUrl);
    if (url.username || url.password || !['https:', 'http:', ...(image ? [] : ['mailto:'])].includes(url.protocol)) return;
    return url.href;
  } catch { return; }
}

function imageUrl(value: string): string {
  const url = new URL(value);
  // GitHub blob pages are HTML; images need the corresponding raw resource.
  if (url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/blob\//.test(url.pathname)) {
    url.hostname = 'raw.githubusercontent.com';
    url.pathname = url.pathname.replace(/^\/([^/]+)\/([^/]+)\/blob\//, '/$1/$2/');
  }
  return url.href;
}

function ReadmeImage({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return <span className="markdown-image">
    {loaded && !failed
      ? <img src={imageUrl(src)} alt={alt} title={title} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <span className="markdown-image-placeholder">{alt || t('README 图片')}<button type="button" onClick={() => { setFailed(false); setLoaded(true); }}>{failed ? t('重试加载图片') : t('加载图片')}</button></span>}
    <a href={src} target="_blank" rel="noopener noreferrer">{failed ? t('图片加载失败，打开图片链接') : t('打开图片链接')}</a>
  </span>;
}

export function Markdown({ text, mode, baseUrl }: MarkdownProps) {
  return <div className={`markdown-body markdown-${mode}`}>
    <ReactMarkdown remarkPlugins={[remarkGfm]}
      urlTransform={(value, key) => mode === 'chat' ? '' : safeMarkdownUrl(value, baseUrl, key === 'src') || ''}
      components={{
        a: ({ href, children, node }) => {
          if (mode === 'chat' || !href) return <>{children}</>;
          // Image controls must not be nested inside another interactive link.
          const hasImage = (entry: typeof node): boolean => Boolean(entry?.children.some(child => child.type === 'element' && (child.tagName === 'img' || hasImage(child))));
          if (hasImage(node)) return <span>{children} <a href={href} target="_blank" rel="noopener noreferrer">{t('打开链接')}</a></span>;
          return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
        },
        img: ({ src, alt, title }) => mode === 'readme' && typeof src === 'string' && src
          ? <ReadmeImage key={src} src={src} alt={alt || ''} title={title} />
          : <span className="markdown-image-label">{alt || t('图片')}</span>,
        pre: ({ children }) => <pre tabIndex={0} aria-label={t('代码块，可横向滚动')}>{children}</pre>,
        table: ({ children }) => <div className="markdown-table-scroll" role="region" aria-label={t('表格，可横向滚动')} tabIndex={0}><table>{children}</table></div>,
      }}
    >{text}</ReactMarkdown>
  </div>;
}
