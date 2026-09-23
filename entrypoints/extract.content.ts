import { Readability } from '@mozilla/readability';
import { browser } from 'wxt/browser';
import type { Capture } from '../lib/types';

export default defineContentScript({
  registration: 'runtime',
  main() {
    const marker = '__startsExtractor';
    const state = globalThis as typeof globalThis & { __startsExtractor?: boolean };
    if (state[marker]) return;
    state[marker] = true;
    browser.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender.id !== browser.runtime.id || message?.type !== 'extractPage') return;
      const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"],meta[property="${name}"]`)?.content ?? '';
      const selection = window.getSelection()?.toString().slice(0, 20000) ?? '';
      const clone = document.cloneNode(true) as Document;
      clone.querySelectorAll('script,style,noscript,form,input,textarea,select,[contenteditable],nav,footer').forEach(node => node.remove());
      let article: ReturnType<Readability['parse']> = null;
      try { article = new Readability(clone).parse(); } catch { /* Fall back to page metadata. */ }
      const content = article?.textContent?.trim() ?? '';
      const description = (meta('description') || meta('og:description') || article?.excerpt || '').slice(0, 10000);
      const keywords = meta('keywords').split(/[,，]/).map(s => s.trim()).filter(Boolean).slice(0, 20);
      const capture: Capture = {
        url: location.href, canonicalUrl: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
        title: (article?.title || meta('og:title') || document.title).slice(0, 1000),
        description, excerpt: (article?.excerpt || content.slice(0, 1200) || description).slice(0, 1200),
        content: content.slice(0, 100000), truncated: content.length > 100000,
        source: /(^|\.)docs\.|\/docs?(\/|$)|\/documentation(\/|$)/i.test(location.hostname + location.pathname) ? 'docs' : 'article',
        author: (article?.byline || meta('author')).slice(0, 1000), publishedAt: meta('article:published_time').slice(0, 100),
        selection, tags: keywords.slice(0, 8), keywords,
      };
      reply(capture);
    });
  },
});
