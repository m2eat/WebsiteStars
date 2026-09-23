import { browser } from 'wxt/browser';
import { getLocale, t, translateError } from '../lib/i18n';
import type { Reply } from '../lib/types';

const bookmark = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="M9 10h6m-3-3v6"/></svg>';
const check = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
const buttonSize = 44;
const handleWidth = 22;
const edgeGap = 16;
const dragThreshold = 6;
const snapDistance = 24;
const moveHint = t('拖动调整位置 · Alt + 方向键移动');
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
type Edge = 'left' | 'right';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  excludeMatches: ['*://github.com/*', '*://www.github.com/*', 'https://chromewebstore.google.com/*'],
  main(ctx) {
    if (window.top !== window || !document.documentElement || document.contentType !== 'text/html') return;
    const host = document.createElement('starts-save-widget');
    host.setAttribute('data-starts-widget', '');
    host.lang = getLocale();
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { all: initial; position: fixed; display: block; width: 44px; height: 44px; z-index: 2147483600; color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .wrap { position: relative; width: 100%; height: 44px; user-select: none; -webkit-user-select: none; }
      button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; justify-content: center; align-items: center; color: #fff; background: #2563eb; border: 1px solid #1d4ed8; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      button:focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }
      .save { width: 44px; height: 44px; border-radius: 14px; box-shadow: 0 3px 14px #1e40af55; touch-action: none; transition: background .15s; }
      .save:hover, .expand:hover { background: #1d4ed8; }
      .save[data-saved], .expand[data-saved] { background: #15803d; border-color: #166534; }
      .save[data-saved]:hover, .expand[data-saved]:hover { background: #166534; }
      .save[data-dragging] { cursor: grabbing; }
      .save:disabled { cursor: wait; }
      .hide { position: absolute; top: -8px; right: -8px; width: 20px; height: 20px; border-radius: 50%; color: #1d4ed8; background: #fff; border-color: #93c5fd; box-shadow: 0 1px 5px #0003; font-size: 17px; }
      .expand { width: 22px; height: 44px; border-radius: 10px 0 0 10px; box-shadow: 0 2px 10px #1e40af44; }
      .wrap[data-edge="left"] .expand { border-radius: 0 10px 10px 0; }
      .wrap[data-edge="left"] .expand svg { transform: rotate(180deg); }
      .status { position: fixed; width: max-content; padding: 9px 12px; background: #18181b; color: white; border-radius: 9px; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; box-shadow: 0 2px 10px #0003; pointer-events: none; }
      .status:empty { display: none; }
      @media (prefers-reduced-motion: reduce) { .save { transition: none; } }
    </style><div class="wrap"><span class="status" role="status" aria-live="polite"></span><button class="save" type="button" aria-label="${t('收藏当前网页到 WebsiteStars')}" aria-description="${t('拖动调整位置，或按 Alt + 方向键移动。')}" title="${t('收藏到 WebsiteStars · {hint}', { hint: moveHint })}">${bookmark}</button><button class="hide" type="button" aria-label="${t('收起到侧边')}" title="${t('收起到侧边')}">−</button><button class="expand" type="button" aria-label="${t('展开收藏按钮')}" title="${t('展开收藏按钮')}" hidden><svg xmlns="http://www.w3.org/2000/svg" width="16" height="20" viewBox="0 0 16 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 5-5 5 5 5"/></svg></button></div>`;
    const wrap = root.querySelector<HTMLElement>('.wrap')!;
    const save = root.querySelector<HTMLButtonElement>('.save')!;
    const collapse = root.querySelector<HTMLButtonElement>('.hide')!;
    const expand = root.querySelector<HTMLButtonElement>('.expand')!;
    const status = root.querySelector<HTMLElement>('.status')!;
    let enabled = false;
    let collapsed = false;
    let edge: Edge | undefined = 'right';
    let position: { x: number; y: number } | undefined;
    let drag: { pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | undefined;
    let suppressClick = false;
    let pending = false;
    let lastUrl = location.href;
    let pageVersion = 0;
    let captureVersion = 0;
    let stateVersion = 0;
    let preferenceVersion = 0;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    let navigationTimer: ReturnType<typeof setTimeout> | undefined;

    const viewport = () => {
      const visual = window.visualViewport;
      return {
        left: visual?.offsetLeft ?? 0,
        top: visual?.offsetTop ?? 0,
        width: visual?.width ?? document.documentElement.clientWidth,
        height: visual?.height ?? document.documentElement.clientHeight,
      };
    };
    const bounds = () => {
      const view = viewport();
      const gapX = Math.min(edgeGap, Math.max(0, (view.width - buttonSize) / 2));
      const gapY = Math.min(edgeGap, Math.max(0, (view.height - buttonSize) / 2));
      return {
        minX: view.left + gapX,
        maxX: view.left + view.width - buttonSize - gapX,
        minY: view.top + gapY,
        maxY: view.top + view.height - buttonSize - gapY,
      };
    };
    const placeStatus = () => {
      if (!position || !status.textContent || !host.isConnected || collapsed) return;
      const view = viewport();
      status.style.maxWidth = `${Math.max(0, Math.min(260, view.width - 24))}px`;
      const width = status.offsetWidth;
      const height = status.offsetHeight;
      const x = position.x - width - 10 >= view.left + 12 ? position.x - width - 10 : position.x + buttonSize + 10;
      status.style.left = `${clamp(x, view.left + 12, view.left + view.width - width - 12)}px`;
      status.style.top = `${clamp(position.y, view.top + 12, view.top + view.height - height - 12)}px`;
    };
    const place = () => {
      const view = viewport();
      const limits = bounds();
      position ??= { x: limits.maxX, y: view.top + view.height - buttonSize - 88 };
      if (collapsed) {
        position.x = edge === 'left' ? view.left : view.left + Math.max(0, view.width - handleWidth);
      } else if (edge) {
        position.x = edge === 'left' ? limits.minX : limits.maxX;
      }
      if (!collapsed) position.x = clamp(position.x, limits.minX, limits.maxX);
      position.y = clamp(position.y, limits.minY, limits.maxY);
      host.style.left = `${position.x}px`;
      host.style.top = `${position.y}px`;
      host.style.width = `${collapsed ? handleWidth : buttonSize}px`;
      wrap.dataset.edge = edge ?? '';
      save.hidden = collapsed;
      collapse.hidden = collapsed;
      expand.hidden = !collapsed;
      status.hidden = collapsed;
      placeStatus();
    };
    const snap = () => {
      if (!position) return;
      const limits = bounds();
      const leftDistance = Math.abs(position.x - limits.minX);
      const rightDistance = Math.abs(position.x - limits.maxX);
      edge = Math.min(leftDistance, rightDistance) <= snapDistance ? (leftDistance < rightDistance ? 'left' : 'right') : undefined;
    };
    const finishDrag = (cancelled: boolean) => {
      const current = drag;
      if (!current) return;
      drag = undefined;
      save.removeAttribute('data-dragging');
      if (cancelled || current.moved) suppressClick = true;
      if (current.moved) snap();
      if (save.hasPointerCapture(current.pointerId)) save.releasePointerCapture(current.pointerId);
      place();
    };
    const renderVisibility = () => {
      if (enabled && !document.fullscreenElement && !ctx.isInvalid) {
        if (!host.isConnected) document.documentElement.append(host);
        place();
      } else {
        finishDrag(true);
        host.remove();
      }
    };
    const showStatus = (text: string) => {
      clearTimeout(statusTimer);
      status.textContent = text;
      placeStatus();
      statusTimer = setTimeout(() => { status.textContent = ''; }, 5000);
    };
    const showSaved = (saved: boolean) => {
      save.toggleAttribute('data-saved', saved);
      expand.toggleAttribute('data-saved', saved);
      save.innerHTML = saved ? check : bookmark;
      save.title = saved ? t('已收藏到 WebsiteStars · 再次点击保存划词 · {hint}', { hint: moveHint }) : t('收藏到 WebsiteStars · {hint}', { hint: moveHint });
    };
    const navigation = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      pageVersion++;
      captureVersion++;
      stateVersion++;
      pending = false;
      save.disabled = false;
      save.removeAttribute('aria-busy');
      finishDrag(true);
      clearTimeout(statusTimer);
      status.textContent = '';
      showSaved(false);
      clearTimeout(navigationTimer);
      navigationTimer = setTimeout(() => { void readState(); }, 80);
    };
    async function readState() {
      navigation();
      clearTimeout(navigationTimer);
      const url = location.href;
      const page = pageVersion;
      const request = ++stateVersion;
      const preference = preferenceVersion;
      const capture = captureVersion;
      try {
        const reply = await browser.runtime.sendMessage({ type: 'getPageState' }) as Reply<{ floatingEnabled: boolean; saved: boolean }>;
        if (reply?.ok && url === location.href && page === pageVersion && request === stateVersion && !ctx.isInvalid) {
          if (preference === preferenceVersion) enabled = reply.data.floatingEnabled;
          if (!pending && capture === captureVersion) showSaved(reply.data.saved);
          renderVisibility();
        }
      } catch {
        if (ctx.isInvalid) host.remove();
      }
    }
    const moveDrag = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < dragThreshold) return;
      drag.moved = true;
      suppressClick = true;
      save.setAttribute('data-dragging', '');
      edge = undefined;
      position = { x: drag.originX + dx, y: drag.originY + dy };
      place();
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'dblclick', 'keydown', 'keyup']) {
      root.addEventListener(type, event => { event.stopPropagation(); });
    }
    for (const button of [save, collapse, expand]) {
      button.addEventListener('pointerdown', event => { if (event.button === 0) event.preventDefault(); });
    }
    save.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || pending || drag) return;
      place();
      suppressClick = false;
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: position!.x, originY: position!.y, moved: false };
      try {
        save.setPointerCapture(event.pointerId);
      } catch {
        finishDrag(true);
      }
    });
    save.addEventListener('pointermove', moveDrag);
    save.addEventListener('pointerup', event => {
      if (event.pointerId !== drag?.pointerId) return;
      moveDrag(event);
      finishDrag(false);
    });
    for (const type of ['pointercancel', 'lostpointercapture'] as const) {
      save.addEventListener(type, event => { if (event.pointerId === drag?.pointerId) finishDrag(true); });
    }
    save.addEventListener('dragstart', event => { event.preventDefault(); });
    save.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        if (!drag) suppressClick = false;
        return;
      }
      if (!event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      finishDrag(true);
      place();
      edge = undefined;
      const step = 16;
      if (event.key === 'ArrowLeft') position!.x -= step;
      if (event.key === 'ArrowRight') position!.x += step;
      if (event.key === 'ArrowUp') position!.y -= step;
      if (event.key === 'ArrowDown') position!.y += step;
      place();
    });
    save.addEventListener('click', async event => {
      event.preventDefault();
      navigation();
      if (suppressClick || drag || pending || collapsed || !enabled || document.fullscreenElement || ctx.isInvalid) return;
      pending = true;
      save.disabled = true;
      save.setAttribute('aria-busy', 'true');
      const url = location.href;
      const page = pageVersion;
      const request = ++captureVersion;
      const isCurrent = () => url === location.href && page === pageVersion && request === captureVersion && !ctx.isInvalid;
      showStatus(t('正在收藏…'));
      try {
        const reply = await browser.runtime.sendMessage({ type: 'capturePage' }) as Reply<{ created: boolean }>;
        if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.error : t('扩展暂不可用，请刷新页面后重试。'));
        if (isCurrent()) {
          showSaved(true);
          showStatus(reply.data.created ? t('已收藏到 WebsiteStars') : t('已在资料库中，划词已保留'));
        }
      } catch (error) {
        if (isCurrent()) showStatus(error instanceof Error ? translateError(error) : t('收藏失败，请重试。'));
      } finally {
        if (isCurrent()) {
          pending = false;
          save.disabled = false;
          save.removeAttribute('aria-busy');
          captureVersion++;
        }
      }
    });
    collapse.addEventListener('click', event => {
      event.preventDefault();
      const restoreFocus = event.detail === 0 || root.activeElement === collapse || root.activeElement === save;
      finishDrag(true);
      place();
      const view = viewport();
      edge = position!.x + buttonSize / 2 < view.left + view.width / 2 ? 'left' : 'right';
      collapsed = true;
      place();
      if (restoreFocus) expand.focus({ preventScroll: true });
    });
    expand.addEventListener('click', event => {
      event.preventDefault();
      const restoreFocus = event.detail === 0 || root.activeElement === expand;
      collapsed = false;
      place();
      if (restoreFocus) (pending ? collapse : save).focus({ preventScroll: true });
    });
    const messageListener = (message: { type?: string; enabled?: boolean }, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id || message.type !== 'floatingPreference' || typeof message.enabled !== 'boolean') return;
      preferenceVersion++;
      enabled = message.enabled;
      renderVisibility();
    };
    const viewportChanged = () => {
      finishDrag(true);
      place();
    };
    browser.runtime.onMessage.addListener(messageListener);
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      clearTimeout(navigationTimer);
      navigationTimer = setTimeout(navigation, 0);
    });
    ctx.addEventListener(window, 'popstate', navigation);
    ctx.addEventListener(window, 'hashchange', navigation);
    ctx.addEventListener(window, 'focus', () => { void readState(); });
    ctx.addEventListener(window, 'resize', viewportChanged);
    if (window.visualViewport) {
      ctx.addEventListener(window.visualViewport, 'resize', viewportChanged);
      ctx.addEventListener(window.visualViewport, 'scroll', viewportChanged);
    }
    ctx.addEventListener(document, 'fullscreenchange', renderVisibility);
    ctx.onInvalidated(() => {
      finishDrag(true);
      host.remove();
      clearTimeout(statusTimer);
      clearTimeout(navigationTimer);
      browser.runtime.onMessage.removeListener(messageListener);
    });
    void readState();
  },
});
