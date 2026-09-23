import { browser } from 'wxt/browser';
import { getLocale, t, translateError } from '../lib/i18n';
import { parseGithubRepo } from '../lib/urls';
import type { Item, Reply } from '../lib/types';

type SaveState = { status: 'idle' | 'saving' | 'saved' | 'error'; message?: string };
type Placement = { after: Element; url: string; page?: string };

function repositoryUrl(value: string): string | undefined {
  const repo = parseGithubRepo(value);
  return repo ? `https://github.com/${repo.owner}/${repo.repo}` : undefined;
}

function starControl(scope: Element, url: string): Element | undefined {
  return [...scope.querySelectorAll('button, a.btn, a.Button, a[role="button"]')].find(control => {
    if (control.closest('[data-starts-slot]')) return false;
    const form = control.closest('form');
    if (form) {
      const action = new URL(form.action, location.href);
      if (/\/(?:un)?star\/?$/u.test(action.pathname)) {
        action.pathname = action.pathname.replace(/\/(?:un)?star\/?$/u, '');
        return repositoryUrl(action.href)?.toLowerCase() === url.toLowerCase();
      }
    }
    const label = control.getAttribute('aria-label') ?? control.textContent ?? '';
    if (!control.querySelector('.octicon-star, .octicon-star-fill') && !/^(?:unstar|starred|star)\b|signed in to star/iu.test(label.trim())) return false;
    if (control instanceof HTMLAnchorElement) {
      const href = new URL(control.href, location.href);
      const target = href.searchParams.get('return_to');
      const repo = repositoryUrl(target ? new URL(target, location.origin).href : href.href);
      if (repo && repo.toLowerCase() !== url.toLowerCase()) return false;
      if (/\/(?:stargazers|forks)\/?$/u.test(href.pathname)) return false;
    }
    return true;
  });
}

function starBoundary(control: Element, scope: Element): Element {
  let boundary = control;
  for (let parent = control.parentElement; parent && parent !== scope; parent = parent.parentElement) {
    if (parent.matches('form, .BtnGroup, .js-toggler-container, .starring-container, .js-star-toggle-container, [data-testid="star-button-container"]')) boundary = parent;
    if (parent.matches('li') && parent.parentElement?.matches('ul, ol')) { boundary = parent; break; }
  }
  // GitHub tooltips remain beside their original trigger or form.
  while (boundary.nextElementSibling?.matches('tool-tip')) boundary = boundary.nextElementSibling;
  return boundary;
}

const buttonStyles = `
[data-starts-slot] { display: inline-flex; align-items: center; vertical-align: middle; margin-inline-start: 8px; }
[data-starts-slot] .starts-save.btn { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; color: var(--button-default-fgColor-rest, var(--color-btn-text)); background-color: var(--button-default-bgColor-rest, var(--color-btn-bg)); border-color: var(--button-default-borderColor-rest, var(--color-btn-border)); }
[data-starts-slot] .starts-save.btn:hover:not(:disabled) { background-color: var(--button-default-bgColor-hover, var(--color-btn-hover-bg)); border-color: var(--button-default-borderColor-hover, var(--color-btn-hover-border)); }
[data-starts-slot] .starts-save.btn:focus-visible { outline: 2px solid var(--focus-outlineColor, var(--color-accent-fg)); outline-offset: 2px; }
[data-starts-slot] .starts-save[data-state="saved"] { color: var(--fgColor-success, var(--color-success-fg)); }
[data-starts-slot] .starts-save[data-state="error"] { color: var(--fgColor-danger, var(--color-danger-fg)); }
[data-starts-slot] .starts-save:disabled { cursor: wait; }
[data-starts-slot] .octicon { flex-shrink: 0; fill: currentColor; }
[data-starts-slot] .starts-save-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
`;

export default defineContentScript({
  matches: ['https://github.com/*'],
  main(ctx) {
    const states = new Map<string, SaveState>();
    const style = document.createElement('style');
    style.textContent = buttonStyles;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function render(slot: Element, state: SaveState) {
      const button = slot.querySelector<HTMLButtonElement>('[data-starts-save]')!;
      const label = button.querySelector('span')!;
      button.dataset.state = state.status;
      button.disabled = state.status === 'saving';
      button.setAttribute('aria-busy', String(state.status === 'saving'));
      label.textContent = { idle: t('收藏到 WebsiteStars'), saving: t('保存中…'), saved: t('已收藏到 WebsiteStars'), error: t('收藏失败，重试') }[state.status];
      button.title = state.message ?? t('保存到 WebsiteStars');
      slot.querySelector('[role="status"]')!.textContent = state.message ?? '';
    }

    function setState(url: string, state: SaveState) {
      states.set(url.toLowerCase(), state);
      document.querySelectorAll<HTMLElement>('[data-starts-slot]').forEach(slot => {
        if (slot.dataset.startsSlot?.toLowerCase() === url.toLowerCase()) render(slot, state);
      });
    }

    function createSlot(placement: Placement): HTMLElement {
      const slot = document.createElement(placement.after.parentElement?.matches('ul, ol') ? 'li' : 'span');
      slot.dataset.startsSlot = placement.url;
      slot.lang = getLocale();
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm starts-save';
      button.dataset.startsSave = placement.url;
      if (placement.page) button.dataset.startsPage = placement.page;
      button.setAttribute('aria-label', t('收藏 {repo} 到 WebsiteStars', { repo: parseGithubRepo(placement.url)?.repo ?? t('仓库') }));
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'octicon octicon-bookmark');
      icon.setAttribute('viewBox', '0 0 16 16');
      icon.setAttribute('width', '16'); icon.setAttribute('height', '16');
      icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M3.75 0h8.5C13.216 0 14 .784 14 1.75v13.5a.75.75 0 0 1-1.206.596L8 12.18l-4.794 3.666A.75.75 0 0 1 2 15.25V1.75C2 .784 2.784 0 3.75 0Zm-.25 1.75v11.982l4.044-3.092a.75.75 0 0 1 .912 0l4.044 3.092V1.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Z');
      icon.append(path);
      button.append(icon, document.createElement('span'));
      const status = document.createElement('span');
      status.id = `starts-save-status-${++sequence}`;
      status.className = 'starts-save-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
      button.setAttribute('aria-describedby', status.id);
      slot.append(button, status);
      render(slot, states.get(placement.url.toLowerCase()) ?? { status: 'idle' });
      button.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation();
        if (states.get(placement.url.toLowerCase())?.status === 'saving') return;
        setState(placement.url, { status: 'saving', message: t('正在保存到 WebsiteStars…') });
        try {
          const result = await browser.runtime.sendMessage({ type: 'saveGithub', url: placement.url }) as Reply<{ item: Item; created: boolean }>;
          if (!result?.ok) throw new Error(result && !result.ok ? result.error : t('扩展暂不可用'));
          if (ctx.isInvalid) return;
          setState(placement.url, { status: 'saved', message: result.data.created ? t('已收藏到 WebsiteStars。') : t('已在 WebsiteStars 收藏中，保留已有内容。') });
        } catch (error) {
          if (ctx.isInvalid) return;
          const message = error instanceof Error ? translateError(error) : t('扩展暂不可用');
          setState(placement.url, { status: 'error', message: t('收藏失败：{message}。点击重试。', { message }) });
        }
      });
      return slot;
    }

    function placements(): Placement[] {
      const result: Placement[] = [];
      const pageUrl = new URL(location.href);
      const starsPage = (/^\/[^/]+\/?$/u.test(pageUrl.pathname) && pageUrl.searchParams.get('tab') === 'stars')
        || /^\/(?:stars(?:\/|$)|[^/]+\/stars\/?$)/u.test(pageUrl.pathname);
      if (starsPage) {
        document.querySelectorAll<HTMLAnchorElement>('h3 a[href]').forEach(link => {
          const url = repositoryUrl(link.href);
          if (!url) return;
          for (let row = link.closest('h3')?.parentElement; row && !row.matches('main, body'); row = row.parentElement) {
            if (row.querySelectorAll('h3').length > 1) break;
            const control = starControl(row, url);
            if (control) { result.push({ after: starBoundary(control, row), url }); break; }
          }
        });
      } else {
        const url = repositoryUrl(location.href);
        if (!url) return result;
        document.querySelectorAll('#repository-container-header, [data-testid="repository-header"]').forEach(header => {
          const name = header.querySelector<HTMLAnchorElement>('[itemprop="name"] a[href]');
          if (name && repositoryUrl(name.href)?.toLowerCase() !== url.toLowerCase()) return;
          header.querySelectorAll('.pagehead-actions, [data-testid="repository-actions"]').forEach(actions => {
            const control = starControl(actions, url);
            if (control) result.push({ after: starBoundary(control, actions), url, page: location.pathname });
          });
        });
      }
      return result;
    }

    function update() {
      clearTimeout(timer); timer = undefined;
      if (ctx.isInvalid) return;
      observer.disconnect();
      try {
        if (!style.isConnected) document.head.append(style);
        const keep = new Set<Element>();
        for (const placement of placements()) {
          const sibling = placement.after.nextElementSibling;
          const slot = sibling instanceof HTMLElement && sibling.dataset.startsSlot === placement.url ? sibling : createSlot(placement);
          if (slot !== sibling) placement.after.after(slot);
          const button = slot.querySelector<HTMLElement>('[data-starts-save]');
          if (button && placement.page) button.dataset.startsPage = placement.page;
          keep.add(slot);
        }
        document.querySelectorAll('[data-starts-slot]').forEach(slot => { if (!keep.has(slot)) slot.remove(); });
      } finally {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }

    function schedule() {
      if (timer === undefined && !ctx.isInvalid) timer = setTimeout(update, 100);
    }

    const observer = new MutationObserver(records => {
      const externalChange = records.some(record => {
        if (record.target instanceof Element && record.target.closest('[data-starts-slot]')) return false;
        return [...record.addedNodes, ...record.removedNodes].some(node => !(node instanceof Element && node.matches('[data-starts-slot]')));
      });
      if (externalChange) schedule();
    });

    function clearSlots() {
      clearTimeout(timer); timer = undefined;
      document.querySelectorAll('[data-starts-slot]').forEach(slot => slot.remove());
    }

    ctx.addEventListener(window, 'wxt:locationchange', update);
    ctx.addEventListener(window, 'popstate', schedule);
    for (const event of ['turbo:load', 'turbo:render', 'turbo:frame-load', 'pjax:end']) ctx.addEventListener(document, event, schedule);
    for (const event of ['turbo:before-cache', 'turbo:before-render']) ctx.addEventListener(document, event, clearSlots);
    ctx.onInvalidated(() => { observer.disconnect(); clearSlots(); style.remove(); });
    update();
  },
});
