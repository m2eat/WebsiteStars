import { browser } from 'wxt/browser';
import { t, translateError } from '../lib/i18n';
import { z } from 'zod';
import { liveQuery } from 'dexie';
import { ensureContentIndex, scheduleIndexing, rebuildIndexes, getIndexOverview, cancelIndexing } from '../lib/content-index';
import { embedTexts } from '../lib/embeddings';
import { createChatSession, deleteChat, stopChat, checkQueryConnection, cancelAllChats, registerChatPorts } from '../lib/chat-server';
import { listModels } from '../lib/models';
import { captureTab, refreshGithub, saveUrl } from '../lib/capture';
import { db, deleteItem, exportBackup, importBackup, updateItem } from '../lib/library';
import { abortAnalysis, cancelAnalyses, drainQueue, queueAnalysis } from '../lib/analysis';
import { getSettings, saveSettings } from '../lib/settings';
import { normalizeUrl, parseGithubRepo } from '../lib/urls';
import type { Command, Reply } from '../lib/types';

const identifier = z.string().min(1).max(200);
const patchSchema = z.object({ title: z.string().trim().min(1).max(1000).optional(), notes: z.string().max(50000).optional(), summaryOverride: z.string().max(10000).optional(), tagsOverride: z.array(z.string().trim().min(1).max(100)).max(50).optional(), categoryOverride: z.string().max(100).optional() }).strict();

async function handle(command: Command) {
  switch (command.type) {
    case 'getIndexOverview': await ensureContentIndex(); return getIndexOverview();
    case 'rebuildIndexes': await rebuildIndexes(); return;
    case 'testEmbeddingConnection': {
      const settings = await getSettings();
      if (!settings.semanticEnabled) throw new Error(t('请先保存并启用语义检索。'));
      const vectors = await embedTexts(['A developer documentation search query.'], settings);
      return { dimensions: vectors[0]?.length ?? 0 };
    }
    case 'listModels': return listModels(command.connection);
    case 'createChat': return createChatSession();
    case 'deleteChat': return deleteChat(identifier.parse(command.id));
    case 'stopChat': return stopChat(identifier.parse(command.id), command.target);
    case 'testQueryConnection': return checkQueryConnection();
    case 'captureTab': return captureTab(command.tabId === undefined ? undefined : z.number().int().nonnegative().parse(command.tabId));
    case 'saveGithub':
    case 'saveUrl': {
      const result = await saveUrl(z.string().max(4000).parse(command.url), 'title' in command ? z.string().max(1000).optional().parse(command.title) : undefined);
      if (command.type === 'saveUrl' && command.notes && result.created) result.item = await updateItem(result.item.id, { notes: z.string().max(50000).parse(command.notes) });
      return result;
    }
    case 'updateItem': return updateItem(identifier.parse(command.id), patchSchema.parse(command.patch));
    case 'deleteItem': abortAnalysis(command.id); return deleteItem(identifier.parse(command.id));
    case 'refresh': return refreshGithub(identifier.parse(command.id));
    case 'analyze': return queueAnalysis(identifier.parse(command.id));
    case 'getSettings': return getSettings();
    case 'saveSettings': {
      const settings = await saveSettings(command.settings);
      cancelIndexing();
      scheduleIndexing();
      await cancelAllChats(settings.revision);
      await cancelAnalyses();
      const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      await Promise.allSettled(tabs.filter(tab => tab.id !== undefined).map(tab => browser.tabs.sendMessage(tab.id!, { type: 'floatingPreference', enabled: settings.floatingEnabled })));
      return settings;
    }
    case 'exportBackup': return exportBackup();
    case 'importBackup': return importBackup(z.string().max(50_000_000).parse(command.text));
    default: throw new Error(t('不支持的操作。'));
  }
}

export default defineBackground(() => {
  registerChatPorts();
  liveQuery(() => db.items.toArray()).subscribe({ next: () => scheduleIndexing(), error: () => undefined });
  browser.runtime.onMessage.addListener((message: Command, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return;
    const internal = sender.url?.startsWith(browser.runtime.getURL('/'));
    const fromGithub = sender.url?.startsWith('https://github.com/') && message?.type === 'saveGithub' && typeof message.url === 'string' && !!parseGithubRepo(message.url);
    const fromPage = sender.frameId === 0 && sender.tab?.id !== undefined && /^https?:\/\//.test(sender.url ?? '') && ['getPageState', 'capturePage'].includes(message?.type);
    if (!internal && !fromGithub && !fromPage) {
      sendResponse({ ok: false, error: t('此页面无权执行该操作。') });
      return;
    }
    const run = async () => {
      if (message.type === 'capturePage' || message.type === 'getPageState') {
        if (!fromPage) throw new Error(t('请在网页中使用悬浮收藏入口。'));
        if (message.type === 'capturePage') return captureTab(sender.tab!.id);
        const settings = await getSettings();
        const item = await db.items.where('normalizedUrl').equals(normalizeUrl(sender.url!)).first();
        return { floatingEnabled: settings.floatingEnabled, saved: !!item };
      }
      return handle(message);
    };
    run().then(data => sendResponse({ ok: true, data } satisfies Reply<unknown>)).catch(error => sendResponse({ ok: false, error: error instanceof z.ZodError ? t('输入格式无效，请检查后重试。') : error instanceof Error ? translateError(error) : t('操作失败，请重试。') }));
    return true;
  });

  const capture = async (tabId?: number, selection?: string, linkUrl?: string) => {
    try {
      const result = linkUrl ? await saveUrl(linkUrl) : await captureTab(tabId, selection);
      await browser.action.setBadgeBackgroundColor({ color: '#23745b', tabId });
      await browser.action.setBadgeText({ text: '✓', tabId });
      await browser.action.setTitle({ title: result.created ? t('打开 WebsiteStars 侧栏 · 当前页已收藏') : t('打开 WebsiteStars 侧栏 · 当前页已在资料库中'), tabId });
    } catch (error) {
      await browser.action.setBadgeBackgroundColor({ color: '#ad3e35', tabId });
      await browser.action.setBadgeText({ text: '!', tabId });
      await browser.action.setTitle({ title: error instanceof Error ? translateError(error) : t('收藏失败'), tabId });
    }
  };
  browser.action.onClicked.addListener(tab => {
    if (tab.id !== undefined) {
      void browser.sidePanel.open({ tabId: tab.id }).catch(() => browser.tabs.create({ url: browser.runtime.getURL('/library.html') }));
      void browser.action.setBadgeText({ text: '', tabId: tab.id });
      void browser.action.setTitle({ title: t('打开 WebsiteStars 侧栏'), tabId: tab.id });
    }
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'starts-save-link' && info.linkUrl) void capture(tab?.id, undefined, info.linkUrl);
    else void capture(tab?.id, info.selectionText);
  });
  browser.commands.onCommand.addListener(command => {
    if (command === 'open-library') void browser.tabs.create({ url: browser.runtime.getURL('/library.html') });
    if (command === 'save-page') void capture();
  });
  browser.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'starts-analysis') { void drainQueue(); scheduleIndexing(); } });
  const initialize = async () => {
    await browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await browser.alarms.create('starts-analysis', { periodInMinutes: 0.5 });
    void drainQueue();
  };
  browser.runtime.onInstalled.addListener(() => {
    void browser.contextMenus.removeAll().then(() => {
      browser.contextMenus.create({ id: 'starts-save', title: t('收藏到 WebsiteStars'), contexts: ['page', 'selection'], documentUrlPatterns: ['http://*/*', 'https://*/*'] });
      browser.contextMenus.create({ id: 'starts-save-link', title: t('收藏链接到 WebsiteStars'), contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*'] });
    });
    void initialize();
  });
  browser.runtime.onStartup.addListener(() => { void initialize(); });
  void initialize();
});
